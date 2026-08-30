#!/usr/bin/env node
// Measures real concentrated-liquidity depth of a PancakeSwap V3 (Uniswap V3 fork) pool.
//
// Answers one question: how much can you sell into this pool before the price
// moves N% away from parity, using actual tick liquidity rather than a
// constant-product approximation.
//
// Zero dependencies. Node 18+ (needs global fetch and BigInt).
//
//   node pool-depth.mjs
//   node pool-depth.mjs --band 2 --json
//   node pool-depth.mjs --pool 0x... --rpc https://...
//   node pool-depth.mjs --selftest
//
// Only eth_call at the latest block, so any public BSC RPC works.

const DEFAULT_POOL = '0xB67e5EaF770a384Ab28029d08B9bC5EBE32beb0F';

const DEFAULT_RPCS = [
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
  'https://bsc.publicnode.com',
  'https://binance.llamarpc.com',
];

const SELECTOR = {
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
  fee: '0xddca3f43',
  tickSpacing: '0xd0c93a7c',
  liquidity: '0x1a686502',
  slot0: '0x3850c7bd',
  ticks: '0xf30dba93',
  tickBitmap: '0x5339c296',
  decimals: '0x313ce567',
  symbol: '0x95d89b41',
  balanceOf: '0x70a08231',
  totalSupply: '0x18160ddd',
};

const LOG_TICK_BASE = Math.log(1.0001);

// ---------------------------------------------------------------- ABI codec

const pad32 = (hex) => hex.replace(/^0x/, '').padStart(64, '0');

function encodeSignedWord(value) {
  const asBigInt = BigInt(value);
  const twosComplement =
    asBigInt < 0n ? (1n << 256n) + asBigInt : asBigInt;
  return pad32(twosComplement.toString(16));
}

function encodeAddress(address) {
  return pad32(address.toLowerCase().replace(/^0x/, ''));
}

function wordAt(data, index) {
  const body = data.replace(/^0x/, '');
  const start = index * 64;
  const slice = body.slice(start, start + 64);
  if (slice.length < 64) {
    throw new Error(`return data too short: wanted word ${index}, got ${body.length / 64}`);
  }
  return slice;
}

const decodeUint = (data, index) => BigInt('0x' + wordAt(data, index));

function decodeSigned(data, index, bits) {
  const raw = decodeUint(data, index);
  const width = BigInt(bits);
  const truncated = BigInt.asUintN(bits, raw);
  return truncated >> (width - 1n) ? truncated - (1n << width) : truncated;
}

function decodeString(data) {
  const body = data.replace(/^0x/, '');
  // Dynamic string: [offset][length][bytes]. Some tokens return bytes32 instead.
  if (body.length <= 64) return hexToAscii(body);
  const length = Number(BigInt('0x' + body.slice(64, 128)));
  if (!Number.isFinite(length) || length === 0 || length > 128) return hexToAscii(body.slice(0, 64));
  return hexToAscii(body.slice(128, 128 + length * 2));
}

const hexToAscii = (hex) =>
  hex
    .replace(/(00)+$/, '')
    .match(/.{1,2}/g)
    ?.map((byte) => String.fromCharCode(parseInt(byte, 16)))
    .join('')
    .replace(/[^\x20-\x7e]/g, '') ?? '';

// ------------------------------------------------------------------- RPC

class RpcClient {
  #endpoints;
  #active = 0;
  #nextId = 1;

  constructor(endpoints) {
    if (endpoints.length === 0) throw new Error('no RPC endpoints configured');
    this.#endpoints = endpoints;
  }

  get endpoint() {
    return this.#endpoints[this.#active];
  }

