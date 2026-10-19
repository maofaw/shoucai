export function createPlannerClient(createWorker = () => new Worker(new URL('./planner-worker.js', import.meta.url), { type: 'module' }),
  { timeout = 90_000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let worker, id = 0;
  const pending = new Map();
  function fail(error) {
    for (const item of pending.values()) { clearTimer(item.timer); item.reject(error); }
    pending.clear(); worker?.terminate(); worker = null;
  }
  return {
    request(command, payload = {}) {
      return new Promise((resolve, reject) => {
      try {
      if (!worker) {
        const activeWorker = worker = createWorker();
        worker.onmessage = ({ data }) => {
          if (worker !== activeWorker || !data || typeof data !== 'object') return;
          const item = pending.get(data.id);
          if (!item) return;
          pending.delete(data.id);
          clearTimer(item.timer);
          data.error ? item.reject(new Error(data.error)) : item.resolve(data.value);
        };
        worker.onerror = worker.onmessageerror = () => {
          if (worker === activeWorker) fail(new Error('后台计算未能启动，请刷新页面重试'));
        };
      }
        const requestId = ++id;
        const timer = setTimer(() => fail(new Error('后台计算超时，请重试')), timeout);
        pending.set(requestId, { resolve, reject, timer });
        worker.postMessage({ id: requestId, command, payload });
      } catch (error) {
        fail(error);
        reject(error);
      }
      });
    },
    close() { fail(new Error('后台计算已结束')); }
  };
}
