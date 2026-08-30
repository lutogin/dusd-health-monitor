import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const SCHEMA_VERSION = 1;

const emptyHistory = () => ({
  version: SCHEMA_VERSION,
  samples: [],
  daily: [],
  alerts: {},
});

/** Reads history.json, tolerating a missing or corrupt file by starting fresh. */
export async function loadHistory(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyHistory();
    throw error;
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed?.version !== SCHEMA_VERSION) {
      process.stderr.write(`history: unknown schema version ${parsed?.version}, starting fresh\n`);
      return emptyHistory();
    }
    return {
      version: SCHEMA_VERSION,
      samples: Array.isArray(parsed.samples) ? parsed.samples : [],
      daily: Array.isArray(parsed.daily) ? parsed.daily : [],
      alerts: parsed.alerts && typeof parsed.alerts === 'object' ? parsed.alerts : {},
    };
  } catch (error) {
    process.stderr.write(`history: unreadable (${error.message}), starting fresh\n`);
    return emptyHistory();
  }
}

/** Writes via a temp file + rename so a crash mid-write cannot truncate history. */
export async function saveHistory(path, history) {
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
  await rename(tmpPath, path);
  return dirname(path);
}

export function appendSample(history, sample) {
  history.samples.push(sample);
  return history;
}

export function pruneHistory(history, now, retention) {
  const sampleCutoff = now.getTime() - retention.sampleHours * 3_600_000;
  history.samples = history.samples.filter((sample) => Date.parse(sample.ts) >= sampleCutoff);

  const dailyCutoff = now.getTime() - retention.dailyDays * 86_400_000;
  history.daily = history.daily.filter((entry) => Date.parse(`${entry.date}T00:00:00Z`) >= dailyCutoff);

  return history;
}

/**
 * Finds the sample of the given band closest to `minutesAgo`, but only inside a
 * tolerance window — a stale sample from an outage must not look like an hour-old
 * baseline and trigger a false drop alert.
 */
export function findBaseline(samples, { band, now, minutesAgo, toleranceMinutes }) {
  const target = now.getTime() - minutesAgo * 60_000;
  const tolerance = toleranceMinutes * 60_000;

  let best = null;
  let bestDistance = Infinity;
  for (const sample of samples) {
    if (sample.band !== band) continue;
    const distance = Math.abs(Date.parse(sample.ts) - target);
    if (distance <= tolerance && distance < bestDistance) {
      best = sample;
      bestDistance = distance;
    }
  }
  return best;
}

export function samplesSince(samples, { band, now, minutesAgo }) {
  const cutoff = now.getTime() - minutesAgo * 60_000;
  return samples.filter((sample) => sample.band === band && Date.parse(sample.ts) >= cutoff);
}

export function recordDaily(history, sample, extra = {}) {
  const date = sample.ts.slice(0, 10);
  const existing = history.daily.find((entry) => entry.date === date);
  const merged = { date, totalSupply: sample.totalSupply, ...extra };
  if (existing) Object.assign(existing, merged);
  else history.daily.push(merged);
  history.daily.sort((a, b) => a.date.localeCompare(b.date));
  return history;
}

export { SCHEMA_VERSION, emptyHistory };
