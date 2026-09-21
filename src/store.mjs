import { randomUUID } from 'node:crypto';
import { open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const SCHEMA_VERSION = 1;
const LOCK_RETRY_MS = 100;
const LOCK_TIMEOUT_MS = 10 * 60_000;
const INCOMPLETE_LOCK_GRACE_MS = 30_000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

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

/**
 * Writes via a per-invocation temp file + rename so a crash mid-write cannot
 * truncate history and concurrent writers cannot consume one another's temp file.
 */
export async function saveHistory(path, history) {
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
    await rename(tmpPath, path);
    return dirname(path);
  } finally {
    await unlink(tmpPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    // EPERM still means the process exists; unknown errors should not let us
    // steal a lock from a potentially live owner.
    return true;
  }
}

async function removeAbandonedLock(lockPath) {
  let raw;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }

  let owner;
  try {
    owner = JSON.parse(raw);
  } catch {
    // A new owner may have created the file but not written its metadata yet.
    const lockStat = await stat(lockPath).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!lockStat || Date.now() - lockStat.mtimeMs < INCOMPLETE_LOCK_GRACE_MS) return false;
  }

  if (Number.isInteger(owner?.pid) && processIsAlive(owner.pid)) return false;

  // Re-read before unlinking so a newly acquired lock is not removed after we
  // inspected an abandoned one.
  const current = await readFile(lockPath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (current !== raw) return false;

  await unlink(lockPath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  return true;
}

/**
 * Serializes the complete history read/modify/write transaction across monitor
 * processes. This also keeps alert cooldown checks and Telegram delivery from
 * being duplicated when cron, a daemon, or a manual run overlap.
 */
export async function withHistoryLock(
  path,
  operation,
  { retryMs = LOCK_RETRY_MS, timeoutMs = LOCK_TIMEOUT_MS } = {},
) {
  const lockPath = `${path}.lock`;
  const token = randomUUID();
  const owner = `${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`;
  const waitStartedAt = Date.now();

  while (true) {
    let handle;
    try {
      handle = await open(lockPath, 'wx');
      await handle.writeFile(owner, 'utf8');
      await handle.close();
      break;
    } catch (error) {
      const createdLock = Boolean(handle);
      await handle?.close().catch(() => {});
      if (createdLock) {
        await unlink(lockPath).catch((unlinkError) => {
          if (unlinkError.code !== 'ENOENT') throw unlinkError;
        });
      }
      if (error.code !== 'EEXIST') throw error;

      if (await removeAbandonedLock(lockPath)) continue;
      if (Date.now() - waitStartedAt >= timeoutMs) {
        throw new Error(`timed out waiting for history lock ${lockPath}`);
      }
      await sleep(retryMs);
    }
  }

  try {
    return await operation();
  } finally {
    const current = await readFile(lockPath, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (current === owner) {
      await unlink(lockPath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
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