  /** Sends one JSON-RPC batch, failing over to the next endpoint on transport errors. */
  async callBatch(calls, { timeoutMs = 15_000 } = {}) {
    const payload = calls.map(({ to, data }) => ({
      jsonrpc: '2.0',
      id: this.#nextId++,
      method: 'eth_call',
      params: [{ to, data }, 'latest'],
    }));

    let lastError;
    for (let attempt = 0; attempt < this.#endpoints.length; attempt += 1) {
      try {
        return await this.#post(payload, timeoutMs);
      } catch (error) {
        lastError = error;
        this.#active = (this.#active + 1) % this.#endpoints.length;
        process.stderr.write(
          `rpc: ${error.message} — failing over to ${this.endpoint}\n`,
        );
      }
    }
    throw new Error(`all RPC endpoints failed: ${lastError?.message}`);
  }

  async #post(payload, timeoutMs) {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const body = await response.json();
    const results = Array.isArray(body) ? body : [body];
    const byId = new Map(results.map((entry) => [entry.id, entry]));

    return payload.map((request) => {
      const entry = byId.get(request.id);
      if (!entry) throw new Error(`missing response for id ${request.id}`);
      if (entry.error) throw new Error(`eth_call reverted: ${entry.error.message}`);
      return entry.result;
    });
  }
}

// ----------------------------------------------------- tick math (pure)

const tickToSqrtPrice = (tick) => Math.pow(1.0001, tick / 2);

const bandToTickDelta = (bandPercent) =>
  Math.ceil(Math.log(1 + bandPercent / 100) / LOG_TICK_BASE);

/**
 * Walks tick ranges outward from the current price and accumulates the token
 * amounts a swap would consume to push the price to each band edge.
 *
 * Pure: takes a plain state object, does no I/O. See runSelfTest().
 *
 * Uniswap V3 convention, raw (undecimalised) units, price = token1/token0:
 *   pushing price up   costs token1:  L * (sqrtB - sqrtA)
 *   pushing price down costs token0:  L * (1/sqrtA - 1/sqrtB)
 */
export function computeDepth({ sqrtPriceCurrent, tickCurrent, liquidity, tickLiquidityNet, tickDelta }) {
  const sqrtUpperLimit = sqrtPriceCurrent * Math.pow(1.0001, tickDelta / 2);
  const sqrtLowerLimit = sqrtPriceCurrent * Math.pow(1.0001, -tickDelta / 2);

  const ascending = [...tickLiquidityNet.keys()]
    .filter((tick) => tick > tickCurrent)
    .sort((a, b) => a - b);
  const descending = [...tickLiquidityNet.keys()]
    .filter((tick) => tick <= tickCurrent)
    .sort((a, b) => b - a);

  let activeLiquidity = liquidity;
  let sqrtPrice = sqrtPriceCurrent;
  let token1In = 0;
  let token0Out = 0;
  let truncatedUp = false;

  for (const tick of [...ascending, Number.POSITIVE_INFINITY]) {
    const sqrtBoundary = Number.isFinite(tick) ? tickToSqrtPrice(tick) : Infinity;
    const sqrtNext = Math.min(sqrtBoundary, sqrtUpperLimit);
    token1In += activeLiquidity * (sqrtNext - sqrtPrice);
    token0Out += activeLiquidity * (1 / sqrtPrice - 1 / sqrtNext);
    sqrtPrice = sqrtNext;
    if (sqrtPrice >= sqrtUpperLimit) break;
    activeLiquidity += tickLiquidityNet.get(tick);
    // The book is empty above here: the band edge is unreachable at any size.
    if (activeLiquidity <= 0) {
      truncatedUp = true;
      break;
    }
  }

  activeLiquidity = liquidity;
  sqrtPrice = sqrtPriceCurrent;
  let token0In = 0;
  let token1Out = 0;
  let truncatedDown = false;

  for (const tick of [...descending, Number.NEGATIVE_INFINITY]) {
    const sqrtBoundary = Number.isFinite(tick) ? tickToSqrtPrice(tick) : 0;
    const sqrtNext = Math.max(sqrtBoundary, sqrtLowerLimit);
    token0In += activeLiquidity * (1 / sqrtNext - 1 / sqrtPrice);
    token1Out += activeLiquidity * (sqrtPrice - sqrtNext);
    sqrtPrice = sqrtNext;
    if (sqrtPrice <= sqrtLowerLimit) break;
    activeLiquidity -= tickLiquidityNet.get(tick);
    if (activeLiquidity <= 0) {
      truncatedDown = true;
      break;
    }
  }

  return { token1In, token0Out, token0In, token1Out, truncatedUp, truncatedDown };
}

