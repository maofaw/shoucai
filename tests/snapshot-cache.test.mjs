import test from 'node:test';
import assert from 'node:assert/strict';
import { isUsableMarketSnapshot, persistMarketSnapshot, readPersistedMarketSnapshot } from '../web/snapshot-cache.js';

const valid = {
  generatedAt: '2026-09-27T00:00:00Z', builtAt: '2026-09-27T00:00:00Z',
  defaults: { placeRules: {} },
  candidatePools: { workbench: [], tech: [], pharmacy: [], armory: [] }
};

test('market cache rejects incomplete data and gracefully skips unavailable IndexedDB', async () => {
  assert.equal(isUsableMarketSnapshot(valid), true);
  assert.equal(isUsableMarketSnapshot({ generatedAt: valid.generatedAt }), false);
  assert.equal(await readPersistedMarketSnapshot({ indexedDBImpl: null }), null);
  assert.equal(await persistMarketSnapshot(valid, { indexedDBImpl: null }), false);
});
