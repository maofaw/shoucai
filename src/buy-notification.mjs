import { normalizeName } from './recommend.mjs';

export function buildBuyNotificationPayload(dashboard, options = {}) {
  const accounts = positiveInteger(options.accounts ?? dashboard?.defaults?.accounts, 1);
  const materials = (dashboard?.buyPlan?.materials ?? [])
    .filter(material => !material.ignored
      && material.action === 'buy'
      && Number(material.tierDays) >= 7
      && Number.isFinite(Number(material.currentPrice)))
    .map(material => {
      const tierDays = normalizeTier(material.tierDays);
      const perAccountCount = countForTier(material, tierDays);
      const currentPrice = Number(material.currentPrice);
      return {
        key: normalizeName(material.name),
        name: String(material.name),
        tierDays,
        currentPrice,
        thresholdPrice: Number(material.tierThresholds?.[`days${tierDays}`] ?? material.targetPrice),
        perAccountCount,
        totalCount: round(perAccountCount * accounts, 2),
        perAccountCost: round(perAccountCount * currentPrice),
        totalCost: round(perAccountCount * accounts * currentPrice),
        watchOnly: Boolean(material.watchOnly),
        exchangeFor: material.exchangeFor ?? null,
        recipes: Array.isArray(material.recipes) ? material.recipes : [],
        reason: String(material.reason ?? '')
      };
    })
    .filter(material => material.key && material.perAccountCount > 0)
    .sort((a, b) => b.tierDays - a.tierDays || b.totalCost - a.totalCost);

  return {
    generatedAt: dashboard?.generatedAt ?? new Date().toISOString(),
    dashboardUrl: options.dashboardUrl ?? 'https://maofaw.github.io/shoucai/?view=buy',
    accounts,
    source: dashboard?.source?.name ?? 'Moligod',
    materials
  };
}

function countForTier(material, tierDays) {
  if (tierDays === 30) return Number(material.perAccount30Days ?? 0);
  if (tierDays === 14) return Number(material.perAccount14Days ?? 0);
  return Number(material.perAccount7Days ?? 0);
}

function normalizeTier(value) {
  const days = Number(value);
  if (days >= 30) return 30;
  if (days >= 14) return 14;
  return 7;
}

function positiveInteger(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}