// --------------------------------------------------------- pool reading

async function readPoolState(rpc, pool) {
  const [token0, token1, fee, tickSpacing, liquidity, slot0] = await rpc.callBatch([
    { to: pool, data: SELECTOR.token0 },
    { to: pool, data: SELECTOR.token1 },
    { to: pool, data: SELECTOR.fee },
    { to: pool, data: SELECTOR.tickSpacing },
    { to: pool, data: SELECTOR.liquidity },
    { to: pool, data: SELECTOR.slot0 },
  ]);

  const token0Address = '0x' + wordAt(token0, 0).slice(24);
  const token1Address = '0x' + wordAt(token1, 0).slice(24);

  const [dec0, dec1, sym0, sym1, bal0, bal1, supply0, supply1] = await rpc.callBatch([
    { to: token0Address, data: SELECTOR.decimals },
    { to: token1Address, data: SELECTOR.decimals },
    { to: token0Address, data: SELECTOR.symbol },
    { to: token1Address, data: SELECTOR.symbol },
    { to: token0Address, data: SELECTOR.balanceOf + encodeAddress(pool) },
    { to: token1Address, data: SELECTOR.balanceOf + encodeAddress(pool) },
    { to: token0Address, data: SELECTOR.totalSupply },
    { to: token1Address, data: SELECTOR.totalSupply },
  ]);

  return {
    pool,
    fee: Number(decodeUint(fee, 0)),
    tickSpacing: Number(decodeSigned(tickSpacing, 0, 24)),
    liquidity: decodeUint(liquidity, 0),
    sqrtPriceX96: decodeUint(slot0, 0),
    tick: Number(decodeSigned(slot0, 1, 24)),
    token0: {
      address: token0Address,
      decimals: Number(decodeUint(dec0, 0)),
      symbol: decodeString(sym0),
      reserve: decodeUint(bal0, 0),
      totalSupply: decodeUint(supply0, 0),
    },
    token1: {
      address: token1Address,
      decimals: Number(decodeUint(dec1, 0)),
      symbol: decodeString(sym1),
      reserve: decodeUint(bal1, 0),
      totalSupply: decodeUint(supply1, 0),
    },
  };
}

/** Finds initialized ticks in [tickLow, tickHigh] via the pool's tick bitmap. */
async function readInitializedTicks(rpc, state, tickLow, tickHigh) {
  const { tickSpacing } = state;
  const compressedLow = Math.floor(tickLow / tickSpacing);
  const compressedHigh = Math.floor(tickHigh / tickSpacing);
  const wordLow = compressedLow >> 8;
  const wordHigh = compressedHigh >> 8;

  const words = [];
  for (let word = wordLow; word <= wordHigh; word += 1) words.push(word);

  const bitmaps = await rpc.callBatch(
    words.map((word) => ({
      to: state.pool,
      data: SELECTOR.tickBitmap + encodeSignedWord(word),
    })),
  );

  const candidates = [];
  words.forEach((word, index) => {
    const bitmap = decodeUint(bitmaps[index], 0);
    if (bitmap === 0n) return;
    for (let bit = 0; bit < 256; bit += 1) {
      if ((bitmap >> BigInt(bit)) & 1n) {
        const tick = ((word << 8) + bit) * tickSpacing;
        if (tick >= tickLow && tick <= tickHigh) candidates.push(tick);
      }
    }
  });

  const liquidityNet = new Map();
  const chunkSize = 20;
  for (let offset = 0; offset < candidates.length; offset += chunkSize) {
    const chunk = candidates.slice(offset, offset + chunkSize);
    const results = await rpc.callBatch(
      chunk.map((tick) => ({
        to: state.pool,
        data: SELECTOR.ticks + encodeSignedWord(tick),
      })),
    );
    chunk.forEach((tick, index) => {
      liquidityNet.set(tick, Number(decodeSigned(results[index], 1, 128)));
    });
  }

  return liquidityNet;
}

