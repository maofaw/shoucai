import { buildWeeklyBuyAdvice } from './engine/buy-window.mjs';
import { buildPortfolioSaleTiming } from './engine/weekend-prices.mjs';

export const PLACES = ['workbench', 'tech', 'pharmacy', 'armory'];
export const normalize = value => String(value ?? '').toLowerCase().replace(/[\s·×*（）()]/g, '');
export const finite = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const bounded = (value, fallback, min, max) => finite(value) == null ? fallback : Math.min(max, Math.max(min, Number(value)));
export function quantile(values, probability) {
  const sorted = values.map(finite).filter(value => value != null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * Math.max(0, Math.min(1, probability));
  return sorted[Math.floor(index)] + (sorted[Math.ceil(index)] - sorted[Math.floor(index)]) * (index % 1);
}

export function migrateSettings(saved = {}, defaults = {}) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
  const stations = {};
  for (const place of PLACES) {
    const rule = defaults.placeRules?.[place] ?? {};
    const old = saved.stations?.[place] ?? {};
    const runsByHours = { ...rule.weeklyRunsByHours };
    for (const [hour, runs] of Object.entries(old.runsByHours ?? {})) {
      if (Number(hour) > 0) runsByHours[hour] = bounded(runs, runsByHours[hour] ?? 17.5, 0.5, 168 / Number(hour));
    }
    stations[place] = {
      allowedHours: validHours(old.allowedHours, rule.allowedHours ?? [8]),
      preferred: typeof old.preferred === 'string' ? old.preferred : rule.preferredNames?.[0] ?? '',
      threshold: bounded(old.threshold, Number(rule.switchThreshold ?? 0.05) * 100, 0, 100),
      runsByHours,
      weeklyRuns: bounded(old.weeklyRuns, rule.weeklyRuns ?? 17.5, 0.5, 168),
      longHours: validHours(old.longHours, rule.longHours ?? [16, 24]),
      shortHours: validHours(old.shortHours, rule.shortHours ?? [4, 4.5, 6, 7, 8]),
      longPreferred: old.longPreferred ?? old.preferred ?? rule.preferredNames?.[0] ?? '',
      shortPreferred: old.shortPreferred ?? ''
    };
  }
  const accounts = Math.floor(bounded(saved.accounts, defaults.accounts ?? 28, 1, 999));
  const buy7 = bounded(saved.buy7, 30, 1, 50);
  const buy14 = bounded(saved.buy14, 15, 1, buy7);
  return {
    version: 4, accounts, sharedAccounts: Math.floor(bounded(saved.sharedAccounts, defaults.sharedAccounts ?? 10, 0, accounts)),
    userShare: bounded(saved.userShare, defaults.ownerSharePercent ?? 80, 0, 100),
    rate: bounded(saved.rate, defaults.haffPerCnyWan ?? 52, 1, 1_000_000),
    budgetWan: bounded(saved.budgetWan, (defaults.buyBudgetPerAccount ?? 10_000_000) / 10_000, 0, 1_000_000_000),
    stations, techMode: saved.techMode === 'short' ? 'short' : 'long',
    conservativePercentile: bounded(saved.conservativePercentile, 25, 1, 49),
    highPercentile: bounded(saved.highPercentile, 75, 51, 99),
    historyDays: [1, 7, 15].includes(Number(saved.historyDays)) ? Number(saved.historyDays) : 15,
    buy7, buy14, buy30: bounded(saved.buy30, 5, 1, buy14),
    stableShare: bounded(saved.stableShare, 3, 0, 20), stableSpread: bounded(saved.stableSpread, 8, 0, 50)
  };
}

function validHours(value, fallback) {
  return [...new Set((Array.isArray(value) ? value : fallback).map(Number).filter(hour => hour > 0 && hour <= 168))];
}

export function rankCandidates(data, settings, place, mode = settings.techMode) {
  const rule = settings.stations[place];
  const hours = place === 'tech' ? rule[`${mode}Hours`] : rule.allowedHours;
  const preferredName = place === 'tech' ? rule[`${mode}Preferred`] : rule.preferred;
  const range = `${settings.historyDays}d`;
  return (data.candidatePools?.[place] ?? [])
    .filter(item => hours.includes(item.hours) && (place !== 'tech' || (mode === 'short' ? item.category !== 'gun' && item.hours >= 4 && item.hours <= 8 : item.category === 'gun')))
    .map(item => {
      const samples = (item.profitSamplesByRange?.[range] ?? (range === '15d' ? item.profitSamples : []) ?? []).map(finite).filter(x => x != null);
      const enough = samples.length >= 24;
      const conservativeProfit = enough ? quantile(samples, settings.conservativePercentile / 100) : finite(item.currentProfit);
      const highProfit = enough ? quantile(samples, settings.highPercentile / 100) : finite(item.currentProfit);
      const runsPerWeek = Math.min(168 / item.hours, place === 'tech' ? rule.runsByHours[item.hours] ?? 17.5 : rule.weeklyRuns);
      const evidence = { ...item.evidence, ...item.evidenceByRange?.[range], range, sampleCount: samples.length,
        weekendOnly: range !== '1d' && (item.evidenceByRange?.[range]?.weekendOnly ?? (range === '15d' && item.evidence?.weekendOnly)),
        provisional: !enough, source: enough ? 'Moligod 原生特勤收益曲线' : 'Moligod 当前配方快照' };
      return { ...item, conservativeProfit, highProfit, runsPerWeek, weeklyRuns: runsPerWeek,
        conservativeWeeklyProfit: conservativeProfit * runsPerWeek, highWeeklyProfit: highProfit * runsPerWeek,
        weeklyConservativeProfit: conservativeProfit * runsPerWeek, weeklyHighProfit: highProfit * runsPerWeek,
        preferred: Boolean(preferredName) && normalize(item.name) === normalize(preferredName), evidence,
        revenue: item.currentRevenue, conservativeRevenue: item.currentRevenue,
        priceEvidence: { ...evidence, saleWindows: item.saleWindows ?? [] },
        recipe: { id: item.id, materials: (item.materials ?? []).map(material => ({
          display_name: material.name, required_count: material.count, current_price: material.currentPrice, acquisition: material.acquisition
        })) }
      };
    }).sort((a, b) => b.conservativeWeeklyProfit - a.conservativeWeeklyProfit || a.id - b.id);
}

