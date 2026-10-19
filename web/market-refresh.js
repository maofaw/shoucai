import { isUsableMarketSnapshot, isOlderMarketVersion, isSameMarketVersion } from './snapshot-cache.js';
import { isUsableComputedResult } from './computed-cache.js';

export const MARKET_CHECK_MS = 12 * 60 * 60_000;
const usable = value => isUsableMarketSnapshot(value) || isUsableComputedResult(value);

// Scheduling is injected by the UI; this state machine is also used in tests.
export function createMarketRefresher({ load, onData, onStatus = () => {}, now = Date.now, interval = MARKET_CHECK_MS, initialData = null }) {
  const status = { lastAttempt: null, lastSuccess: null, checking: false, error: null };
  let pending = null, data = usable(initialData) ? initialData : null;
  const currentStatus = () => ({ ...status, generatedAt: data?.generatedAt ?? null });
  const publish = () => onStatus(currentStatus());
  async function perform() {
    status.lastAttempt = now(); status.checking = true; publish();
    try {
      const result = await load();
      const incoming = result.data;
      if (!usable(incoming)) throw new Error('行情文件不完整');
      if (result.offline) {
        if (!data) { await onData(incoming); data = incoming; }
        throw new Error('当前使用离线缓存');
      }
      if (isOlderMarketVersion(incoming, data)) throw new Error('服务器返回了较旧数据，保留当前行情');
      if (!isSameMarketVersion(incoming, data)) {
        await onData(incoming);
        if (!isOlderMarketVersion(incoming, data)) data = incoming;
      }
      status.lastSuccess = now(); status.error = null;
    } catch (error) { status.error = error.message || '网络连接失败'; }
    finally { status.checking = false; publish(); }
    return currentStatus();
  }
  return {
    check(force = false) {
      if (pending) return pending;
      if (!force && status.lastAttempt != null && now() - status.lastAttempt < interval) return Promise.resolve(currentStatus());
      pending = perform().finally(() => { pending = null; });
      return pending;
    },
    setData(value) {
      if (!usable(value) || isOlderMarketVersion(value, data)) return false;
      data = value;
      return true;
    },
    status: currentStatus
  };
}
