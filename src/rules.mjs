import { findBaseline, samplesSince } from './store.mjs';

export const SEVERITY = { CRITICAL: 'critical', WARNING: 'warning', INFO: 'info' };

const percentChange = (current, baseline) => ((current - baseline) / baseline) * 100;

/**
 * Evaluates every alert rule against the latest readings.
 *
 * Pure: no I/O, no clock access, no mutation of its inputs. `now` and the
 * history are passed in so the whole rule set is directly testable.
 *
 * @returns {Array<{id: string, severity: string, title: string, detail: string}>}
 */
export function evaluateRules({ primary, secondary, history, now, thresholds }) {
  const alerts = [];
  const usd = (value) =>
    value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

  // 1. The earliest signal: market makers pulling quotes at the peg.
  const baseline = findBaseline(history.samples, {
    band: primary.band,
    now,
    minutesAgo: 60,
    toleranceMinutes: 15,
  });
  if (baseline) {
    const change = percentChange(primary.depthBuyUsd, baseline.depthBuyUsd);
    if (change <= -thresholds.depthDropPercent) {
      alerts.push({
        id: 'depth_drop_1h',
        severity: SEVERITY.CRITICAL,
        title: `±${primary.band}% depth fell ${Math.abs(change).toFixed(1)}% in an hour`,
        detail: `${usd(baseline.depthBuyUsd)} → ${usd(primary.depthBuyUsd)}. Liquidity is leaving the peg zone.`,
      });
    }
  }

  // 2. Absolute floor: the buffer before redemption arbitrage becomes profitable.
  if (primary.depthBuyUsd < thresholds.depthFloorUsd) {
    alerts.push({
      id: 'depth_floor',
      severity: SEVERITY.WARNING,
      title: `±${primary.band}% depth below floor`,
      detail: `${usd(primary.depthBuyUsd)} vs floor ${usd(thresholds.depthFloorUsd)}.`,
    });
  }

  // 3. Tick occupancy thins out before notional depth visibly does.
  if (primary.ticksInBand !== null && primary.ticksInBand < thresholds.minTicksInBand) {
    alerts.push({
      id: 'ticks_thin',
      severity: SEVERITY.WARNING,
      title: `Only ${primary.ticksInBand} initialised ticks in ±${primary.band}%`,
      detail: `Below ${thresholds.minTicksInBand}. The book at the peg is emptying out.`,
    });
  }

  // 4. Reserve skew: a lean toward DUSD means the pool is being sold into.
  if (primary.skewPercent !== null && primary.skewPercent > thresholds.maxSkewPercent) {
    alerts.push({
      id: 'reserve_skew',
      severity: SEVERITY.WARNING,
      title: `Reserves ${primary.skewPercent.toFixed(1)}% DUSD`,
      detail: `Above ${thresholds.maxSkewPercent}%. Net selling into the pool; USDT side is draining.`,
    });
  }

  // 5. Sustained discount, not a single print — one wick on a micro-pool means nothing.
  const lastHour = samplesSince(history.samples, { band: primary.band, now, minutesAgo: 60 });
  const sustained = lastHour.length >= 6 && lastHour.every((s) => s.dusdPriceUsdt < thresholds.minDusdPrice);
  if (sustained && primary.dusdPriceUsdt < thresholds.minDusdPrice) {
    alerts.push({
      id: 'price_discount_sustained',
      severity: SEVERITY.CRITICAL,
      title: `DUSD under ${thresholds.minDusdPrice} for an hour`,
      detail: `Now ${primary.dusdPriceUsdt.toFixed(5)} USDT across ${lastHour.length} samples. Not a wick.`,
    });
  }

  // 6. Liquidity ran out inside the band: the edge is unreachable at any size.
  for (const sample of [primary, secondary].filter(Boolean)) {
    if (sample.truncated) {
      alerts.push({
        id: `truncated_${sample.band}`,
        severity: SEVERITY.CRITICAL,
        title: `Book exhausted inside ±${sample.band}%`,
        detail: 'Price would gap rather than slide. This is the step-change scenario.',
      });
    }
  }

  // 7. Redemptions: supply shrinking faster than normal decay.
  const weekAgo = history.daily.find(
    (entry) => Date.parse(`${entry.date}T00:00:00Z`) <= now.getTime() - 6.5 * 86_400_000,
  );
  if (weekAgo?.totalSupply) {
    const change = percentChange(primary.totalSupply, weekAgo.totalSupply);
    if (change <= -thresholds.supplyDropPercent7d) {
      alerts.push({
        id: 'supply_drop_7d',
        severity: SEVERITY.WARNING,
        title: `DUSD supply down ${Math.abs(change).toFixed(1)}% in a week`,
        detail: `${Math.round(weekAgo.totalSupply).toLocaleString('en-US')} → ${Math.round(primary.totalSupply).toLocaleString('en-US')} since ${weekAgo.date}.`,
      });
    }
  }

  return alerts;
}

/**
 * Compares the concentrated core against the tail. A shrinking ratio means LPs
 * are widening their ranges, which is what they do ahead of expected volatility.
 */
export function evaluateTail({ primary, tail, history, now, thresholds }) {
  const ratio = tail.depthBuyUsd / primary.depthBuyUsd;
  const yesterday = [...history.daily]
    .reverse()
    .find((entry) => entry.date < now.toISOString().slice(0, 10) && typeof entry.tailRatio === 'number');

  const alerts = [];
  if (yesterday) {
    const change = percentChange(ratio, yesterday.tailRatio);
    if (change <= -thresholds.tailFlatteningPercent) {
      alerts.push({
        id: 'tail_flattening',
        severity: SEVERITY.INFO,
        title: `Tail/core ratio down ${Math.abs(change).toFixed(1)}%`,
        detail: `${yesterday.tailRatio.toFixed(3)} → ${ratio.toFixed(3)}. Liquidity moving out of the concentrated range.`,
      });
    }
  }
  return { ratio, alerts };
}

/** Drops alerts already sent inside the cooldown window, and stamps the ones kept. */
export function applyCooldown(alerts, alertState, now, cooldownMinutes) {
  const cooldownMs = cooldownMinutes * 60_000;
  const kept = [];

  for (const alert of alerts) {
    const lastSent = alertState[alert.id] ? Date.parse(alertState[alert.id]) : null;
    if (lastSent !== null && now.getTime() - lastSent < cooldownMs) continue;
    alertState[alert.id] = now.toISOString();
    kept.push(alert);
  }
  return kept;
}
