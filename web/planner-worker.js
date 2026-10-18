import { calculatePlan, migrateSettings, rankCandidates, normalize } from './planner.js';
import { procurement } from './scenarios.js';
import { loadMarketSnapshot } from './snapshot-loader.js';
import { readPersistedMarketSnapshot, persistMarketSnapshot, isUsableMarketSnapshot } from './snapshot-cache.js';
import { homeSnapshot, computationSignature } from './computed-cache.js';

let snapshot = null;
let lastComputation = null;
function sameVersion(a, b) { return a?.builtAt === b?.builtAt && a?.generatedAt === b?.generatedAt; }
async function readSnapshot(context) {
  if (snapshot && (!context.version || sameVersion(snapshot, context.version))) return;
  const cached = await readPersistedMarketSnapshot();
  if (cached && (!context.version || sameVersion(cached.data, context.version))) snapshot = cached.data;
  else {
    const loaded = await loadMarketSnapshot({ signal: AbortSignal.timeout(25_000) });
    if (!isUsableMarketSnapshot(loaded.data)) throw new Error('行情文件不完整');
    snapshot = loaded.data;
    await persistMarketSnapshot(snapshot);
  }
}
function compute(context) {
  const key = snapshot.builtAt + ':' + snapshot.generatedAt + ':' + computationSignature(context);
  if (lastComputation?.key === key) return lastComputation.value;
  const settings = migrateSettings(context.settings, snapshot.defaults);
  const result = calculatePlan(snapshot, settings, context.adoption,
    context.lazy ? { version: 1, items: [] } : context.stocked);
  const demand = new Map();
  if (context.lazy) for (const row of result.plan.recipes) {
    const candidate = rankCandidates(snapshot, settings, row.place, settings.techMode, true).find(item => item.id === row.id);
    for (const item of (candidate ? procurement({ ...candidate, runsPerWeek: 1 }, 7)?.materials : []) ?? []) {
      const key = normalize(item.name), old = demand.get(key) ?? { name: item.name, count: 0, cost: 0 };
      old.count += item.count; old.cost += item.cost; demand.set(key, old);
    }
  }
  const compact = homeSnapshot({ ...snapshot, lazyDemand: [...demand.values()] }, result, settings);
  const value = { settings, result, compact };
  lastComputation = { key, value };
  return value;
}
async function handle(command, context) {
  if (command === 'refresh') {
    if (context.version) {
      const marker = await fetch('./data/version.json?v=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(12_000) });
      if (!marker.ok || marker.headers.get('x-shoucai-offline') === '1') throw new Error('无法联网检查行情');
      const version = await marker.json();
      if (sameVersion(version, context.version)) return { unchanged: true };
      if (Date.parse(version.builtAt) < Date.parse(context.version.builtAt)) throw new Error('服务器返回了较旧数据，保留当前行情');
    }
    const loaded = await loadMarketSnapshot({ signal: AbortSignal.timeout(25_000) });
    if (loaded.offline) throw new Error('当前使用离线缓存');
    if (!isUsableMarketSnapshot(loaded.data)) throw new Error('行情文件不完整');
    if (context.version && Date.parse(loaded.data.builtAt) < Date.parse(context.version.builtAt)) throw new Error('服务器返回了较旧数据，保留当前行情');
    snapshot = loaded.data;
    await persistMarketSnapshot(snapshot);
  } else await readSnapshot(context);
  const computed = compute(context);
  return { ...computed, ...(command === 'hydrate' ? { full: snapshot } : {}) };
}
let queue = Promise.resolve();
self.onmessage = ({ data: { id, command, payload } }) => {
  queue = queue.then(async () => {
    try { self.postMessage({ id, value: await handle(command, payload) }); }
    catch (error) { self.postMessage({ id, error: error.message || '后台计算失败' }); }
  });
};