// ----------------------------------------------------------------- report

function analyse(state, liquidityNet, bandPercent) {
  const scale0 = 10 ** state.token0.decimals;
  const scale1 = 10 ** state.token1.decimals;

  const sqrtPriceCurrent = Number(state.sqrtPriceX96) / 2 ** 96;
  // Human price of token0 denominated in token1, decimals accounted for.
  const price = sqrtPriceCurrent ** 2 * (scale0 / scale1);

  const depth = computeDepth({
    sqrtPriceCurrent,
    tickCurrent: state.tick,
    liquidity: Number(state.liquidity),
    tickLiquidityNet: liquidityNet,
    tickDelta: bandToTickDelta(bandPercent),
  });

  const reserve0 = Number(state.token0.reserve) / scale0;
  const reserve1 = Number(state.token1.reserve) / scale1;
  const totalReserveUsd = reserve0 + reserve1; // both legs are ~$1 stables

  // What a constant-product pool of the same size would show, for comparison
  // with aggregators that model CLMM depth as x*y=k.
  const constantProductDepth = (reserve1 * (Math.sqrt(1 + bandPercent / 100) - 1));

  return {
    pool: state.pool,
    feeTier: `${state.fee / 10_000}%`,
    tick: state.tick,
    price,
    band: `${bandPercent}%`,
    depth: {
      buyToken0: depth.token1In / scale1,
      sellToken0: depth.token0In / scale0,
      truncated: depth.truncatedUp || depth.truncatedDown,
    },
    reserves: {
      [state.token0.symbol]: reserve0,
      [state.token1.symbol]: reserve1,
      totalUsd: totalReserveUsd,
      skewPercent: (100 * reserve1) / (reserve0 + reserve1),
    },
    constantProductDepth,
    dusdTotalSupply:
      Number(state.token1.totalSupply) / scale1,
  };
}

