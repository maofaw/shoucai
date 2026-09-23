import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeWeekendSaleHistory,
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