export function chooseCandidate(candidates, threshold) {
  const profitable = candidates.filter(item => item.conservativeProfit > 0 && item.currentProfit > 0 && item.runsPerWeek > 0);
  const best = profitable[0];
  if (!best) return { main: null, backup: null };
  const preferred = profitable.find(item => item.preferred);
  const main = preferred && best.conservativeWeeklyProfit <= preferred.conservativeWeeklyProfit * (1 + threshold / 100) ? preferred : best;
  return { main, backup: profitable.find(item => item.id !== main.id) ?? null };
}

export function calculatePlan(data, settings) {
  const recipes = [], recommendations = [];
  for (const place of PLACES) {
    const rule = settings.stations[place];
    const candidates = rankCandidates(data, settings, place);
    const { main, backup } = chooseCandidate(candidates, rule.threshold);
    const label = data.defaults?.placeRules?.[place]?.label ?? place;
    if (!main) { recipes.push({ place, label, unavailable: true }); continue; }
    const other = place === 'tech' ? chooseCandidate(rankCandidates(data, settings, place, settings.techMode === 'short' ? 'long' : 'short'), 0).main : null;
    recipes.push({ place, label, main: main.name, hours: main.hours, weeklyRuns: main.runsPerWeek,
      backup: backup?.name ?? null, backupHours: backup?.hours ?? null,
      backupDeltaPercent: backup ? (backup.conservativeWeeklyProfit / main.conservativeWeeklyProfit - 1) * 100 : null,
      reason: main.preferred ? `保持常用配方；其他方案保守周利润未高出${rule.threshold}%` : '当前允许范围内保守周利润最高',
      currentCost: main.currentCost, fee: main.currentFee, currentProfit: main.currentProfit,
      todayMaxProfit: main.todayMaxProfit, sevenDayMaxProfit: main.sevenDayMaxProfit,
      perRunConservativeProfit: main.conservativeProfit, perRunHighProfit: main.highProfit,
      weeklyConservativeProfit: main.conservativeWeeklyProfit, weeklyHighProfit: main.highWeeklyProfit,
      provisional: main.evidence.provisional, evidence: main.evidence,
      otherMode: other ? { mode: settings.techMode === 'short' ? '长时枪械' : '短时配件', name: other.name, hours: other.hours,
        weeklyProfit: other.conservativeWeeklyProfit, provisional: other.evidence.provisional } : null
    });
    recommendations.push({ place, label, cashSelected: main, cashCandidates: candidates });
  }
  const conservativeWeekly = recommendations.reduce((sum, item) => sum + item.cashSelected.conservativeWeeklyProfit, 0);
  const highWeekly = recommendations.reduce((sum, item) => sum + item.cashSelected.highWeeklyProfit, 0);
  const provisional = recipes.some(item => item.unavailable || item.provisional);
  const buyPlan = buildWeeklyBuyAdvice({ recommendations, historiesByMaterial: data.materialHistories ?? {},
    now: new Date(data.builtAt ?? data.generatedAt), budgetPerAccount: settings.budgetWan * 10_000,
    materialFilter: { minimumSamples: 336, maxWeeklyCostShare: settings.stableShare / 100, maxPriceSpread: settings.stableSpread / 100 },
    pricePercentiles: { days7: settings.buy7 / 100, days14: settings.buy14 / 100, days30: settings.buy30 / 100 }
  });
  return { plan: { recipes, profit: {
    conservativeWeeklyPerAccount: conservativeWeekly, conservativeDailyPerAccount: conservativeWeekly / 7,
    conservativeMonthlyPerAccount: conservativeWeekly / 7 * 30, highWeeklyPerAccount: highWeekly, highDailyPerAccount: highWeekly / 7,
    provisional, basis: `最近${settings.historyDays}天原生净利润：保守${settings.conservativePercentile}%分位、较高${settings.highPercentile}%分位。${provisional ? '部分历史不足或制造台暂停，合计为临时估算。' : '7/15天优先用周末样本。'}实际到手取决于买料成本和售出价。`
  } }, buyPlan, sell: { ...buildPortfolioSaleTiming(recommendations), undercutLevels: 1 } };
}

export function sortMaterials(rows) {
  const rank = item => item.action === 'buy' ? ({ 30: 0, 14: 1, 7: 2 }[item.tierDays] ?? 2) : item.action === 'wait' ? 3 : 4;
  return [...rows].sort((a, b) => rank(a) - rank(b) || (a.currentPrice / (a.targetPrice || 1) - b.currentPrice / (b.targetPrice || 1)) || a.name.localeCompare(b.name, 'zh-CN'));
}
