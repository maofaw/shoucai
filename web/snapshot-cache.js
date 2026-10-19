const DATABASE = 'shoucai-market-cache';
const STORE = 'snapshots';
const KEY = 'latest';

function openDatabase(indexedDBImpl) {
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('无法打开行情缓存'));
    request.onblocked = () => reject(new Error('行情缓存暂被其他页面占用'));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('行情缓存读取失败'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('行情缓存写入失败'));
    transaction.onabort = () => reject(transaction.error || new Error('行情缓存写入已取消'));
  });
}

export function isUsableMarketSnapshot(data) {
  return Boolean(data?.candidatePools && data?.defaults?.placeRules
    && Number.isFinite(Date.parse(data.generatedAt))
    && Number.isFinite(Date.parse(data.builtAt ?? data.generatedAt))
    && ['workbench', 'tech', 'pharmacy', 'armory'].every(place => Array.isArray(data.candidatePools[place])));
}

export function isSameMarketVersion(a, b) {
  return Boolean(a && b && (a.builtAt ?? a.generatedAt) === (b.builtAt ?? b.generatedAt) && a.generatedAt === b.generatedAt);
}

// Reject a fresh build of older source data as well as an older build of the same data.
export function isOlderMarketVersion(candidate, current) {
  if (!current) return false;
  return ['generatedAt', 'builtAt'].some(key => {
    const field = key === 'builtAt' ? value => value.builtAt ?? value.generatedAt : value => value.generatedAt;
    const incoming = Date.parse(field(candidate ?? {})), previous = Date.parse(field(current));
    return !Number.isFinite(incoming) || (Number.isFinite(previous) && incoming < previous);
  });
}

export async function readPersistedMarketSnapshot(options = {}) {
  const indexedDBImpl = options.indexedDBImpl ?? globalThis.indexedDB;
  if (!indexedDBImpl) return null;
  let database;
  try {
    database = await openDatabase(indexedDBImpl);
    const record = await requestResult(database.transaction(STORE, 'readonly').objectStore(STORE).get(KEY));
    return isUsableMarketSnapshot(record?.data) ? record : null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

export async function persistMarketSnapshot(data, options = {}) {
  if (!isUsableMarketSnapshot(data)) return false;
  const indexedDBImpl = options.indexedDBImpl ?? globalThis.indexedDB;
  if (!indexedDBImpl) return false;
  let database;
  try {
    database = await openDatabase(indexedDBImpl);
    const transaction = database.transaction(STORE, 'readwrite');
    const done = transactionDone(transaction);
    const objectStore = transaction.objectStore(STORE);
    let saved = false;
    // Read and write in one transaction: a slow, older tab must not replace newer data.
    const existing = objectStore.get(KEY);
    existing.onsuccess = () => {
      if (isUsableMarketSnapshot(existing.result?.data) && isOlderMarketVersion(data, existing.result.data)) return;
      objectStore.put({ data, savedAt: Date.now() }, KEY);
      saved = true;
    };
    await done;
    return saved;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

export const MARKET_CACHE_DATABASE = DATABASE;
