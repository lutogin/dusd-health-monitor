import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SEVERITY, applyCooldown, evaluateRules, evaluateTail } from './rules.mjs';
import { findBaseline, pruneHistory, recordDaily } from './store.mjs';
import { toSample } from './probe.mjs';

const NOW = new Date('2026-08-30T18:00:00.000Z');

const thresholds = {
  depthDropPercent: 20,
  depthFloorUsd: 1_500_000,
  minTicksInBand: 50,
  maxSkewPercent: 60,
  minDusdPrice: 0.995,
  supplyDropPercent7d: 10,
  tailFlatteningPercent: 15,
};

/** Mirrors the real 2026-08-30 reading so the healthy case is a real one. */
const healthy = (overrides = {}) => ({
  ts: NOW.toISOString(),
  band: 0.5,
  depthBuyUsd: 2_465_919,
  depthSellUsd: 2_988_346,
  dusdPriceUsdt: 0.999279,
  skewPercent: 52.17,
  ticksInBand: 89,
  usdtReserve: 5_147_498,
  dusdReserve: 5_615_099,
  totalSupply: 51_401_069,
  truncated: false,
  rpc: 'https://bsc.publicnode.com',
  ...overrides,
});

const historyWith = (samples = [], daily = []) => ({ version: 1, samples, daily, alerts: {} });

const minutesBefore = (minutes) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

const ids = (alerts) => alerts.map((a) => a.id).sort();

describe('evaluateRules', () => {
  it('stays silent on the current real-world reading', () => {
    const primary = healthy();
    const alerts = evaluateRules({
      primary,
      secondary: healthy({ band: 2, depthBuyUsd: 4_323_933 }),
      history: historyWith([{ ...primary, ts: minutesBefore(60) }]),
      now: NOW,
      thresholds,
    });
    assert.deepEqual(ids(alerts), []);
  });

  it('fires on a >20% depth drop against the one-hour baseline', () => {
    const baseline = healthy({ ts: minutesBefore(60), depthBuyUsd: 2_465_919 });
    const alerts = evaluateRules({
      primary: healthy({ depthBuyUsd: 1_900_000 }),
      secondary: null,
      history: historyWith([baseline]),
      now: NOW,
      thresholds,
    });
    const drop = alerts.find((a) => a.id === 'depth_drop_1h');
    assert.ok(drop, 'expected depth_drop_1h');
    assert.equal(drop.severity, SEVERITY.CRITICAL);
    assert.match(drop.title, /22\.9%/);
  });

  it('ignores a stale baseline outside the tolerance window', () => {
    const stale = healthy({ ts: minutesBefore(300), depthBuyUsd: 2_465_919 });
    const alerts = evaluateRules({
      primary: healthy({ depthBuyUsd: 1_600_000 }),
      secondary: null,
      history: historyWith([stale]),
      now: NOW,
      thresholds,
    });
    assert.equal(alerts.find((a) => a.id === 'depth_drop_1h'), undefined);
  });

  it('requires a sustained discount, not a single wick', () => {
    const wick = evaluateRules({
      primary: healthy({ dusdPriceUsdt: 0.88 }),
      secondary: null,
      history: historyWith([healthy({ ts: minutesBefore(10) })]),
      now: NOW,
      thresholds,
    });
    assert.equal(wick.find((a) => a.id === 'price_discount_sustained'), undefined);

    const sustainedSamples = Array.from({ length: 8 }, (_, i) =>
      healthy({ ts: minutesBefore(5 * (i + 1)), dusdPriceUsdt: 0.991 }),
    );
    const sustained = evaluateRules({
      primary: healthy({ dusdPriceUsdt: 0.991 }),
      secondary: null,
      history: historyWith(sustainedSamples),
      now: NOW,
      thresholds,
    });
    assert.ok(sustained.find((a) => a.id === 'price_discount_sustained'));
  });

  it('flags thin ticks, skew and an exhausted book', () => {
    const alerts = evaluateRules({
      primary: healthy({ ticksInBand: 12, skewPercent: 71.4, truncated: true }),
      secondary: null,
      history: historyWith(),
      now: NOW,
      thresholds,
    });
    assert.deepEqual(ids(alerts), ['reserve_skew', 'ticks_thin', 'truncated_0.5']);
  });

  it('detects a weekly supply drop', () => {
    const alerts = evaluateRules({
      primary: healthy({ totalSupply: 44_000_000 }),
      secondary: null,
      history: historyWith([], [{ date: '2026-08-22', totalSupply: 51_401_069 }]),
      now: NOW,
      thresholds,
    });
    assert.ok(alerts.find((a) => a.id === 'supply_drop_7d'));
  });
});

