const TELEGRAM_API = 'https://api.telegram.org';
const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const escapeHtml = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const SEVERITY_ICON = { critical: '🔴', warning: '🟠', info: '🔵' };

/**
 * Sends one message, retrying on transport errors and honouring Telegram's
 * own retry_after on 429. Never throws: a failed alert must not kill the loop.
 */
export async function sendMessage(telegram, text) {
  if (!telegram) {
    process.stdout.write(`\n[dry-run telegram]\n${text}\n`);
    return true;
  }

  const url = `${TELEGRAM_API}/bot${telegram.botToken}/sendMessage`;
  const body = JSON.stringify({
    chat_id: telegram.chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const payload = await response.json().catch(() => ({}));

      if (response.ok && payload.ok) return true;

      if (response.status === 429) {
        const waitSeconds = payload.parameters?.retry_after ?? 5;
        process.stderr.write(`telegram: rate limited, waiting ${waitSeconds}s\n`);
        await sleep(waitSeconds * 1000);
        continue;
      }

      // 4xx other than 429 means a bad token or chat id — retrying will not help.
      if (response.status >= 400 && response.status < 500) {
        process.stderr.write(`telegram: rejected (${response.status}) ${payload.description ?? ''}\n`);
        return false;
      }

      throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      process.stderr.write(`telegram: attempt ${attempt}/${MAX_ATTEMPTS} failed (${error.message})\n`);
      if (attempt < MAX_ATTEMPTS) await sleep(2000 * attempt);
    }
  }
  return false;
}

export function formatAlerts(alerts, sample) {
  const lines = [`<b>DUSD/USDT pool — ${alerts.length} alert${alerts.length > 1 ? 's' : ''}</b>`, ''];

  for (const alert of alerts) {
    lines.push(`${SEVERITY_ICON[alert.severity] ?? '⚪️'} <b>${escapeHtml(alert.title)}</b>`);
    lines.push(escapeHtml(alert.detail));
    lines.push('');
  }

  lines.push('<i>current state</i>');
  lines.push(`price   ${sample.dusdPriceUsdt.toFixed(5)} USDT per DUSD`);
  lines.push(`depth   $${Math.round(sample.depthBuyUsd).toLocaleString('en-US')} at ±${sample.band}%`);
  if (sample.skewPercent !== null) lines.push(`skew    ${sample.skewPercent.toFixed(1)}% DUSD`);
  lines.push(`supply  ${Math.round(sample.totalSupply).toLocaleString('en-US')} DUSD`);

  return lines.join('\n');
}

export { escapeHtml };
