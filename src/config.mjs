import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

function requireString(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required env var ${name} (see .env.example)`);
  return value;
}

function optionalNumber(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`env var ${name} must be a number in [${min}, ${max}], got "${raw}"`);
  }
  return value;
}

/**
 * Reads and validates configuration once, at process start.
 * Telegram credentials are only required when alerts will actually be sent.
 */
export function loadConfig({ dryRun = false } = {}) {
  const poolAddress = process.env.POOL_ADDRESS?.trim() || null;
  if (poolAddress && !/^0x[0-9a-fA-F]{40}$/.test(poolAddress)) {
    throw new Error(`POOL_ADDRESS is not a valid address: ${poolAddress}`);
  }

  return {
    projectRoot: PROJECT_ROOT,
    scriptPath: resolve(PROJECT_ROOT, 'pool-depth.mjs'),
    historyPath: resolve(PROJECT_ROOT, 'history.json'),

    poolAddress,
    rpcUrl: process.env.RPC_URL?.trim() || null,

    telegram: dryRun
      ? null
      : {
          botToken: requireString('TELEGRAM_BOT_TOKEN'),
          chatId: requireString('TELEGRAM_CHAT_ID'),
        },

    pollIntervalMinutes: optionalNumber('POLL_INTERVAL_MINUTES', 5, { min: 1, max: 1440 }),
    tailCheckHourUtc: optionalNumber('TAIL_CHECK_HOUR_UTC', 3, { min: 0, max: 23 }),
    alertCooldownMinutes: optionalNumber('ALERT_COOLDOWN_MINUTES', 360, { min: 0, max: 10_080 }),

    thresholds: {
      depthDropPercent: optionalNumber('DEPTH_DROP_PERCENT', 20, { min: 1, max: 99 }),
      depthFloorUsd: optionalNumber('DEPTH_FLOOR_USD', 1_500_000, { min: 0 }),
      minTicksInBand: optionalNumber('MIN_TICKS_IN_BAND', 50, { min: 0 }),
      maxSkewPercent: optionalNumber('MAX_SKEW_PERCENT', 60, { min: 50, max: 100 }),
      minDusdPrice: optionalNumber('MIN_DUSD_PRICE', 0.995, { min: 0.5, max: 1 }),
      supplyDropPercent7d: optionalNumber('SUPPLY_DROP_PERCENT_7D', 10, { min: 1, max: 99 }),
      tailFlatteningPercent: optionalNumber('TAIL_FLATTENING_PERCENT', 15, { min: 1, max: 99 }),
    },

    retention: {
      sampleHours: optionalNumber('SAMPLE_RETENTION_HOURS', 8, { min: 2, max: 168 }),
      dailyDays: optionalNumber('DAILY_RETENTION_DAYS', 30, { min: 7, max: 365 }),
    },
  };
}

/** Bands polled on every cycle. 0.5% is the peg-defence zone, 2% the working band. */
export const PRIMARY_BAND = 0.5;
export const SECONDARY_BAND = 2;
/** Polled once a day to watch the tail beyond the concentrated range. */
export const TAIL_BAND = 10;
