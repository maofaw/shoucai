import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBuyNotificationPayload } from '../src/buy-notification.mjs';
import { formatBuyAlert, selectDueNotifications } from '../worker/src/index.js';

test('notification payload includes only materials that reached at least the 7-day tier', () => {
  const dashboard = {
    generatedAt: '2026-09-23T12:00:00.000Z',
    defaults: { accounts: 28 },
    buyPlan: { materials: [
      { name: '特种钢', action: 'buy', tierDays: 14, currentPrice: 100, targetPrice: 130,
        tierThresholds: { days7: 130, days14: 110, days30: 90 }, perAccount7Days: 54,
        perAccount14Days: 105, perAccount30Days: 225, ignored: false, watchOnly: true },
      { name: '便宜稳定材料', action: 'ignored', tierDays: 0, currentPrice: 1, perAccount7Days: 10, ignored: true },
      { name: '昂贵材料', action: 'wait', tierDays: 0, currentPrice: 200, perAccount7Days: 10, ignored: false }
    ] }
  };
  const result = buildBuyNotificationPayload(dashboard);
  assert.equal(result.materials.length, 1);
  assert.equal(result.materials[0].name, '特种钢');
  assert.equal(result.materials[0].tierDays, 14);
  assert.equal(result.materials[0].perAccountCount, 105);
  assert.equal(result.materials[0].totalCount, 2940);
});

test('cooldown suppresses repeats for 24 hours but tier upgrades break through', () => {
  const now = new Date('2026-09-23T12:00:00.000Z');
  const rows = [
    { material_key: '特种钢', tier_days: 7, notified_at: '2026-09-23T06:00:00.000Z' },
    { material_key: '芳纶纤维', tier_days: 14, notified_at: '2026-09-23T06:00:00.000Z' },
    { material_key: '火药', tier_days: 7, notified_at: '2026-09-22T10:00:00.000Z' }
  ];
  const materials = [
    { key: '特种钢', tierDays: 14 },
    { key: '芳纶纤维', tierDays: 14 },
    { key: '火药', tierDays: 7 }
  ];
  assert.deepEqual(selectDueNotifications(materials, rows, now).map(item => item.key), ['特种钢', '火药']);
});

test('Feishu alert states tier and per-account and all-account quantities', () => {
  const message = formatBuyAlert({
    accounts: 28,
    dashboardUrl: 'https://maofaw.github.io/shoucai/?view=buy',
    materials: [{
      name: '盒装挂耳咖啡', tierDays: 7, exchangeFor: '高级燃料', currentPrice: 300000,
      perAccountCount: 9, totalCount: 252, totalCost: 75_600_000
    }]
  });
  assert.match(message, /7天档/);
  assert.match(message, /单号9个/);
  assert.match(message, /全部账号252个/);
  assert.match(message, /用于兑换高级燃料/);
});
