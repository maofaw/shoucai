import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptsComputation, applyRemoteTimes, readAdminKey } from '../web/app-state.js';
const version = { builtAt: '2026-10-19T00:00:00Z', generatedAt: '2026-10-18T23:59:00Z' };
test('malformed administrator links do not crash application startup', () => {
  assert.equal(readAdminKey('#manage=%'), '');
  assert.equal(readAdminKey('#manage=valid%20key'), 'valid key');
});
test('late computations cannot overwrite newer settings or newer source history', () => {
  const request = { settings: { accounts: 28 }, version };
  assert.equal(acceptsComputation(request, request, { compact: version }), true);
  assert.equal(acceptsComputation(request, { ...request, settings: { accounts: 32 } }, { compact: version }), false);
  assert.equal(acceptsComputation(request, request, { compact: { ...version, generatedAt: '2026-10-17T00:00:00Z' } }), false);
});
test('slow cloud reads preserve local edits, missing fields and invalid timestamps', () => {
  const key = 'shoucai.lastHarvestFinishedAt', sell = 'shoucai.lastSellFinishedAt';
  const map = new Map([[key, '2026-10-18T00:00:00Z'], [sell, '2026-10-17T00:00:00Z']]);
  const storage = { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) };
  const before = Object.fromEntries([key, sell].map(k => [k, storage.getItem(k)]));
  storage.setItem(key, '2026-10-19T00:00:00Z');
  applyRemoteTimes(storage, { state: { lastHarvestFinishedAt: { value: null }, lastSellFinishedAt: { value: 'invalid' } } }, before);
  assert.equal(storage.getItem(key), '2026-10-19T00:00:00Z');
  assert.equal(storage.getItem(sell), before[sell]);
  applyRemoteTimes(storage, { state: {} }, { [key]: storage.getItem(key) });
  assert.equal(storage.getItem(key), '2026-10-19T00:00:00Z');
});
