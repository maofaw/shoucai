import { computationSignature } from './computed-cache.js';
export function readAdminKey(hash) {
  try { return hash.startsWith('#manage=') ? decodeURIComponent(hash.slice('#manage='.length)) : ''; }
  catch { return ''; }
}

export function acceptsComputation(requested, current, computed) {
  if (computationSignature(requested) !== computationSignature(current)) return false;
  const incoming = Date.parse(computed?.compact?.builtAt ?? computed?.builtAt);
  const displayed = Date.parse(current.version?.builtAt);
  const incomingMarket = Date.parse(computed?.compact?.generatedAt ?? computed?.generatedAt);
  const displayedMarket = Date.parse(current.version?.generatedAt);
  return Number.isFinite(incoming) && (!Number.isFinite(displayed) || incoming >= displayed)
    && Number.isFinite(incomingMarket) && (!Number.isFinite(displayedMarket) || incomingMarket >= displayedMarket);
}

export function applyRemoteTimes(storage, payload, before, now = Date.now()) {
  const remote = payload?.state;
  if (!remote || typeof remote !== 'object') return;
  for (const [field, key] of [['lastHarvestFinishedAt', 'shoucai.lastHarvestFinishedAt'],
    ['lastSellFinishedAt', 'shoucai.lastSellFinishedAt']]) {
    if (!Object.hasOwn(remote, field) || storage.getItem(key) !== before[key]) continue;
    const entry = remote[field];
    if (!entry || !Object.hasOwn(entry, 'value')) continue;
    const value = entry.value;
    if (value === null) storage.removeItem(key);
    else if (typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now) storage.setItem(key, value);
  }
}
