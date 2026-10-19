export const COMPUTED_KEY = 'shoucai.computedResult';
export const COMPUTED_VERSION = 2;
const PLACES = ['workbench', 'tech', 'pharmacy', 'armory'];
const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));

// A parsable cache can still have been truncated or written by an incompatible release.
// Validate the fields the home renderer dereferences before trusting its fast path.
export function isUsableComputedResult(data) {
  if (!object(data) || data.computedVersion !== COMPUTED_VERSION
    || !Number.isFinite(Date.parse(data.generatedAt)) || !Number.isFinite(Date.parse(data.builtAt ?? data.generatedAt))
    || !object(data.defaults?.placeRules) || !object(data.settings?.stations)
    || !object(data.plan?.profit) || !Array.isArray(data.plan.recipes)
    || !Array.isArray(data.plan.issues) || !object(data.proposal)
    || !Array.isArray(data.proposal.recipes) || !Array.isArray(data.proposal.changes)
    || !object(data.sell) || !Array.isArray(data.buyPlan?.materials)) return false;
  if (!PLACES.every(place => object(data.settings.stations[place])
    && data.plan.recipes.filter(row => object(row) && row.place === place).length === 1)) return false;
  return ['accounts', 'sharedAccounts', 'userShare', 'rate'].every(key => Number.isFinite(data.settings[key]))
    && ['conservativeWeeklyPerAccount', 'highWeeklyPerAccount'].every(key =>
      data.plan.profit[key] === null || Number.isFinite(data.plan.profit[key]));
}

export function computationSignature(context) {
  return JSON.stringify([context.settings ?? null, context.adoption ?? null, context.stocked ?? null, Boolean(context.lazy)]);
}

export function homeSnapshot(data, result, settings) {
  const { stabilityEvidence, materialOpportunities, stableMaterialOpportunities, ...plan } = result.plan;
  return {
    schemaVersion: data.schemaVersion, computedVersion: COMPUTED_VERSION,
    generatedAt: data.generatedAt, builtAt: data.builtAt, staleAfterHours: 14,
    defaults: data.defaults, source: data.source, harvest: data.harvest,
    plan: { ...plan, materialOpportunities: [], stableMaterialOpportunities: [] },
    buyPlan: result.buyPlan, sell: result.sell, proposal: result.proposal, settings,
    lazyDemand: data.lazyDemand ?? []
  };
}

export function readComputedResult(storage, context) {
  try {
    const record = JSON.parse(storage.getItem(COMPUTED_KEY));
    if (record?.version !== COMPUTED_VERSION || record.signature !== computationSignature(context)
      || !isUsableComputedResult(record.data)) return null;
    return record.data;
  } catch { return null; }
}

export function writeComputedResult(storage, context, data) {
  if (!isUsableComputedResult(data)) return false;
  try {
    storage.setItem(COMPUTED_KEY, JSON.stringify({ version: COMPUTED_VERSION,
      signature: computationSignature(context), data }));
    return true;
  } catch { return false; }
}
