export const MARKET_CHECK_MS = 5 * 60_000;

// Scheduling is injected by the UI; this state machine is also used in tests.
export function createMarketRefresher({ load, onData, onStatus = () => {}, now = Date.now, interval = MARKET_CHECK_MS }) {
  const status = { lastAttempt: null, lastSuccess: null, checking: false, error: null };
  let pending = null, data = null;
  const publish = () => onStatus({ ...status });
  async function perform() {
    status.lastAttempt = now(); status.checking = true; publish();
    try {
      const result = await load();
      const incoming = result.data;
      if (!incoming?.candidatePools || !incoming?.defaults?.placeRules || !Number.isFinite(Date.parse(incoming.generatedAt))
        || !Number.isFinite(Date.parse(incoming.builtAt ?? incoming.generatedAt))
        || !['workbench','tech','pharmacy','armory'].every(place=>Array.isArray(incoming.candidatePools[place]))) throw new Error('行情文件不完整');
      if (result.offline) {
        if (!data) { await onData(incoming); data = incoming; }
        throw new Error('当前使用离线缓存');
      }
      if (data && Date.parse(incoming.builtAt ?? incoming.generatedAt) < Date.parse(data.builtAt ?? data.generatedAt)) throw new Error('服务器返回了较旧数据，保留当前行情');
      if (!data || incoming.builtAt !== data.builtAt || incoming.generatedAt !== data.generatedAt) {
        await onData(incoming); data = incoming;
      }
      status.lastSuccess = now(); status.error = null;
    } catch (error) { status.error = error.message || '网络连接失败'; }
    finally { status.checking = false; publish(); }
    return { ...status };
  }
  return {
    check(force = false) {
      if (pending) return pending;
      if (!force && status.lastAttempt != null && now() - status.lastAttempt < interval) return Promise.resolve({ ...status });
      pending = perform().finally(() => { pending = null; });
      return pending;
    },
    status: () => ({ ...status })
  };
}
