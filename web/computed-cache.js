export const COMPUTED_KEY = 'shoucai.computedResult';
export const COMPUTED_VERSION = 1;

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
      || !record.data?.plan?.profit || !Number.isFinite(Date.parse(record.data.generatedAt))) return null;
    return record.data;
  } catch { return null; }
}

export function writeComputedResult(storage, context, data) {
  try {
    storage.setItem(COMPUTED_KEY, JSON.stringify({ version: COMPUTED_VERSION,
      signature: computationSignature(context), data }));
    return true;
  } catch { return false; }
}
