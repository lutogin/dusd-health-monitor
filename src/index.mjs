import { PRIMARY_BAND, SECONDARY_BAND, TAIL_BAND, loadConfig } from './config.mjs';
import { ProbeError, probe } from './probe.mjs';
import {
  appendSample,
  loadHistory,
  pruneHistory,
  recordDaily,
  saveHistory,
  withHistoryLock,
} from './store.mjs';
import { SEVERITY, applyCooldown, evaluateRules, evaluateTail } from './rules.mjs';
import { formatAlerts, sendMessage } from './telegram.mjs';

const CONSECUTIVE_FAILURES_BEFORE_ALERT = 3;

const log = (message) => process.stdout.write(`${new Date().toISOString()}  ${message}\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Runs one full measurement cycle. Returns the alerts that were dispatched. */
async function runCycle(config, { includeTail }) {
  return withHistoryLock(config.historyPath, () => runCycleLocked(config, { includeTail }));
}

async function runCycleLocked(config, { includeTail }) {
  const now = new Date();
  const history = await loadHistory(config.historyPath);

  // Sequential on purpose: same public RPC, no reason to fan out.
  const primary = await probe(config, PRIMARY_BAND);
  const secondary = await probe(config, SECONDARY_BAND);

  appendSample(history, primary);
  appendSample(history, secondary);

  const alerts = evaluateRules({
    primary,
    secondary,
    history,
    now,
    thresholds: config.thresholds,
  });

  let dailyExtra = {};
  if (includeTail) {
    const tail = await probe(config, TAIL_BAND);
    const { ratio, alerts: tailAlerts } = evaluateTail({
      primary,
      tail,
      history,
      now,
      thresholds: config.thresholds,
    });
    alerts.push(...tailAlerts);
    dailyExtra = {
      tailRatio: ratio,
      tailDepthUsd: tail.depthBuyUsd,
      coreDepthUsd: primary.depthBuyUsd,
    };
    log(
      `tail: ±${TAIL_BAND}% depth $${Math.round(tail.depthBuyUsd).toLocaleString('en-US')}, ratio ${ratio.toFixed(3)}`,
    );
  }

  recordDaily(history, primary, dailyExtra);

  const dispatched = applyCooldown(alerts, history.alerts, now, config.alertCooldownMinutes);
  const suppressed = alerts.length - dispatched.length;

  log(
    `price ${primary.dusdPriceUsdt.toFixed(5)}  ` +
      `depth±${PRIMARY_BAND}% $${Math.round(primary.depthBuyUsd).toLocaleString('en-US')}  ` +
      `depth±${SECONDARY_BAND}% $${Math.round(secondary.depthBuyUsd).toLocaleString('en-US')}  ` +
      `skew ${primary.skewPercent?.toFixed(1)}%  ` +
      `ticks ${primary.ticksInBand}  ` +
      `alerts ${dispatched.length}${suppressed ? ` (+${suppressed} on cooldown)` : ''}`,
  );

  if (dispatched.length > 0) {
    for (const alert of dispatched) log(`  ${alert.severity.toUpperCase()}: ${alert.title}`);
    const delivered = await sendMessage(config.telegram, formatAlerts(dispatched, primary));
    if (!delivered) {
      // Un-stamp so the alert is retried next cycle rather than silently lost.
      for (const alert of dispatched) delete history.alerts[alert.id];
      log('telegram delivery failed — alerts will be retried next cycle');
    }
  }

  pruneHistory(history, now, config.retention);
  await saveHistory(config.historyPath, history);

  return dispatched;
}

async function reportProbeFailure(config, error, consecutiveFailures) {
  log(`probe failed (${consecutiveFailures} in a row): ${error.message}`);
  if (consecutiveFailures !== CONSECUTIVE_FAILURES_BEFORE_ALERT) return;

  await withHistoryLock(config.historyPath, async () => {
    const history = await loadHistory(config.historyPath);
    const now = new Date();
    const dispatched = applyCooldown(
      [
        {
          id: 'probe_failure',
          severity: SEVERITY.WARNING,
          title: 'Pool monitor is blind',
          detail: `${consecutiveFailures} consecutive probe failures. Last error: ${error.message}`,
        },
      ],
      history.alerts,
      now,
      config.alertCooldownMinutes,
    );

    if (dispatched.length > 0) {
      await sendMessage(config.telegram, `🟠 <b>${dispatched[0].title}</b>\n${dispatched[0].detail}`);
      await saveHistory(config.historyPath, history);
    }
  });
}

function parseArgs(argv) {
  return {
    once: argv.includes('--once'),
    tail: argv.includes('--tail'),
    dryRun: argv.includes('--dry-run'),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig({ dryRun: args.dryRun });

  log(
    `dusd-monitor started — pool ${config.poolAddress ?? 'default'}, ` +
      `every ${config.pollIntervalMinutes} min, tail check at ${config.tailCheckHourUtc}:00 UTC` +
      (args.dryRun ? ', DRY RUN' : ''),
  );

  if (args.once) {
    await runCycle(config, { includeTail: args.tail });
    return;
  }

  let consecutiveFailures = 0;
  let lastTailDate = null;
  let stopping = false;

  const stop = (signal) => {
    log(`received ${signal}, finishing current cycle then exiting`);
    stopping = true;
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  while (!stopping) {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const includeTail = now.getUTCHours() === config.tailCheckHourUtc && lastTailDate !== today;

    try {
      await runCycle(config, { includeTail });
      if (includeTail) lastTailDate = today;
      consecutiveFailures = 0;
    } catch (error) {
      if (!(error instanceof ProbeError)) throw error;
      consecutiveFailures += 1;
      await reportProbeFailure(config, error, consecutiveFailures);
    }

    if (stopping) break;

    // Align to the next interval boundary so samples land on a predictable grid,
    // which is what findBaseline's tolerance window assumes.
    const periodMs = config.pollIntervalMinutes * 60_000;
    await sleep(periodMs - (Date.now() % periodMs));
  }

  log('stopped');
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error.message}\n${error.stack ?? ''}\n`);
  process.exit(1);
});
