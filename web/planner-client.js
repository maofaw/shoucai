export function createPlannerClient(createWorker = () => new Worker(new URL('./planner-worker.js', import.meta.url), { type: 'module' })) {
  let worker, id = 0;
  const pending = new Map();
  function fail(error) {
    for (const item of pending.values()) item.reject(error);
    pending.clear(); worker?.terminate(); worker = null;
  }
  return {
    request(command, payload = {}) {
      if (!worker) {
        worker = createWorker();
        worker.onmessage = ({ data }) => {
          const item = pending.get(data.id);
          if (!item) return;
          pending.delete(data.id);
          data.error ? item.reject(new Error(data.error)) : item.resolve(data.value);
        };
        worker.onerror = () => fail(new Error('后台计算未能启动，请刷新页面重试'));
      }
      return new Promise((resolve, reject) => {
        const requestId = ++id;
        pending.set(requestId, { resolve, reject });
        worker.postMessage({ id: requestId, command, payload });
      });
    },
    close() { fail(new Error('后台计算已结束')); }
  };
}
