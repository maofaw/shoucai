import { calculatePlan, migrateSettings, rankCandidates, normalize } from './planner.js';
import { procurement } from './scenarios.js';
import { loadMarketSnapshot } from './snapshot-loader.js';
import { readPersistedMarketSnapshot, persistMarketSnapshot, isUsableMarketSnapshot,
  isSameMarketVersion, isOlderMarketVersion } from './snapshot-cache.js';
import { homeSnapshot, computationSignature } from './computed-cache.js';

export function createPlannerEngine({ loadSnapshot = loadMarketSnapshot, readCache = readPersistedMarketSnapshot,
  persist = persistMarketSnapshot, fetchImpl = fetch } = {}) {
let snapshot = null;
let lastComputation = null;
async function readSnapshot(context) {
  if (snapshot && (!context.version || !isOlderMarketVersion(snapshot, context.version))) return;
  const cached = await readCache();
  if (isUsableMarketSnapshot(cached?.data) && (!context.version || !isOlderMarketVersion(cached.data, context.version))) snapshot = cached.data;
  else {
    const loaded = await loadSnapshot({ signal: AbortSignal.timeout(25_000) });
    if (!isUsableMarketSnapshot(loaded.data)) throw new Error('行情文件不完整');
    if (isOlderMarketVersion(loaded.data, context.version) || (snapshot && isOlderMarketVersion(loaded.data, snapshot))) {
      throw new Error('服务器返回了较旧数据，保留当前行情');
    }
    snapshot = loaded.data;
    await persist(snapshot);
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
  if (!['refresh', 'hydrate', 'calculate'].includes(command)) throw new Error('不支持的后台操作');
  if (command === 'refresh') {
    let version;
    if (context.version) {
      const marker = await fetchImpl('./data/version.json?v=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(12_000) });
      if (!marker.ok || marker.headers.get('x-shoucai-offline') === '1') throw new Error('无法联网检查行情');
      version = await marker.json();
      if (!Number.isFinite(Date.parse(version.generatedAt)) || !Number.isFinite(Date.parse(version.builtAt ?? version.generatedAt))) throw new Error('行情版本文件不完整');
      if (isOlderMarketVersion(version, context.version) || (snapshot && isOlderMarketVersion(version, snapshot))) throw new Error('服务器返回了较旧数据，保留当前行情');
      if (isSameMarketVersion(version, context.version)) return { unchanged: true };
    }
    const loaded = await loadSnapshot({ signal: AbortSignal.timeout(25_000) });
    if (loaded.offline) throw new Error('当前使用离线缓存');
    if (!isUsableMarketSnapshot(loaded.data)) throw new Error('行情文件不完整');
    if (isOlderMarketVersion(loaded.data, context.version) || (snapshot && isOlderMarketVersion(loaded.data, snapshot))) throw new Error('服务器返回了较旧数据，保留当前行情');
    if (version && isOlderMarketVersion(loaded.data, version)) throw new Error('新行情尚未部署完成，请稍后重试');
    snapshot = loaded.data;
    await persist(snapshot);
  } else await readSnapshot(context);
  const computed = compute(context);
  return { ...computed, ...(command === 'hydrate' ? { full: snapshot } : {}) };
}
return { handle };
}
const engine = createPlannerEngine();
let queue = Promise.resolve();
if (typeof self !== 'undefined') self.onmessage = ({ data: { id, command, payload } }) => {
  queue = queue.then(async () => {
    try { self.postMessage({ id, value: await engine.handle(command, payload ?? {}) }); }
    catch (error) { self.postMessage({ id, error: error.message || '后台计算失败' }); }
  }).catch(() => {});
};
