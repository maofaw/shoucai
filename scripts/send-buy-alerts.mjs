import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBuyNotificationPayload } from '../src/buy-notification.mjs';

const notifyUrl = String(process.env.SHOUCAI_NOTIFY_URL ?? '').trim().replace(/\/$/, '');
const notifyKey = String(process.env.SHOUCAI_NOTIFY_KEY ?? '').trim();
if (!notifyUrl || !notifyKey) {
  console.log('Buy notifications are not configured; skipping.');
  process.exit(0);
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dashboard = JSON.parse(fs.readFileSync(path.join(projectRoot, 'web', 'data', 'latest.json'), 'utf8'));
const payload = buildBuyNotificationPayload(dashboard, {
  dashboardUrl: process.env.SHOUCAI_DASHBOARD_URL || 'https://maofaw.github.io/shoucai/?view=buy'
});
if (!payload.materials.length) {
  console.log('No materials reached the 7-day stocking threshold.');
  process.exit(0);
}

const response = await fetch(`${notifyUrl}/notify/buy`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${notifyKey}`,
    'content-type': 'application/json'
  },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(20_000)
});
const result = await response.json().catch(() => ({}));
if (!response.ok) throw new Error(`Buy notification service returned HTTP ${response.status}`);
console.log(`Buy notification result: ${result.sent ?? 0} sent, ${result.cooldown ?? 0} cooling down.`);
