import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeNativeProfit } from '../src/native-profit.mjs';

test('native profit uses Moligod profit values and exposes samples for local percentiles', () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    time: `09-${String(1 + Math.floor(index / 2)).padStart(2, '0')} ${index % 2 ? '20' : '08'}:00`,
    profit: 100 + index * 10,
    revenue: 500 + index * 10,
    cost: 400
  }));
  const result = analyzeNativeProfit({ id: 7 }, { crafting: { recipes: [{ recipe_id: 7, charts: { profit: { ranges: { '15d': rows } } } }] } });
  assert.equal(result.sampleCount, 30);
  assert.equal(result.profitSamples.length, 30);
  assert.equal(result.minProfit, 100);
  assert.equal(result.maxProfit, 390);
  assert.ok(result.conservativeProfit > 100 && result.conservativeProfit < result.highProfit);
});

test('native profit marks missing history provisional instead of inventing data', () => {
  const result = analyzeNativeProfit({ id: 8 }, { crafting: { recipes: [] } });
  assert.equal(result.sampleCount, 0);
  assert.equal(result.conservativeProfit, null);
  assert.equal(result.provisional, true);
});
