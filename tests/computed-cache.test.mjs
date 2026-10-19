import test from 'node:test';
import assert from 'node:assert/strict';
import { readComputedResult, writeComputedResult, homeSnapshot } from '../web/computed-cache.js';
import { createPlannerClient } from '../web/planner-client.js';

test('computed result restores only matching settings/adoption/stock/mode; stale data remains inspectable', () => {
  const map = new Map(), storage = { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value) };
  const context = { settings: { accounts: 28, sharedAccounts: 10, userShare: 80 }, adoption: { id: 1 }, stocked: { items: [] }, lazy: false };
  const places = ['workbench', 'tech', 'pharmacy', 'armory'];
  const data = { computedVersion: 2, generatedAt: '2026-09-01T00:00:00Z', defaults: { placeRules: {} },
    settings: { accounts: 28, sharedAccounts: 10, userShare: 80, rate: 52, stations: Object.fromEntries(places.map(place => [place, {}])) },
    plan: { profit: { conservativeWeeklyPerAccount: 123, highWeeklyPerAccount: 150 }, recipes: places.map(place => ({ place })), issues: [] },
    proposal: { recipes: [], changes: [] }, sell: {}, buyPlan: { materials: [] } };
  assert.equal(writeComputedResult(storage, context, data), true);
  assert.deepEqual(readComputedResult(storage, context), data);
  for (const change of [{ settings: { accounts: 32 } }, { adoption: { id: 2 } }, { stocked: { items: [1] } }, { lazy: true }]) {
    assert.equal(readComputedResult(storage, { ...context, ...change }), null);
  }
  assert.equal(readComputedResult({ getItem: () => '{broken' }, context), null);
  assert.equal(writeComputedResult(storage, context, { ...data, proposal: null }), false);
});
test('home cache omits full histories and stability evidence while retaining all profit periods and sell advice', () => {
  const compact = homeSnapshot({ generatedAt: '2026-10-19T00:00:00Z', materialHistories: ['huge'] }, {
    plan: { profit: { conservativeDailyPerAccount: 1, conservativeWeeklyPerAccount: 7, conservativeMonthlyPerAccount: 30 },
      stabilityEvidence: ['huge'], materialOpportunities: ['huge'] }, sell: { preferredWindow: '周六20:00' }
  }, { accounts: 0 });
  assert.equal(compact.materialHistories, undefined); assert.equal(compact.plan.stabilityEvidence, undefined);
  assert.equal(compact.plan.profit.conservativeMonthlyPerAccount, 30);
  assert.equal(compact.sell.preferredWindow, '周六20:00');
});
test('worker client lazily starts, matches out-of-order responses and reports failures', async () => {
  let count = 0; const messages = [];
  const worker = { postMessage: value => messages.push(value), terminate() {} };
  const client = createPlannerClient(() => { count++; return worker; });
  assert.equal(count, 0);
  const a = client.request('calculate'), b = client.request('hydrate');
  assert.equal(count, 1);
  worker.onmessage({ data: { id: messages[1].id, value: 'full' } });
  worker.onmessage({ data: { id: messages[0].id, value: 'profit' } });
  assert.deepEqual(await Promise.all([a, b]), ['profit', 'full']);
  const failed = client.request('refresh');
  worker.onmessage({ data: { id: messages[2].id, error: '断网' } });
  await assert.rejects(failed, /断网/);
});
