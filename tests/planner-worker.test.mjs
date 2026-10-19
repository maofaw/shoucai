import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlannerEngine } from '../web/planner-worker.js';
const snapshot = { schemaVersion: 5, generatedAt: '2026-10-19T00:00:00Z', builtAt: '2026-10-19T00:01:00Z',
  defaults: { placeRules: {} }, candidatePools: { workbench: [], tech: [], pharmacy: [], armory: [] }, materialHistories: {} };
test('worker retains a newer snapshot when a delayed older context requests calculation', async () => {
  let loads = 0;
  const engine = createPlannerEngine({ readCache: async () => ({ data: snapshot }), persist: async () => true,
    loadSnapshot: async () => { loads++; return { data: snapshot }; } });
  const first = await engine.handle('hydrate', { version: snapshot });
  const next = await engine.handle('calculate', { version: { generatedAt: '2026-10-18T00:00:00Z', builtAt: '2026-10-18T00:01:00Z' } });
  assert.equal(next.compact.builtAt, first.compact.builtAt);
  assert.equal(loads, 0);
});
test('worker rejects newly built files containing older source prices and partial deployments', async () => {
  let loaded = false;
  const engine = createPlannerEngine({ readCache: async () => ({ data: snapshot }),
    fetchImpl: async () => ({ ok: true, headers: new Headers(), json: async () => ({ generatedAt: '2026-10-18T00:00:00Z', builtAt: '2026-10-19T01:00:00Z' }) }),
    loadSnapshot: async () => { loaded = true; return { data: snapshot }; } });
  await assert.rejects(engine.handle('refresh', { version: snapshot }), /较旧/);
  assert.equal(loaded, false);
});