describe('evaluateTail', () => {
  it('reports the ratio and warns when the tail flattens', () => {
    const history = historyWith([], [{ date: '2026-08-29', totalSupply: 51_401_069, tailRatio: 1.83 }]);
    const { ratio, alerts } = evaluateTail({
      primary: healthy(),
      tail: healthy({ band: 10, depthBuyUsd: 2_600_000 }),
      history,
      now: NOW,
      thresholds,
    });
    assert.ok(Math.abs(ratio - 1.0544) < 0.001);
    assert.ok(alerts.find((a) => a.id === 'tail_flattening'));
  });
});

describe('applyCooldown', () => {
  it('suppresses a repeat inside the window and stamps what it keeps', () => {
    const state = {};
    const alert = [{ id: 'depth_floor', severity: SEVERITY.WARNING, title: 't', detail: 'd' }];

    assert.equal(applyCooldown([...alert], state, NOW, 360).length, 1);
    assert.equal(state.depth_floor, NOW.toISOString());

    const soon = new Date(NOW.getTime() + 60 * 60_000);
    assert.equal(applyCooldown([...alert], state, soon, 360).length, 0);

    const later = new Date(NOW.getTime() + 400 * 60_000);
    assert.equal(applyCooldown([...alert], state, later, 360).length, 1);
  });
});

describe('store', () => {
  it('picks the closest sample inside the tolerance window', () => {
    const samples = [
      healthy({ ts: minutesBefore(70), depthBuyUsd: 1 }),
      healthy({ ts: minutesBefore(58), depthBuyUsd: 2 }),
      healthy({ ts: minutesBefore(30), depthBuyUsd: 3 }),
      healthy({ band: 2, ts: minutesBefore(60), depthBuyUsd: 99 }),
    ];
    const found = findBaseline(samples, { band: 0.5, now: NOW, minutesAgo: 60, toleranceMinutes: 15 });
    assert.equal(found.depthBuyUsd, 2);
  });

  it('prunes past retention and merges daily entries by date', () => {
    const history = historyWith(
      [healthy({ ts: minutesBefore(10) }), healthy({ ts: minutesBefore(60 * 20) })],
      [{ date: '2026-06-01', totalSupply: 1 }],
    );
    pruneHistory(history, NOW, { sampleHours: 8, dailyDays: 30 });
    assert.equal(history.samples.length, 1);
    assert.equal(history.daily.length, 0);

    recordDaily(history, healthy(), { tailRatio: 1.2 });
    recordDaily(history, healthy({ totalSupply: 50_000_000 }), {});
    assert.equal(history.daily.length, 1);
    assert.equal(history.daily[0].totalSupply, 50_000_000);
    assert.equal(history.daily[0].tailRatio, 1.2);
  });
});

describe('toSample', () => {
  it('inverts the price into USDT per DUSD', () => {
    const sample = toSample(
      {
        timestamp: NOW.toISOString(),
        price: 1.0007215623930712,
        depth: { buyToken0: 2_465_919, sellToken0: 2_988_346, truncated: false },
        reserves: { USDT: 5_147_498, DUSD: 5_615_099, skewPercent: 52.17 },
        initializedTicksInBand: 89,
        dusdTotalSupply: 51_401_069,
        rpc: 'https://bsc.publicnode.com',
      },
      0.5,
    );
    assert.ok(Math.abs(sample.dusdPriceUsdt - 0.9992789) < 1e-6);
    assert.equal(sample.ticksInBand, 89);
  });

  it('rejects an implausible report rather than storing zeroes', () => {
    assert.throws(
      () => toSample({ price: 0, depth: { buyToken0: 0, sellToken0: 0 }, dusdTotalSupply: 0 }, 0.5),
      /implausible/,
    );
  });
});
