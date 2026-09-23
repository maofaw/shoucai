import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWeeklyBuyAdvice, materialNamesForSelectedRecipes } from '../src/buy-window.mjs';

const NOW = new Date('2026-09-23T12:00:00+08:00');

function recommendations(aPrice = 70, bPrice = 140) {
  return [
    {
      place: 'workbench',
      selected: {
        name: '弹药', hours: 8,
        recipe: { id: 1, materials: [{ display_name: '材料A', required_count: 2, current_price: aPrice }] }
      }
    },
    {
      place: 'tech',
      selected: {
        name: '技术品', hours: 16,
        recipe: { id: 2, materials: [{ display_name: '材料B', required_count: 1, current_price: bPrice }] }
      }
    }
  ];
}

function threeWeekHistory({ weeks = 3, currentWeek = false } = {}) {
  const a = [];
  const b = [];
  const firstDay = new Date('2026-08-31T00:00:00+08:00');
  const hours = (weeks + (currentWeek ? 1 : 0)) * 7 * 24;
  for (let offset = 0; offset < hours; offset += 1) {
    const date = new Date(firstDay.getTime() + offset * 3_600_000);
    const local = new Date(date.getTime() + 8 * 3_600_000);
    const weekday = local.getUTCDay();
    const hour = local.getUTCHours();
    const label = `${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')} ${String(hour).padStart(2, '0')}:00`;
    const inCurrentWeek = offset >= 3 * 7 * 24;
    const multiplier = inCurrentWeek ? 0.4
      : weekday === 2 && hour >= 2 && hour < 4 ? 0.7
        : weekday === 6 && hour < 2 ? 0.8
          : 1;
    a.push({ time: label, avg: 100 * multiplier });
    b.push({ time: label, avg: 200 * multiplier });
  }
  return { 材料A: a, 材料B: b };
}

test('weights four-station basket by planned weekly runs and finds repeated weekly low-price windows', () => {
  const plan = buildWeeklyBuyAdvice({
    recommendations: recommendations(),
    historiesByMaterial: threeWeekHistory(),
    now: NOW
  });
  assert.equal(plan.status, 'ready');
  assert.equal(plan.primaryWindow.label, '周二 02:00–04:00');
  assert.equal(plan.backupWindow.label, '周六 00:00–02:00');
  assert.match(plan.primaryWindow.reason, /最近3周/);
  assert.match(plan.backupWindow.reason, /错过首选/);
  assert.equal(plan.primaryWindow.typicalCostPerAccount7Days, 3710);
  assert.equal(plan.currentBasketCostPerAccount7Days, 3710);
  assert.equal(plan.evidence.weekCount, 3);
  assert.deepEqual(materialNamesForSelectedRecipes(recommendations()), ['材料A', '材料B']);
  assert.equal(plan.materials[0].perAccount7Days, 36);
  assert.equal(plan.materials[0].perAccount14Days, 70);
  assert.equal(plan.materials[1].perAccount7Days, 9);
});

test('weekly windows stay fixed despite current-week price changes, while buy signal changes', () => {
  const histories = threeWeekHistory({ currentWeek: true });
  const monday = buildWeeklyBuyAdvice({
    recommendations: recommendations(100, 200),
    historiesByMaterial: histories,
    now: new Date('2026-09-21T08:00:00+08:00')
  });
  const thursday = buildWeeklyBuyAdvice({
    recommendations: recommendations(60, 120),
    historiesByMaterial: histories,
    now: new Date('2026-09-24T08:00:00+08:00')
  });
  assert.equal(monday.weekKey, thursday.weekKey);
  assert.deepEqual(monday.primaryWindow, thursday.primaryWindow);
  assert.deepEqual(monday.backupWindow, thursday.backupWindow);
  assert.notEqual(monday.nowAction, thursday.nowAction);
  assert.equal(thursday.suggestedDays, 14);
});

test('returns no invented preferred time when three full weeks are unavailable', () => {
  const plan = buildWeeklyBuyAdvice({
    recommendations: recommendations(),
    historiesByMaterial: threeWeekHistory({ weeks: 2 }),
    now: NOW
  });
  assert.equal(plan.status, 'insufficient');
  assert.equal(plan.primaryWindow, null);
  assert.equal(plan.backupWindow, null);
  assert.equal(plan.windowMessage, '本周没有可靠的首选时段，达到好价就买');
});

test('budget caps a two-week recommendation at one week, and item advice supports partial buying', () => {
  const capped = buildWeeklyBuyAdvice({
    recommendations: recommendations(),
    historiesByMaterial: threeWeekHistory(),
    now: NOW,
    budgetPerAccount: 5000
  });
  assert.equal(capped.nowAction, 'buy');
  assert.equal(capped.suggestedDays, 7);
  assert.equal(capped.estimatedPerAccountCost, 3780);

  const short = buildWeeklyBuyAdvice({
    recommendations: recommendations(),
    historiesByMaterial: threeWeekHistory(),
    now: NOW,
    budgetPerAccount: 1000
  });
  assert.equal(short.nowAction, 'budget-shortfall');
  assert.equal(short.suggestedDays, 0);
  assert.equal(short.budgetGapPerAccount, 2780);

  const partial = buildWeeklyBuyAdvice({
    recommendations: recommendations(70, 300),
    historiesByMaterial: threeWeekHistory(),
    now: NOW
  });
  assert.equal(partial.materials.find(item => item.name === '材料A').action, 'buy');
  assert.equal(partial.materials.find(item => item.name === '材料B').action, 'wait');
  assert.equal(partial.materials.find(item => item.name === '材料A').targetPrice, 100);
});

test('same-week prior plan is reused only for the same recipe signature', () => {
  const base = buildWeeklyBuyAdvice({
    recommendations: recommendations(),
    historiesByMaterial: threeWeekHistory(),
    now: NOW
  });
  const previousPlan = { ...base, primaryWindow: { ...base.primaryWindow, label: '保持原时段' } };
  const reused = buildWeeklyBuyAdvice({
    recommendations: recommendations(),
    historiesByMaterial: {},
    now: NOW,
    previousPlan
  });
  assert.equal(reused.primaryWindow.label, '保持原时段');

  const changed = recommendations();
  changed[0].selected.recipe.id = 99;
  const recomputed = buildWeeklyBuyAdvice({
    recommendations: changed,
    historiesByMaterial: threeWeekHistory(),
    now: NOW,
    previousPlan
  });
  assert.equal(recomputed.primaryWindow.label, '周二 02:00–04:00');
  assert.notEqual(recomputed.recipeSignature, base.recipeSignature);
});

test('an exceptional 30-day low suggests one month and exposes month quantities', () => {
  const histories = threeWeekHistory({ currentWeek: true });
  const plan = buildWeeklyBuyAdvice({
    recommendations: recommendations(35, 70),
    historiesByMaterial: histories,
    now: new Date('2026-09-24T08:00:00+08:00'),
    budgetPerAccount: 20_000
  });
  assert.equal(plan.nowAction, 'buy');
  assert.equal(plan.suggestedDays, 30);
  assert.equal(plan.estimatedPerAccountCost, plan.purchaseCostPerAccount30Days);
  assert.equal(plan.materials.find(item => item.name === '材料A').perAccount30Days, 150);
});
