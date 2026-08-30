# dusd-monitor

Watches the StandX DUSD/USDT PancakeSwap V3 pool on BSC
(`0xB67e5EaF770a384Ab28029d08B9bC5EBE32beb0F`) and alerts to Telegram when the
liquidity picture changes.

Built on top of `pool-depth.mjs`, which reads real concentrated-liquidity depth
straight from the pool contract via public RPC. The monitor never re-implements
that math — it runs the script as a child process and consumes its JSON.

## Why these signals

Measured 2026-08-30, the pool holds $10.76M with a **77x concentration factor**:
55% of all liquidity down to −10% sits inside the first ±0.5%. Past ±2% the book
thins by a factor of 63.

That makes the risk profile a **step, not a slope**. Price barely moves for the
first $4.3M of selling, then the last 8% of the fall costs $189K. There will be
no gradual warning in the price itself.

So the monitor watches the ±0.5% band — the zone where market makers defend the
peg — and alerts on its **derivative**, not its level. By the time an absolute
floor is breached it is already too late.

## Setup

```bash
npm install
cp .env.example .env      # fill in TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
npm test                  # rule logic, no network
npm run dry               # one cycle, prints the Telegram message instead of sending
npm start                 # daemon
```

Get `TELEGRAM_CHAT_ID` by messaging your bot once, then reading
`https://api.telegram.org/bot<TOKEN>/getUpdates`.

## Commands

| Command | What it does |
|---|---|
| `npm start` | Daemon. Polls every 5 min, tail check daily at 03:00 UTC. |
| `npm run once` | One cycle, then exit. Use this from cron. |
| `npm run tail` | One cycle including the ±10% tail probe. |
| `npm run dry` | One cycle with no Telegram credentials required. |
| `npm test` | Rule and store unit tests. |

Under cron, `--once` is the better shape — the process holds no state between
runs, everything lives in `history.json`:

```
*/5 * * * * cd /Users/nd/projects/my/crypto/dusd-monitor && /usr/local/bin/node src/index.mjs --once >> monitor.log 2>&1
0 3 * * *   cd /Users/nd/projects/my/crypto/dusd-monitor && /usr/local/bin/node src/index.mjs --once --tail >> monitor.log 2>&1
```

## Alert rules

| id | Severity | Trigger | Why it matters |
|---|---|---|---|
| `depth_drop_1h` | 🔴 | ±0.5% depth down >20% vs the sample ~1h ago | Earliest possible signal. MMs pull quotes before price moves. |
| `price_discount_sustained` | 🔴 | DUSD < 0.995 across **every** sample in the last hour (min 6) | A single wick on a $9-liquidity micro-pool means nothing — this needs persistence. |
| `truncated_<band>` | 🔴 | Liquidity runs out inside the band | The band edge is unreachable at any size: price gaps instead of sliding. |
| `depth_floor` | 🟠 | ±0.5% depth < $1.5M | Buffer before redemption arbitrage (at ~0.5% discount) turns profitable has halved. |
| `ticks_thin` | 🟠 | <50 initialised ticks in ±0.5% | 89 today, ~86% occupancy. Thinning shows up here first. |
| `reserve_skew` | 🟠 | Reserves >60% DUSD | 52.2% today. A lean means net selling; USDT is the only real exit. |
| `supply_drop_7d` | 🟠 | totalSupply down >10% in a week | Redemptions. Ran at −44%/month through August. |
| `tail_flattening` | 🔵 | tail/core ratio down >15% day over day | LPs widening ranges is what they do ahead of expected volatility. |
| `probe_failure` | 🟠 | 3 consecutive probe failures | You are blind, which during stress is itself the signal. |

Every rule has a per-id cooldown (default 6h) so a persistent condition does not
spam every five minutes. Thresholds are all overridable in `.env`.

If Telegram delivery fails the cooldown stamp is rolled back, so the alert is
retried on the next cycle rather than lost.

## history.json

Written atomically (temp file + rename). Structure:

```jsonc
{
  "version": 1,
  "samples": [ /* raw readings, 8h rolling — this is what depth_drop_1h compares against */ ],
  "daily":   [ /* one entry per day, 30d — supply trend and tail ratio */ ],
  "alerts":  { "depth_floor": "2026-08-30T18:00:00.000Z" }  // cooldown stamps
}
```

Samples carry `depthBuyUsd`, `depthSellUsd`, `dusdPriceUsdt`, `skewPercent`,
`ticksInBand`, reserves and `totalSupply`. Safe to delete — it rebuilds, you
just lose the baselines until an hour of samples accumulates.

## Baseline, 2026-08-30

| Band | Depth (sell DUSD) | Density per pp |
|---|---|---|
| ±0.5% | $2,465,919 | $4,931,838 |
| ±2% | $4,323,933 | $1,238,676 |
| ±5% | $4,426,498 | $34,188 |
| ±10% | $4,513,144 | $17,329 |

Price 0.99928, skew 52.2% DUSD, 89 ticks in ±0.5%, supply 51,401,070.
USDT reserve $5.15M — the hard ceiling on on-chain exit, ~10% of supply.

## What this does not cover

Depth is a liquidity measure. It says nothing about solvency: reserve fund size,
collateral composition, or whether the 7-day redemption queue is being honoured.
Those are the actual tail risks here, and none of them are on-chain.

## Notes

- Telegram delivery is a plain `fetch` POST. `telegraf` is a bot framework —
  polling, webhooks, middleware — and none of that applies to one-way alerts.
  `dotenv` is the only dependency.
- Requires Node 20+ (global `fetch`, `AbortSignal.timeout`, `node:test`).
- `pool-depth.mjs` has a cosmetic bug in its human-readable output: the
  `depth as share of supply` line divides USDT depth by DUSD supply. The JSON
  path this monitor uses is unaffected.
