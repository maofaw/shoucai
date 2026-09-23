import test from 'node:test';
import assert from 'node:assert/strict';
import { recipeMetrics, weeklyRunsFor } from '../src/recommend.mjs';
import { buildDashboardData } from '../src/web-data.mjs';

test('weekly run rules reflect conservative collection cadence', () => {
  assert.equal(weeklyRunsFor({ weeklyRuns: 18 }, 7), 18);
  assert.equal(weeklyRunsFor({ weeklyRunsByHours: { 16: 9, 24: 6 } }, 16), 9);
  assert.equal(weeklyRunsFor({ weeklyRunsByHours: { 16: 9, 24: 6 } }, 24), 6);
});

test('recipe weekly profit uses configured weekly runs', () => {
  const metrics = recipeMetrics({
    place: 'workbench', period_hours: 7, output_display_name: '测试配方',
    estimated_material_cost: 100, estimated_revenue: 220, estimated_fee: 20,
    estimated_profit: 100, missing_price_count: 0
  }, { place: 'workbench', weeklyRuns: 18 });
  assert.equal(metrics.weeklyProfit, 1800);
  assert.equal(metrics.runsPerWeek, 18);
});

test('dashboard keeps stocked total unavailable until a buy signal is recorded', () => {
  const selected = {
    name: '测试配方', hours: 8, weeklyProfit: 1800, runsPerWeek: 18,
    currentCost: 100, revenue: 220, fee: 20,
    recipe: { id: 1, materials: [] }
  };
  const data = buildDashboardData({
    snapshot: { recipes: [{}] },
    metadata: { fetchedAtMs: Date.parse('2026-09-22T10:00:00Z') },
    recommendations: [{
      place: 'workbench', label: '工作台', selected, cashSelected: selected,
      candidates: [selected], reason: '测试', buy: { action: 'wait', reason: '等待' }
    }],
    buyTiming: null,
    config: { accounts: 28, dashboard: { defaultAccounts: 28, defaultHaffPerCnyWan: 52, staleAfterHours: 4 } },
    generatedAt: new Date('2026-09-22T10:00:00Z')
  });
  assert.equal(data.plan.profit.stockedWeeklyPerAccount, null);
  assert.equal(data.plan.profit.stockedDailyPerAccount, null);
  assert.equal(data.plan.profit.conservativeMonthlyPerAccount, 7794);
  assert.equal(data.plan.profit.noStockWeeklyPerAccount, 1800);
  assert.equal(data.plan.profit.noStockDailyPerAccount, 257);
  assert.equal(data.defaults.haffPerCnyWan, 52);
  assert.equal(data.sell.ready, false);
  assert.equal(data.sell.preferredWindow, '周六 21:30');
});
