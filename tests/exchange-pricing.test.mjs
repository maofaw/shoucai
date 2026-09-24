import test from 'node:test';
import assert from 'node:assert/strict';
import { applyExchangePricing, latestHistoryPrice } from '../src/exchange-pricing.mjs';

const RULE = {
  target: '高级燃料', exchangeOnly: true, outputCount: 4,
  sources: [{ name: '盒装挂耳咖啡', count: 1 }, { name: '海盗弯刀', count: 1 }]
};

test('latestHistoryPrice uses the newest usable market row', () => {
  assert.equal(latestHistoryPrice([{ last: 10 }, { last: 12 }]), 12);
  assert.equal(latestHistoryPrice([{ last: null, avg: 9 }]), 9);
});

test('exchange-only material annotates its source bundle without double-repricing Moligod profit', () => {
  const snapshot = { recipes: [{
    id: 1, estimated_revenue: 1000, estimated_fee: 100,
    materials: [{ display_name: '高级燃料', required_count: 2, current_price: 120 }]
  }] };
  const priced = applyExchangePricing(snapshot, [RULE], {
    盒装挂耳咖啡: [{ last: 300 }], 海盗弯刀: [{ last: 100 }]
  });
  const recipe = priced.recipes[0];
  assert.equal(recipe.materials[0].current_price, 120);
  assert.equal(recipe.materials[0].acquisition.exchangeUnitPrice, 100);
  assert.equal(recipe.materials[0].acquisition.mode, 'exchange');
  assert.equal(recipe.estimated_material_cost, undefined);
  assert.equal(recipe.estimated_profit, undefined);
});

test('exchange-only material never treats the Moligod exchange price as a direct-buy option', () => {
  const snapshot = { recipes: [{
    id: 1, estimated_revenue: 1000, estimated_fee: 100,
    materials: [{ display_name: '高级燃料', required_count: 2, current_price: 90 }]
  }] };
  const priced = applyExchangePricing(snapshot, [RULE], {
    盒装挂耳咖啡: [{ last: 300 }], 海盗弯刀: [{ last: 100 }]
  });
  const material = priced.recipes[0].materials[0];
  assert.equal(material.current_price, 90);
  assert.equal(material.acquisition.exchangeUnitPrice, 100);
  assert.equal(material.acquisition.mode, 'exchange');
  assert.equal(material.acquisition.directUnitPrice, null);
  assert.equal(material.acquisition.moligodUnitPrice, 90);
  assert.match(material.acquisition.note, /Moligod显示价为折算后的单个兑换成本/);
});

test('exchange-only material falls back to the Moligod exchange price when source history is unavailable', () => {
  const snapshot = { recipes: [{
    id: 1, estimated_revenue: 1000, estimated_fee: 100,
    materials: [{ display_name: '高级燃料', required_count: 2, current_price: 90 }]
  }] };
  const priced = applyExchangePricing(snapshot, [RULE], {});
  assert.equal(priced.recipes[0].materials[0].current_price, 90);
  assert.equal(priced.recipes[0].materials[0].acquisition.mode, 'exchange');
});
