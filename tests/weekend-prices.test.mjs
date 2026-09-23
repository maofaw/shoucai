import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeWeekendSaleHistory,
  buildPortfolioSaleTiming,
  saleScenariosForCandidate,
  chooseByConservativeProfit
} from '../src/weekend-prices.mjs';

test('weekend history requires repeated weekends and returns common low/high prices', () => {
  const rows = [];
  for (const day of ['09-05', '09-06', '09-12', '09-13', '09-19', '09-20']) {
    for (const hour of [10, 14, 18]) rows.push({ time: `${day} ${hour}:00`, avg: hour === 10 ? 100 : hour === 14 ? 120 : 140 });
  }
  const result = analyzeWeekendSaleHistory(rows, { now: new Date('2026-09-23T12:00:00+08:00') });
  assert.equal(result.ready, true);
  assert.equal(result.observedWeeks, 3);
  assert.equal(result.sampleCount, 18);
  assert.equal(result.conservativePrice, 100);
  assert.equal(result.highPrice, 140);
});

test('weekend history finds a reliable two-hour sell window', () => {
  const rows = [];
  for (const [day, isSaturday] of [
    ['09-05', true], ['09-06', false],
    ['09-12', true], ['09-13', false],
    ['09-19', true], ['09-20', false]
  ]) {
    for (const hour of [9, 10, 20, 21]) {
      rows.push({ time: `${day} ${hour}:00`, avg: isSaturday && hour >= 20 ? 150 : 100 });
    }
  }
  const result = analyzeWeekendSaleHistory(rows, {
    now: new Date('2026-09-23T12:00:00+08:00'), windowHours: 2, minStartHour: 9, maxStartHour: 22
  });
  assert.equal(result.ready, true);
  assert.equal(result.saleWindows[0].weekdayLabel, '周六');
  assert.equal(result.saleWindows[0].startHour, 20);
  assert.equal(result.saleWindows[0].endHour, 22);
  assert.equal(result.saleWindows[0].observedWeeks, 3);
});

test('portfolio sell timing requires broad recipe coverage and provides a distinct backup', () => {
  const saleWindows = [
    { key: '6-20', weekday: 6, weekdayLabel: '周六', startHour: 20, endHour: 22, windowHours: 2, ready: true, sampleCount: 8, observedWeeks: 4, score: 1.12 },
    { key: '0-18', weekday: 0, weekdayLabel: '周日', startHour: 18, endHour: 20, windowHours: 2, ready: true, sampleCount: 8, observedWeeks: 4, score: 1.07 }
  ];
  const recommendations = Array.from({ length: 4 }, (_, index) => ({
    selected: {
      name: `配方${index + 1}`,
      revenue: 1000 + index * 100,
      runsPerWeek: 10,
      priceEvidence: { saleWindows }
    }
  }));
  const result = buildPortfolioSaleTiming(recommendations, {
    dashboard: { weekendLookbackWeeks: 4, weekendSellMinimumCoverage: 0.75 }
  });
  assert.equal(result.ready, true);
  assert.equal(result.preferredWindow, '周六 20:00–22:00');
  assert.equal(result.backupWindow, '周日 18:00–20:00');
  assert.equal(result.confidence, '高');
  assert.equal(result.coveredRecipes, 4);
});

test('candidate scenarios use weekend price but keep current material cost', () => {
  const candidate = {
    name: '测试成品', currentCost: 500, revenue: 1000, fee: 100, runsPerWeek: 10,
    recipe: { id: 1, output_count: 10, output_current_price: 100 }
  };
  const scenario = saleScenariosForCandidate(candidate, {
    ready: true, source: 'test', sampleCount: 20, observedWeeks: 4, lookbackWeeks: 4,
    conservativePrice: 90, highPrice: 130, lowerPercentile: 0.25, higherPercentile: 0.75
  });
  assert.equal(scenario.conservativeProfit, 310);
  assert.equal(scenario.highProfit, 670);
  assert.equal(scenario.conservativeWeeklyProfit, 3100);
  assert.equal(scenario.priceEvidence.provisional, false);
});

test('stable preferred recipe is kept unless conservative weekly improvement exceeds threshold', () => {
  const preferred = { recipe: { id: 1 }, conservativeWeeklyProfit: 1000, priceEvidence: {} };
  const close = { recipe: { id: 2 }, conservativeWeeklyProfit: 1040, priceEvidence: {} };
  const clearlyBetter = { recipe: { id: 3 }, conservativeWeeklyProfit: 1060, priceEvidence: {} };
  assert.equal(chooseByConservativeProfit([preferred, close], preferred, 0.05).selected.recipe.id, 1);
  assert.equal(chooseByConservativeProfit([preferred, clearlyBetter], preferred, 0.05).selected.recipe.id, 3);
});
