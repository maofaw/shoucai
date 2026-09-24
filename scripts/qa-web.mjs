// Run with PLAYWRIGHT_MODULE pointing to an installed Playwright package.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const server = spawn(process.execPath, ['scripts/serve-web.mjs'], { env: { ...process.env, PORT: '4175' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); server.once('exit', code => reject(new Error(`server exited ${code}`))); });
const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome' }).catch(error => { server.kill(); throw error; });
const errors = [];
fs.mkdirSync('reports', { recursive: true });
try {
  const context = await browser.newContext({ viewport: { width: 375, height: 812 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const ready = async () => { await page.waitForFunction(() => document.querySelector('#conservativeWeekly').textContent !== '--'); };
  const view = async name => { await page.locator(`[data-target="${name}"]`).click(); };
  await page.goto('http://127.0.0.1:4175'); await ready();
  assert.equal(await page.locator('.recipe-card').count(), 4);
  await page.screenshot({ path: 'reports/qa-home.png', fullPage: true });
  await page.evaluate(() => localStorage.setItem('shoucai.lastHarvestFinishedAt', '2026-09-01T00:00:00.000Z'));
  await page.locator('#finishHarvest').click(); await page.locator('#finishHarvest').click();
  await page.reload(); await ready();
  await page.locator('#toastAction').click();
  assert.equal(await page.evaluate(() => localStorage.getItem('shoucai.lastHarvestFinishedAt')), '2026-09-01T00:00:00.000Z');
  await page.locator('#editHarvest').click();
  await page.locator('#harvestFinishedAt').fill('2026-09-01T08:05');
  await page.locator('#harvestEditForm button[type=submit]').click();
  assert.match(await page.locator('#lastHarvest').textContent(), /08:05/);
  await view('settings');
  await page.locator('#settingsForm details').evaluateAll(nodes => nodes.forEach(node => node.open = true));
  await page.locator('#conservativePercentile').fill('');
  await page.locator('#conservativePercentile').evaluate(input => { input.closest('details').open = false; });
  await page.locator('#settingsForm button[type=submit]').click();
  assert.equal(await page.locator('#conservativePercentile').isVisible(), true);
  assert.match(await page.locator('#settingsError').textContent(), /不能为空/);
  await page.locator('#conservativePercentile').fill('25');
  await page.locator('#techMode').selectOption('short');
  await page.locator('[data-station=workbench] [data-runs]').fill('14');
  await page.locator('#historyDays').selectOption('1');
  await page.locator('#settingsForm button[type=submit]').click();
  assert.match(await page.locator('#settingsStatus').textContent(), /已保存/);
  assert.equal(await page.locator('#settingsError').isVisible(), false);
  await view('home');
  assert.match(await page.locator('.recipe-card').nth(1).textContent(), /[4-8](\.5)?小时\/轮/);
  assert.match(await page.locator('.recipe-card').first().textContent(), /最近1天/);
  assert.match(await page.locator('.recipe-card').first().textContent(), /每周14轮/);
  await view('settings');
  await page.locator('#accounts').fill('32');
  await page.locator('[data-reset-group=buy]').click();
  assert.equal(await page.locator('#accounts').inputValue(), '32');
  await page.locator('#buy7').fill('5'); await page.locator('#buy14').fill('30');
  await page.locator('#settingsForm button[type=submit]').click();
  assert.match(await page.locator('#settingsError').textContent(), /囤货越久/);
  await page.locator('#buy7').fill('30'); await page.locator('#buy14').fill('15');
  await page.locator('#userShare').fill('0');
  await page.locator('#settingsForm button[type=submit]').click();
  await page.reload(); await ready();
  assert.equal(await page.locator('#userShare').inputValue(), '0');
  for (const size of [{ width: 375, height: 812 }, { width: 812, height: 375 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(size);
    for (const name of ['home', 'buy', 'sell', 'settings']) {
      await view(name);
      if (name === 'settings') await page.locator('#settingsForm details').evaluateAll(nodes => nodes.forEach(node => node.open = true));
      const layout = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));
      assert.ok(layout.scroll <= layout.width, `${size.width}px ${name}: overflow ${JSON.stringify(layout)}`);
      if (size.width === 375 && ['buy', 'settings'].includes(name)) await page.screenshot({ path: `reports/qa-${name}.png`, fullPage: true, animations: 'disabled' });
    }
  }
  assert.deepEqual(errors, []);
  await context.close();
  // Verify the real service worker can load modules and deep links offline.
  const offline = await browser.newContext();
  const offlinePage = await offline.newPage();
  await offlinePage.goto('http://127.0.0.1:4175');
  await offlinePage.waitForFunction(() => navigator.serviceWorker.controller);
  await offline.setOffline(true);
  await offlinePage.goto('http://127.0.0.1:4175/?view=buy&offline-test=1');
  await offlinePage.waitForFunction(() => document.querySelector('#conservativeWeekly').textContent !== '--');
  assert.equal(await offlinePage.locator('[data-view=buy]').isVisible(), true);
  await offline.close();
  console.log('PASS: mobile/landscape/desktop, settings, native-history evidence, persistent harvest undo, material UI, offline deep links.');
} finally { await browser.close(); server.kill(); }
