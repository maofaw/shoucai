import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecommendations, chooseRecipe, historyStats, percentile, stockEstimate } from '../src/recommend.mjs';

function recipe(overrides) {
  return {
    id: 1,
    place: 'pharmacy',
    period_hours: 8,
    output_display_name: '精密护甲维修包',
    estimated_material_cost: 157461,
    estimated_revenue: 212990,
    estimated_fee: 27689,
    estimated_profit: 27840,
    missing_price_count: 0,
    materials: [],
    ...overrides
  };
}

test('preferred recipe uses historical stock cost', () => {
  const rules = {
    place: 'pharmacy',
    allowedHours: [8],
    preferredNames: ['精密护甲维修包'],
    historicalStock: { enabled: true, materialCostPerRun: 100000 }
  };
  const other = recipe({
    id: 2,
    output_display_name: 'M2肌肉注射剂',
    estimated_material_cost: 11529,
    estimated_revenue: 56418,
    estimated_fee: 7334,
    estimated_profit: 37555
  });
  const result = chooseRecipe([recipe({}), other], rules, 0.1);
  assert.equal(result.selected.name, '精密护甲维修包');
  assert.equal(result.selected.effectiveProfit, 85301);
});

test('switches when challenger is at least 10 percent better', () => {
  const rules = {
    place: 'pharmacy',
    allowedHours: [8],
    preferredNames: ['精密护甲维修包']
  };
  const preferred = recipe({ estimated_profit: 30000 });
  const challenger = recipe({ id: 2, output_display_name: '挑战配方', estimated_profit: 34000 });
  const result = chooseRecipe([preferred, challenger], rules, 0.1);
  assert.equal(result.selected.name, '挑战配方');
});

test('switches away from a preferred recipe that becomes unprofitable', () => {
  const rules = {
    place: 'pharmacy',
    allowedHours: [8],
    preferredNames: ['精密护甲维修包']
  };
  const preferred = recipe({ estimated_profit: -29057 });
  const challenger = recipe({ id: 2, output_display_name: '感知强化剂', estimated_profit: 35328 });
  const result = chooseRecipe([preferred, challenger], rules, 0.1);
  assert.equal(result.selected.name, '感知强化剂');
  assert.match(result.reason, /亏损/);
});

test('buildRecommendations separates stocked and cash-buy pharmacy plans', () => {
  const snapshot = {
    recipes: [
      recipe({ estimated_material_cost: 192556, estimated_profit: -29057 }),
      recipe({ id: 2, output_display_name: '感知强化剂', estimated_material_cost: 13609, estimated_profit: 35328 })
    ]
  };
  const config = {
    switchThreshold: 0.1,
    history: { minimumSamples: 20, minimumSpanHours: 96 },
    manualBuyThresholds: {},
    placeRules: {
      pharmacy: {
        label: '制药台', allowedHours: [8], preferredNames: ['精密护甲维修包'],
        historicalStock: { enabled: true, materialCostPerRun: 100000 }
      }
    }
  };
  const [result] = buildRecommendations(snapshot, config);
  assert.equal(result.selected.name, '精密护甲维修包');
  assert.equal(result.cashSelected.name, '感知强化剂');
});

test('historyStats and percentile are deterministic', () => {
  assert.equal(percentile([10, 20, 30, 40], 0.5), 25);
  const stats = historyStats([
    { fetched_at_ms: 0, material_cost: 10 },
    { fetched_at_ms: 3_600_000, material_cost: 20 },
    { fetched_at_ms: 7_200_000, material_cost: 30 }
  ]);
  assert.equal(stats.count, 3);
  assert.equal(stats.spanHours, 2);
  assert.equal(stats.median, 20);
});

test('stockEstimate rounds partial cycles per account upward', () => {
  const selected = {
    hours: 16,
    currentCost: 50000,
    recipe: { materials: [{ display_name: '材料A', required_count: 2 }] }
  };
  const result = stockEstimate(selected, 1, 28);
  assert.equal(result.runsPerAccount, 2);
  assert.equal(result.totalCost, 2_800_000);
  assert.equal(result.materials[0].allAccounts, 112);
});
