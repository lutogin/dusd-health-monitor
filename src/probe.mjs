import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_BYTES = 1_000_000;

class ProbeError extends Error {
  constructor(message, { cause, band } = {}) {
    super(message, { cause });
    this.name = 'ProbeError';
    this.band = band;
  }
}

/**
 * Runs pool-depth.mjs as a child process and returns its parsed JSON report.
 *
 * The measurement script stays the single source of truth for on-chain reads;
 * this module only handles process lifecycle and shape validation.
 */
export async function probe(config, band) {
  const args = [config.scriptPath, '--band', String(band), '--json'];
  if (config.poolAddress) args.push('--pool', config.poolAddress);
  if (config.rpcUrl) args.push('--rpc', config.rpcUrl);

  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, args, {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      killSignal: 'SIGKILL',
    }));
  } catch (error) {
    const reason = error.killed ? `timed out after ${PROBE_TIMEOUT_MS} ms` : error.message;
    throw new ProbeError(`pool-depth.mjs failed for band ${band}%: ${reason}`, {
      cause: error,
      band,
    });
  }

  let report;
  try {
    report = JSON.parse(stdout);
  } catch (error) {
    throw new ProbeError(`pool-depth.mjs returned non-JSON output for band ${band}%`, {
      cause: error,
      band,
    });
  }

  return toSample(report, band);
}

const isPositiveNumber = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Flattens a pool-depth report into the compact record we persist. */
export function toSample(report, band) {
  const depthBuy = report?.depth?.buyToken0;
  const depthSell = report?.depth?.sellToken0;
  const price = report?.price;
  const totalSupply = report?.dusdTotalSupply;

  if (![depthBuy, depthSell, price, totalSupply].every(isPositiveNumber)) {
    throw new ProbeError(`pool-depth.mjs returned an implausible report for band ${band}%`, { band });
  }

  return {
    ts: report.timestamp ?? new Date().toISOString(),
    band,
    // buyToken0 = USDT you can spend to push the price up, i.e. depth absorbing DUSD sales.
    depthBuyUsd: depthBuy,
    depthSellUsd: depthSell,
    // report.price is DUSD per USDT; invert for the quote everyone actually reads.
    dusdPriceUsdt: 1 / price,
    skewPercent: report.reserves?.skewPercent ?? null,
    ticksInBand: report.initializedTicksInBand ?? null,
    usdtReserve: report.reserves?.USDT ?? null,
    dusdReserve: report.reserves?.DUSD ?? null,
    totalSupply,
    truncated: Boolean(report.depth?.truncated),
    rpc: report.rpc ?? null,
  };
}

export { ProbeError };
