export async function loadMarketSnapshot(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const suffix = `?v=${options.cacheBust ?? Date.now()}`;
  const init = { cache: 'no-store', signal: options.signal };
  let compressedError = null;

  if (options.preferCompressed !== false && typeof DecompressionStream === 'function') {
    try {
      const response = await fetchImpl(`./data/latest.json.gz${suffix}`, init);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!response.body) throw new Error('压缩行情响应为空');
      const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
      return {
        data: await new Response(stream).json(),
        offline: response.headers.get('x-shoucai-offline') === '1',
        compressed: true
      };
    } catch (error) {
      compressedError = error;
    }
  }

  try {
    const response = await fetchImpl(`./data/latest.json${suffix}`, init);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return {
      data: await response.json(),
      offline: response.headers.get('x-shoucai-offline') === '1',
      compressed: false
    };
  } catch (error) {
    if (compressedError) throw new Error(`压缩行情读取失败：${compressedError.message}；备用行情读取失败：${error.message}`);
    throw error;
  }
}
