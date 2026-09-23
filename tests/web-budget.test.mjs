import test from 'node:test';
import assert from 'node:assert/strict';
import { materialCostForDays, suggestedDaysForBudget } from '../web/budget.js';

const plan = {
  suggestedDays: 30,
  materials: [
    { currentPrice: 100, perAccount7Days: 10, perAccount14Days: 20, perAccount30Days: 40 },
    { currentPrice: 200, perAccount7Days: 5, perAccount14Days: 10, perAccount30Days: 20 },
    { currentPrice: 999, perAccount7Days: 99, perAccount14Days: 99, perAccount30Days: 99, watchOnly: true }
  ]
};

test('client buy budget excludes watch-only materials', () => {
  assert.equal(materialCostForDays(plan, 7), 2000);
  assert.equal(materialCostForDays(plan, 14), 4000);
  assert.equal(materialCostForDays(plan, 30), 8000);
});

test('automatic buy duration follows the custom per-account budget', () => {
  assert.equal(suggestedDaysForBudget(plan, 1), 30);
  assert.equal(suggestedDaysForBudget(plan, 0.5), 14);
  assert.equal(suggestedDaysForBudget(plan, 0.25), 7);
  assert.equal(suggestedDaysForBudget(plan, 0.1), 7);
});

test('automatic buy duration never exceeds the market recommendation', () => {
  assert.equal(suggestedDaysForBudget({ ...plan, suggestedDays: 14 }, 1), 14);
  assert.equal(suggestedDaysForBudget({ ...plan, suggestedDays: 7 }, 1), 7);
});