function printReport(report, state) {
  const usd = (value) =>
    value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  const s0 = state.token0.symbol;
  const s1 = state.token1.symbol;

  console.log(`\npool          ${report.pool}  (${s0}/${s1}, fee ${report.feeTier})`);
  console.log(`tick          ${report.tick}`);
  console.log(`price         1 ${s0} = ${report.price.toFixed(6)} ${s1}\n`);

  console.log(`--- real tick depth, band ±${report.band} ---`);
  console.log(`  buy  ${s0}: ${usd(report.depth.buyToken0)}  (${s1} you can spend before +${report.band})`);
  console.log(`  sell ${s0}: ${usd(report.depth.sellToken0)}  (${s0} you can dump before -${report.band})`);
  if (report.depth.truncated) {
    console.log('  NOTE: liquidity ran out inside the band — depth is the full one-sided reserve');
  }

  console.log(`\n--- reserves (balanceOf, includes out-of-range + unclaimed fees) ---`);
  console.log(`  ${s0.padEnd(6)} ${report.reserves[s0].toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
  console.log(`  ${s1.padEnd(6)} ${report.reserves[s1].toLocaleString('en-US', { maximumFractionDigits: 0 })}`);
  console.log(`  total  ${usd(report.reserves.totalUsd)}`);
  console.log(`  skew   ${report.reserves.skewPercent.toFixed(1)}% is ${s1}  (50% = balanced)`);

  console.log(`\n--- verdict ---`);
  console.log(`  x*y=k model would report:  ${usd(report.constantProductDepth)}`);
  console.log(`  real tick depth is:        ${usd(report.depth.buyToken0)}`);
  const ratio = report.depth.buyToken0 / report.constantProductDepth;
  console.log(`  concentration factor:      ${ratio.toFixed(1)}x`);
  console.log(
    `\n  ${s1} total supply: ${report.dusdTotalSupply.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
  );
  console.log(
    `  depth as share of supply: ${((100 * report.depth.sellToken0) / report.dusdTotalSupply).toFixed(3)}%\n`,
  );
}

// ---------------------------------------------------------------- selftest

function runSelfTest() {
  // Flat book: constant liquidity, no initialized ticks inside the band.
  // Analytic truth: token1In = L * (sqrtB - sqrtA), token0In = L * (1/sqrtA' - 1/sqrtA).
  const liquidity = 1e21;
  const sqrtPriceCurrent = 1.0;
  const tickDelta = bandToTickDelta(2);

  const result = computeDepth({
    sqrtPriceCurrent,
    tickCurrent: 0,
    liquidity,
    tickLiquidityNet: new Map(),
    tickDelta,
  });

  const sqrtUpper = Math.pow(1.0001, tickDelta / 2);
  const sqrtLower = Math.pow(1.0001, -tickDelta / 2);
  const expectedToken1In = liquidity * (sqrtUpper - sqrtPriceCurrent);
  const expectedToken0In = liquidity * (1 / sqrtLower - 1 / sqrtPriceCurrent);

  const relativeError = (actual, expected) => Math.abs(actual - expected) / expected;
  const checks = [
    ['token1In vs analytic', relativeError(result.token1In, expectedToken1In)],
    ['token0In vs analytic', relativeError(result.token0In, expectedToken0In)],
  ];

  // A wall of liquidity ending at +50 ticks must cap the upward depth.
  const walled = computeDepth({
    sqrtPriceCurrent,
    tickCurrent: 0,
    liquidity,
    tickLiquidityNet: new Map([[50, -liquidity]]),
    tickDelta,
  });
  const cappedExpected = liquidity * (Math.pow(1.0001, 25) - 1);
  checks.push(['walled book caps depth', relativeError(walled.token1In, cappedExpected)]);

  let failed = false;
  for (const [name, error] of checks) {
    const ok = error < 1e-9;
    if (!ok) failed = true;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (rel err ${error.toExponential(2)})`);
  }
  if (!walled.truncatedUp) {
    console.log('FAIL  walled book should report truncatedUp');
    failed = true;
  } else {
    console.log('PASS  walled book reports truncatedUp');
  }
  console.log(`\nband ±2% = ${tickDelta} ticks`);
  return failed ? 1 : 0;
}

// -------------------------------------------------------------------- main

function parseArgs(argv) {
  const args = { pool: DEFAULT_POOL, band: 2, json: false, selftest: false, rpc: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--json') args.json = true;
    else if (flag === '--selftest') args.selftest = true;
    else if (flag === '--pool') args.pool = argv[++i];
    else if (flag === '--rpc') args.rpc = argv[++i];
    else if (flag === '--band') args.band = Number(argv[++i]);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(args.pool)) throw new Error(`bad pool address: ${args.pool}`);
  if (!Number.isFinite(args.band) || args.band <= 0 || args.band >= 50) {
    throw new Error(`band must be between 0 and 50 percent, got ${args.band}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) process.exit(runSelfTest());

  const rpc = new RpcClient(args.rpc ? [args.rpc] : DEFAULT_RPCS);
  const state = await readPoolState(rpc, args.pool);

  const tickDelta = bandToTickDelta(args.band);
  const liquidityNet = await readInitializedTicks(
    rpc,
    state,
    state.tick - tickDelta - state.tickSpacing,
    state.tick + tickDelta + state.tickSpacing,
  );

  const report = analyse(state, liquidityNet, args.band);
  report.initializedTicksInBand = liquidityNet.size;
  report.rpc = rpc.endpoint;
  report.timestamp = new Date().toISOString();

  if (args.json) console.log(JSON.stringify(report, null, 2));
  else printReport(report, state);
}

const isEntrypoint = import.meta.url === `file://${process.argv[1]}`;
if (isEntrypoint) {
  main().catch((error) => {
    process.stderr.write(`error: ${error.message}\n`);
    process.exit(1);
  });
}
