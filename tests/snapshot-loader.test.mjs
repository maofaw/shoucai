import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { loadMarketSnapshot } from '../web/snapshot-loader.js';

test('compressed market snapshot is preferred and decoded', async () => {
  const snapshot = { generatedAt: '2026-09-27T00:00:00Z', candidatePools: { workbench: [] } };
  const calls = [];
  const result = await loadMarketSnapshot({ cacheBust: 'test', fetchImpl: async url => {
    calls.push(url);
    return new Response(gzipSync(JSON.stringify(snapshot)), { status: 200, headers: { 'content-type': 'application/gzip' } });
  } });
  assert.deepEqual(result.data, snapshot);
  assert.equal(result.compressed, true);
  assert.deepEqual(calls, ['./data/latest.json.gz?v=test']);
});

test('plain json remains a fallback when gzip is unavailable', async () => {
  const snapshot = { generatedAt: '2026-09-27T00:00:00Z' };
  const calls = [];
  const result = await loadMarketSnapshot({ cacheBust: 'fallback', fetchImpl: async url => {
    calls.push(url);
    if (url.includes('.gz')) return new Response('', { status: 404 });
    return new Response(JSON.stringify(snapshot), { status: 200, headers: { 'content-type': 'application/json', 'x-shoucai-offline': '1' } });
  } });
  assert.deepEqual(result.data, snapshot);
  assert.equal(result.compressed, false);
  assert.equal(result.offline, true);
  assert.deepEqual(calls, ['./data/latest.json.gz?v=fallback', './data/latest.json?v=fallback']);
});
