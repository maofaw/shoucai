import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/myh74/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const server = spawn(process.execPath, ['scripts/serve-web.mjs'], { env: { ...process.env, PORT: '4178' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); server.once('exit', code => reject(new Error(`server exited ${code}`))); });
const browser = await chromium.launch({ headless: true, channel: 'chrome' }).catch(error => { server.kill(); throw error; });
fs.mkdirSync('reports', { recursive: true });
const results = [];
const prefix = process.env.UI_AUDIT_PREFIX || 'ui-audit';
try {
  for (const viewport of [{ width: 375, height: 812 }, { width: 812, height: 375 }, { width: 1440, height: 900 }]) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block', reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:4178');
    await page.waitForFunction(() => document.querySelector('#profitLow').textContent !== '--');
    for (const view of ['home', 'plans', 'buy', 'sell', 'settings']) {
      await page.locator(`[data-target=${view}]`).click();
      await page.waitForFunction(() => document.querySelector('#detailLoading').hidden);
      await page.waitForFunction(() => document.body.dataset.calculating !== 'true');
      if (view === 'settings') await page.locator('#settingsForm details').evaluateAll(nodes => nodes.forEach(node => node.open = true));
      const issue = await page.evaluate(() => {
        const visible = element => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
        const nodes = [...document.body.querySelectorAll('*')].filter(visible);
        const label = node => `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}.${String(node.className?.baseVal ?? node.className ?? '').replace(/\s+/g, '.')}: ${node.textContent.slice(0,70)}`;
        return {
          pageOverflow: document.documentElement.scrollWidth > innerWidth,
          overflow: nodes.filter(node => { const r = node.getBoundingClientRect(); return r.right > innerWidth + 1 || r.left < -1; }).slice(0,12).map(label),
          clippedText: nodes.filter(node => ['STRONG','B','P','SPAN','H1','H2'].includes(node.tagName) && node.scrollWidth > node.clientWidth + 1 && node.clientWidth > 0).slice(0,12).map(label),
          smallControls: nodes.filter(node => node.matches('button,summary,input:not([type=checkbox]):not([type=hidden]),select') && (node.getBoundingClientRect().height < 44 || node.getBoundingClientRect().width < 44)).map(label),
        };
      });
      results.push({ viewport, view, ...issue });
      if (viewport.width === 375) await page.screenshot({ path: `reports/${prefix}-${view}.png`, fullPage: true });
    }
    await page.locator('[data-target=plans]').click();
    await page.locator('[data-plan-type=currentBest]').click();
    await page.locator('[data-preview-plan=currentBest]').click();
    await page.screenshot({ path: `reports/${prefix}-dialog-${viewport.width}.png`, fullPage: true });
    const dialog = await page.locator('#planPreviewDialog').boundingBox();
    results.push({viewport, view:'dialog', dialog});
    await page.locator('#cancelPlanPreview').click();
    if (viewport.width === 375) {
      await page.locator('[data-target=home]').click();
      for (const view of ['home', 'plans', 'buy', 'settings']) {
        await page.locator(`[data-target=${view}]`).click();
        await page.waitForFunction(() => document.querySelector('#detailLoading').hidden);
        await page.evaluate(() => {
          for (const node of document.body.querySelectorAll('*')) {
            if (!node.dataset.auditFontSize) node.dataset.auditFontSize = String(parseFloat(getComputedStyle(node).fontSize));
          }
          for (const node of document.body.querySelectorAll('*')) node.style.fontSize = `${Number(node.dataset.auditFontSize) * 2}px`;
        });
        const overflow = await page.evaluate(() => [...document.body.querySelectorAll('*')].filter(node => {const r=node.getBoundingClientRect(); return r.width && r.height && (r.right > innerWidth+1 || r.left < -1);}).slice(0,10).map(node=>`${node.tagName}#${node.id}.${String(node.className).replace(/\s+/g,'.')}: ${node.textContent.slice(0,50)}`));
        results.push({viewport, view:`${view}-text200`, overflow});
        await page.screenshot({ path: `reports/${prefix}-${view}-text200.png`, fullPage: true });
      }
    }
    await context.close();
  }
  console.log(JSON.stringify(results,null,2));
  fs.writeFileSync(`reports/${prefix}-results.json`, JSON.stringify(results, null, 2));
} finally { await browser.close(); server.kill(); }
