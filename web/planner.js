import { buildWeeklyBuyAdvice, buildMaterialPriceProfile } from './engine/buy-window.mjs';
import { buildPortfolioSaleTiming } from './engine/weekend-prices.mjs';
import { combineHistories } from './engine/market-history.mjs';
import { procurement, profitScenario, totalScenarios } from './scenarios.js';

export const PLACES = ['workbench', 'tech', 'pharmacy', 'armory'];
export const normalize = value => String(value ?? '').toLowerCase().replace(/[\s·×*（）()]/g, '');
export const finite = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
const materialProfileCache = new WeakMap();
const bounded = (value, fallback, min, max) => finite(value) == null ? fallback : Math.min(max, Math.max(min, Number(value)));
export function quantile(values, probability) {
  const sorted = values.map(finite).filter(value => value != null).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * Math.max(0, Math.min(1, probability));
  return sorted[Math.floor(index)] + (sorted[Math.ceil(index)] - sorted[Math.floor(index)]) * (index % 1);
}

export function migrateSettings(saved = null, defaults = {}) {
  const hasSavedSettings = Boolean(saved && typeof saved === 'object' && !Array.isArray(saved));
  if (!hasSavedSettings) saved = {};
  const legacyShortRuns = [
    saved.shortWeeklyRuns,
    saved.stations?.workbench?.weeklyRuns,
    saved.stations?.tech?.runsByHours?.[8],
    saved.stations?.pharmacy?.weeklyRuns,
    saved.stations?.armory?.weeklyRuns
  ].map(finite).find(value => value != null);
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
  const accounts = Math.floor(bounded(saved.accounts, hasSavedSettings ? defaults.accounts ?? 0 : 0, 0, 999));
  const buy7 = bounded(saved.buy7, 30, 1, 50);
  const buy14 = bounded(saved.buy14, 15, 1, buy7);
  return {
    version: 8, accounts, sharedAccounts: Math.floor(bounded(saved.sharedAccounts, hasSavedSettings ? defaults.sharedAccounts ?? 0 : 0, 0, accounts)),
    shortWeeklyRuns: bounded(legacyShortRuns, defaults.shortWeeklyRuns ?? 17.5, 0.5, 42),
    scenarioDays: [7,14,30].includes(Number(saved.scenarioDays)) ? Number(saved.scenarioDays) : 7,
    userShare: bounded(saved.userShare, hasSavedSettings ? defaults.ownerSharePercent ?? 100 : 100, 0, 100),
    rate: bounded(saved.rate, defaults.haffPerCnyWan ?? 52, 1, 1_000_000),
    budgetWan: bounded(saved.budgetWan, (defaults.buyBudgetPerAccount ?? 10_000_000) / 10_000, 0, 1_000_000_000),
    stations, techMode: saved.techMode === 'short' ? 'short' : 'long',
    conservativePercentile: bounded(saved.conservativePercentile, 25, 1, 49),
    highPercentile: bounded(saved.highPercentile, 75, 51, 99),
    historyDays: [1, 7, 15].includes(Number(saved.historyDays)) ? Number(saved.historyDays) : 15,
    buy7, buy14, buy30: bounded(saved.buy30, 5, 1, buy14),
    stableShare: bounded(saved.stableShare, 3, 0, 20), stableSpread: bounded(saved.stableSpread, 8, 0, 50),
    lazySwitchThreshold: bounded(saved.lazySwitchThreshold, 10, 0, 100)
  };
}

function validHours(value, fallback) {
  return [...new Set((Array.isArray(value) ? value : fallback).map(Number).filter(hour => hour > 0 && hour <= 168))];
}

export function rankCandidates(data, settings, place, mode = settings.techMode, includeAll = false) {
  const rule = settings.stations[place];
  const hours = place === 'tech' ? rule[`${mode}Hours`] : rule.allowedHours;
  const preferredName = place === 'tech' ? rule[`${mode}Preferred`] : rule.preferred;
  const range = `${settings.historyDays}d`;
  return (data.candidatePools?.[place] ?? [])
    .filter(item => includeAll || (hours.includes(item.hours) && (place !== 'tech' || (mode === 'short' ? item.category !== 'gun' && item.hours >= 4 && item.hours <= 8 : item.category === 'gun'))))
    .map(item => {
      const samples = (item.profitSamplesByRange?.[range] ?? (range === '15d' ? item.profitSamples : []) ?? []).map(finite).filter(x => x != null);
      const enough = samples.length >= 24;
      const conservativeProfit = enough ? quantile(samples, settings.conservativePercentile / 100) : finite(item.currentProfit);
      const highProfit = enough ? quantile(samples, settings.highPercentile / 100) : finite(item.currentProfit);
      const configuredRuns = item.hours <= 8
        ? settings.shortWeeklyRuns
        : place === 'tech' ? rule.runsByHours[item.hours] ?? 168 / item.hours : rule.weeklyRuns;
      const runsPerWeek = Math.min(168 / item.hours, configuredRuns);
      const evidence = { ...item.evidence, ...item.evidenceByRange?.[range], range, sampleCount: samples.length,
        weekendOnly: range !== '1d' && (item.evidenceByRange?.[range]?.weekendOnly ?? (range === '15d' && item.evidence?.weekendOnly)),
        provisional: !enough, source: enough ? 'Moligod 原生特勤收益曲线' : 'Moligod 当前配方快照' };
      const scenario = profitScenario({ ...item, runsPerWeek }, settings);
      return { ...item, conservativeProfit, highProfit, runsPerWeek, weeklyRuns: runsPerWeek, scenario,
        selectionWeeklyProfit: scenario?.conservativeWeekly ?? (data.schemaVersion >= 5 ? null : conservativeProfit * runsPerWeek),
        conservativeWeeklyProfit: conservativeProfit * runsPerWeek, highWeeklyProfit: highProfit * runsPerWeek,
        weeklyConservativeProfit: conservativeProfit * runsPerWeek, weeklyHighProfit: highProfit * runsPerWeek,
        preferred: Boolean(preferredName) && normalize(item.name) === normalize(preferredName), evidence,
        revenue: item.currentRevenue, conservativeRevenue: item.currentRevenue,
        priceEvidence: { ...evidence, saleWindows: item.saleWindows ?? [] },
        recipe: { id: item.id, materials: (item.materials ?? []).map(material => ({
          display_name: material.name, required_count: material.count, current_price: material.currentPrice, acquisition: material.acquisition
        })) }
      };
    }).sort((a, b) => (b.selectionWeeklyProfit ?? -Infinity) - (a.selectionWeeklyProfit ?? -Infinity) || a.id - b.id);
}

const score = item => item.selectionWeeklyProfit;
export function chooseCandidate(candidates, threshold, activeId = null) {
  const profitable = candidates.filter(item => score(item) > 0 && item.currentProfit > 0 && item.runsPerWeek > 0);
  const best = profitable[0];
  if (!best) return { main: null, backup: null };
  const preferred = activeId != null ? profitable.find(item => item.id === activeId) : profitable.find(item => item.preferred);
  const main = preferred && score(best) <= score(preferred) * (1 + threshold / 100) ? preferred : best;
  return { main, backup: profitable.find(item => item.id !== main.id) ?? null };
}

export const ADOPTION_KEY = 'shoucai.adoptedPlan';
export const STOCK_KEY = 'shoucai.stockedMaterials';
export function validStockedMaterials(record) {
  if (record?.version !== 1 || !Array.isArray(record.items)) return { version: 1, items: [] };
  const items = record.items.filter(row => normalize(row?.name) && finite(row?.unitPrice) != null && Number(row.unitPrice) >= 0
    && [7, 14, 30].includes(Number(row.coverageDays)))
    .map(row => ({ name: String(row.name).trim(), key: normalize(row.name), unitPrice: Number(row.unitPrice),
      coverageDays: Number(row.coverageDays), confirmedAt: Number.isFinite(Date.parse(row.confirmedAt)) ? row.confirmedAt : new Date(0).toISOString() }));
  return { version: 1, items: [...new Map(items.map(row => [row.key, row])).values()] };
}

export function saveStockedMaterial(record, material, now = new Date()) {
  const current = validStockedMaterials(record);
  if (!normalize(material?.name) || !(finite(material?.unitPrice) >= 0) || ![7,14,30].includes(Number(material?.coverageDays))) {
    throw new Error('请填写有效的材料价格，并选择7、14或30天。');
  }
  const item = { name: String(material.name).trim(), key: normalize(material.name), unitPrice: Number(material.unitPrice),
    coverageDays: Number(material.coverageDays), confirmedAt: now.toISOString() };
  return { version: 1, items: [...current.items.filter(row => row.key !== item.key), item] };
}

export function removeStockedMaterial(record, name) {
  const current = validStockedMaterials(record);
  const id = normalize(name);
  return { version: 1, items: current.items.filter(row => row.key !== id) };
}

export function validAdoption(record) {
  if (record?.version !== 1 || !Number.isFinite(Date.parse(record.adoptedAt)) || !Array.isArray(record.recipes) || record.recipes.length !== 4) return null;
  if (!PLACES.every(place => record.recipes.filter(row=>row.place===place && Number.isInteger(row.id) && row.id>0).length === 1)) return null;
  return record;
}
export function adoptProposal(proposal, now = new Date()) {
  if (!proposal.canAdopt) throw new Error('四台建议尚未齐全，暂不能采用。');
  return { version: 1, adoptedAt: now.toISOString(), recipes: proposal.recipes.map(row=>({place:row.place,id:row.id,name:row.main,hours:row.hours})) };
}

export function adoptRecipe(savedAdoption, proposal, place, recipe, now = new Date()) {
  if (!PLACES.includes(place)) throw new Error('找不到要更换的制造台。');
  if (!Number.isInteger(recipe?.id) || recipe.id <= 0 || !recipe.name || !Number.isFinite(Number(recipe.hours))) {
    throw new Error('所选配方数据不完整，请刷新行情后重试。');
  }
  const current = validAdoption(savedAdoption);
  const base = current?.recipes ?? (proposal?.canAdopt ? proposal.recipes.map(row => ({
    place: row.place, id: row.id, name: row.main, hours: row.hours
  })) : null);
  if (!base || !PLACES.every(key => base.some(row => row.place === key))) {
    throw new Error('其他制造台方案尚未齐全，暂不能保存本台配方。');
  }
  return {
    version: 1,
    adoptedAt: now.toISOString(),
    recipes: base.map(row => row.place === place
      ? { place, id: recipe.id, name: recipe.name, hours: Number(recipe.hours) }
      : { place: row.place, id: row.id, name: row.name, hours: row.hours })
  };
}

function recipeCard(main, backup, place, label, reason, other = null) {
  if (!main) return {place,label,unavailable:true,reason};
  return { place, label, id: main.id, main: main.name, hours: main.hours, weeklyRuns: main.runsPerWeek,
    backup: backup?.name ?? null, backupHours: backup?.hours ?? null,
    backupDeltaPercent: backup && score(main) > 0 ? (score(backup) / score(main) - 1) * 100 : null,
    reason, currentCost: main.currentCost, fee: main.currentFee, currentProfit: main.currentProfit,
    todayMaxProfit: main.todayMaxProfit, sevenDayMaxProfit: main.sevenDayMaxProfit,
    nativeConservativeProfit: main.conservativeProfit, nativeHighProfit: main.highProfit,
    perRunConservativeProfit: main.scenario ? main.scenario.conservativeWeekly / main.runsPerWeek : null,
    weeklyConservativeProfit: main.scenario?.conservativeWeekly ?? null,
    provisional: !main.scenario, evidence: main.evidence, historyReadAt: main.historyReadAt ?? null,
    scenarioSampleCount: main.scenario?.sampleCount ?? 0,
    otherMode: other ? {mode:other.mode,name:other.name,hours:other.hours,weeklyProfit:other.scenario?.conservativeWeekly ?? null} : null };
}

function allowedPools(data, settings) {
  return Object.fromEntries(PLACES.map(place => [place, rankCandidates(data, settings, place)]));
}

function materialCatalog(pools, data, settings) {
  const materials = new Map();
  for (const candidate of Object.values(pools).flat()) {
    const purchase = procurement(candidate, settings.scenarioDays ?? 7);
    for (const row of purchase?.materials ?? []) {
      const id = normalize(row.name);
      if (!id || !Number.isFinite(row.price)) continue;
      const old = materials.get(id) ?? { key: id, name: row.name, currentPrice: row.price, recipes: new Set() };
      old.currentPrice = row.price;
      old.recipes.add(candidate.name);
      materials.set(id, old);
    }
  }
  const histories = new Map(Object.entries(data.materialHistories ?? {}).map(([name, rows]) => [normalize(name), rows]));
  const cacheKey = [data.builtAt ?? data.generatedAt, settings.stableSpread, settings.buy7, settings.buy14, settings.buy30].join('|');
  let dataCache = materialProfileCache.get(data);
  if (!dataCache) { dataCache = new Map(); materialProfileCache.set(data, dataCache); }
  let profiles = dataCache.get(cacheKey);
  if (!profiles) {
    profiles = new Map([...materials.values()].map(row => [row.key, buildMaterialPriceProfile({
      name: row.name, currentPrice: row.currentPrice, history: histories.get(row.key) ?? [],
      now: new Date(data.builtAt ?? data.generatedAt), minimumSamples: 336, stableSpread: settings.stableSpread / 100,
      pricePercentiles: { days7: settings.buy7 / 100, days14: settings.buy14 / 100, days30: settings.buy30 / 100 }
    })]));
    dataCache.set(cacheKey, profiles);
  }
  return [...materials.values()].map(row => ({ ...row, recipes: [...row.recipes], ...profiles.get(row.key) }));
}

function overrideProfiles(rows, horizonDays, coverageDays) {
  return { fallbackToCurrent: true, rows: rows.map(row => {
    const current = finite(row.currentPrice);
    const target = finite(row.unitPrice ?? row.tierThresholds?.[`days${coverageDays}`]);
    if (current == null || target == null) return { name: row.name, ignored: true };
    const covered = Math.min(horizonDays, coverageDays);
    return { name: row.name, unitPrice: (Math.min(current, target) * covered + current * (horizonDays - covered)) / horizonDays };
  }) };
}

function stockedProfiles(stocked, catalog, horizonDays) {
  const byKey = new Map(catalog.map(row => [row.key, row]));
  return { fallbackToCurrent: true, rows: stocked.items.map(item => {
    const market = byKey.get(item.key);
    const current = finite(market?.currentPrice);
    if (current == null) return { name: item.name, ignored: true };
    const covered = Math.min(horizonDays, item.coverageDays);
    return { name: item.name, unitPrice: (item.unitPrice * covered + current * (horizonDays - covered)) / horizonDays };
  }) };
}

function bestPortfolio(pools, settings, profiles = null, predicate = null) {
  const selected = [];
  for (const place of PLACES) {
    const rows = (pools[place] ?? []).filter(candidate => !predicate || predicate(candidate)).map(candidate => {
      const base = candidate.scenario ?? profitScenario(candidate, settings);
      const purchase = profiles && base ? procurement(candidate, settings.scenarioDays ?? 7, profiles) : null;
      const weeklyCost = purchase ? purchase.cost * 7 / (settings.scenarioDays ?? 7) : null;
      const scenario = !profiles ? base : base && weeklyCost != null ? { ...base, purchase, weeklyCost,
        conservativeWeekly: base.conservativeWeekly + base.weeklyCost - weeklyCost,
        highWeekly: base.highWeekly + base.weeklyCost - weeklyCost } : null;
      return { ...candidate, scenario, selectionWeeklyProfit: scenario?.conservativeWeekly ?? null };
    }).filter(candidate => candidate.scenario?.conservativeWeekly > 0 && candidate.currentProfit > 0)
      .sort((a,b) => b.selectionWeeklyProfit - a.selectionWeeklyProfit || a.id - b.id);
    if (!rows[0]) return [];
    selected.push(rows[0]);
  }
  return selected;
}

function median(values) { return quantile(values, 0.5); }
function relativeDifference(a, b) {
  const middle = (Math.abs(a) + Math.abs(b)) / 2;
  return middle > 0 ? Math.abs(a - b) / middle : 0;
}

export function materialStability(name, currentPrice, history, now) {
  const points = combineHistories([{ name, count: 1, rows: history ?? [] }], now)
    .filter(point => Number.isFinite(point.value) && point.value >= 0)
    .sort((a, b) => a.date - b.date);
  const cutoff = now.getTime() - 30 * 86_400_000;
  const recent = points.filter(point => point.date.getTime() >= cutoff);
  const sampleCount = recent.length;
  const coveredDays = sampleCount > 1 ? (recent.at(-1).date - recent[0].date) / 86_400_000 : 0;
  const weekly = [];
  for (let index = 0; index < 4; index += 1) {
    const start = now.getTime() - (28 - index * 7) * 86_400_000;
    const end = start + 7 * 86_400_000;
    const values = recent.filter(point => point.date.getTime() >= start && point.date.getTime() < end).map(point => point.value);
    if (values.length >= 120) weekly.push({ index, samples: values.length, low: quantile(values, 0.15), median: median(values) });
  }
  const lows = weekly.map(row => row.low).filter(value => value != null);
  const targetPrice = median(lows);
  const monthMedian = median(recent.map(point => point.value));
  const lowDeviation = lows.length > 1 && targetPrice > 0 ? (Math.max(...lows) - Math.min(...lows)) / targetPrice : Infinity;
  const repeatWeeks = targetPrice == null ? 0 : weekly.filter(row => {
    const start = now.getTime() - (28 - row.index * 7) * 86_400_000;
    const end = start + 7 * 86_400_000;
    return recent.filter(point => point.date.getTime() >= start && point.date.getTime() < end && point.value <= targetPrice * 1.03).length >= 3;
  }).length;
  const stable = sampleCount >= 504 && coveredDays >= 21 && weekly.length >= 3 && repeatWeeks >= 3 && lowDeviation <= 0.15
    && targetPrice != null && monthMedian != null && targetPrice <= monthMedian * 0.98;
  const split = now.getTime() - 72 * 3_600_000;
  const latest = recent.filter(point => point.date.getTime() >= split).map(point => point.value);
  const earlier = recent.filter(point => point.date.getTime() < split).map(point => point.value);
  const recentMedian = median(latest), earlierMedian = median(earlier);
  const latestIqr = quantile(latest, 0.75) - quantile(latest, 0.25);
  const earlierIqr = quantile(earlier, 0.75) - quantile(earlier, 0.25);
  const priceShift = recentMedian != null && earlierMedian > 0 ? Math.abs(recentMedian / earlierMedian - 1) : 0;
  const volatilityJump = latest.length >= 48 && earlier.length >= 120 && (earlierIqr > 0
    ? latestIqr > earlierIqr * 2 : latestIqr > Math.max(1, earlierMedian * 0.02));
  return { stable, sampleCount, coveredDays, completeWeeks: weekly.length, repeatWeeks, weeklyLowPrices: lows,
    targetPrice, monthMedian, lowDeviationPercent: Number.isFinite(lowDeviation) ? lowDeviation * 100 : null,
    currentPrice, anomalous: priceShift > 0.20 || volatilityJump, priceShiftPercent: priceShift * 100,
    volatilityJump, reason: stable ? `近30天覆盖${coveredDays.toFixed(0)}天，低价在${repeatWeeks}周重复出现` :
      sampleCount < 504 || coveredDays < 21 ? '30天样本或覆盖天数不足' : weekly.length < 3 ? '完整周数不足3周' :
      repeatWeeks < 3 ? '低价没有在至少3周重复出现' : lowDeviation > 0.15 ? '各周低价差异超过15%' : '长期低价优势不足2%' };
}

export function productStability(candidate, settings, now) {
  const rows = (candidate.pairedHistoryByRange?.['15d'] ?? []).filter(row => row.time && Number.isFinite(Date.parse(row.time))
    && finite(row.profit) != null && finite(row.cost) != null && finite(row.revenue) != null)
    .map(row => ({ ...row, at: Date.parse(row.time), value: Number(row.profit) })).sort((a, b) => a.at - b.at);
  const latestAt = Math.min(now.getTime(), rows.at(-1)?.at ?? now.getTime());
  const recentStart = latestAt - 7 * 86_400_000;
  const priorStart = latestAt - 14 * 86_400_000;
  const recent = rows.filter(row => row.at >= recentStart).map(row => row.value);
  const prior = rows.filter(row => row.at >= priorStart && row.at < recentStart).map(row => row.value);
  const all = rows.filter(row => row.at >= latestAt - 15 * 86_400_000).map(row => row.value);
  const recentLow = quantile(recent, settings.conservativePercentile / 100);
  const priorLow = quantile(prior, settings.conservativePercentile / 100);
  const allLow = quantile(all, 0.25), allMedian = median(all);
  const stable = recent.length >= 24 && prior.length >= 24 && recentLow > 0 && priorLow > 0
    && relativeDifference(recentLow, priorLow) <= 0.25 && allLow >= allMedian * 0.65;
  const cutoff72 = latestAt - 72 * 3_600_000;
  const recent72 = rows.filter(row => row.at >= cutoff72).map(row => row.value);
  const before72 = rows.filter(row => row.at < cutoff72).map(row => row.value);
  const latestMedian = median(recent72), previousMedian = median(before72);
  const signReversal = latestMedian != null && previousMedian != null && Math.sign(latestMedian) !== Math.sign(previousMedian);
  const profitShift = latestMedian != null && previousMedian != null && Math.abs(previousMedian) > 0
    ? Math.abs(latestMedian / previousMedian - 1) : 0;
  return { stable, sampleCount: all.length, recentSamples: recent.length, priorSamples: prior.length,
    recentConservative: recentLow, priorConservative: priorLow, p25: allLow, median: allMedian,
    windowDifferencePercent: recentLow != null && priorLow != null ? relativeDifference(recentLow, priorLow) * 100 : null,
    anomalous: signReversal || profitShift > 0.25, profitShiftPercent: profitShift * 100, signReversal,
    reason: stable ? '前后两个约7天窗口均为正，保守利润差异不超过25%' :
      recent.length < 24 || prior.length < 24 ? '两段历史样本不足' : recentLow <= 0 || priorLow <= 0 ? '至少一段保守利润不为正' :
      relativeDifference(recentLow, priorLow) > 0.25 ? '前后两段保守利润差异超过25%' : '低位利润相对中位数断层明显' };
}

function summaryFor(candidates, settings, weeklyProfiles = null, monthlyProfiles = weeklyProfiles) {
  const weekly = totalScenarios(candidates, settings, weeklyProfiles);
  const monthly = totalScenarios(candidates, { ...settings, scenarioDays: 30 }, monthlyProfiles);
  const materials = new Set();
  for (const candidate of candidates) for (const row of procurement(candidate, settings.scenarioDays ?? 7)?.materials ?? []) materials.add(row.name);
  return {
    canAdopt: candidates.length === 4 && Boolean(weekly),
    recipes: candidates.map(candidate => ({ place: candidate.place, id: candidate.id, name: candidate.name, hours: candidate.hours })),
    conservativeWeekly: weekly?.conservativeWeekly ?? null, highWeekly: weekly?.highWeekly ?? null,
    conservativeMonthly: monthly?.conservativeMonthly ?? null, highMonthly: monthly?.highMonthly ?? null,
    materials: [...materials]
  };
}

export function adoptPlanSummary(summary, now = new Date()) {
  if (!summary?.canAdopt || summary.recipes?.length !== 4) throw new Error('这套方案数据还不完整，暂时不能采用。');
  return { version: 1, adoptedAt: now.toISOString(), recipes: summary.recipes.map(row => ({
    place: row.place, id: row.id, name: row.name, hours: row.hours
  })) };
}

function buildOpportunity(profile, pools, settings, currentBest, options = {}) {
  const coverageDays = options.coverageDays ?? settings.scenarioDays ?? 7;
  const target = finite(profile.tierThresholds?.[`days${coverageDays}`]);
  const resolvedTarget = finite(options.targetPrice ?? target);
  if ((!profile.volatile && !options.allowStable) || resolvedTarget == null) return null;
  const weeklyProfiles = overrideProfiles([{ ...profile, unitPrice: resolvedTarget }], coverageDays, coverageDays);
  const monthlyProfiles = overrideProfiles([{ ...profile, unitPrice: resolvedTarget }], 30, coverageDays);
  const candidates = bestPortfolio(pools, settings, weeklyProfiles, options.predicate);
  if (candidates.length !== 4) return null;
  let requiredPerAccount = 0;
  const usedBy = [];
  for (const candidate of candidates) {
    const material = procurement(candidate, coverageDays)?.materials.find(row => normalize(row.name) === profile.key);
    if (material) { requiredPerAccount += material.count; usedBy.push(candidate.name); }
  }
  if (!(requiredPerAccount > 0)) return null;
  const summary = summaryFor(candidates, settings, weeklyProfiles, monthlyProfiles);
  if (summary.conservativeWeekly == null) return null;
  return { key: profile.key, name: profile.name, currentPrice: profile.currentPrice, targetPrice: Math.min(profile.currentPrice, resolvedTarget),
    coverageDays, sampleCount: profile.sampleCount, priceSpreadPercent: profile.priceSpreadPercent,
    requiredPerAccount, estimatedCostPerAccount: requiredPerAccount * Math.min(profile.currentPrice, target),
    recipes: [...new Set(usedBy)], plan: summary,
    improvementWeekly: currentBest.conservativeWeekly == null ? null : summary.conservativeWeekly - currentBest.conservativeWeekly };
}

export function calculatePlan(data, settings, savedAdoption = null, savedStocked = null) {
  const adoption = validAdoption(savedAdoption);
  const stocked = validStockedMaterials(savedStocked);
  const pools = allowedPools(data, settings);
  const recipes = [], recommendations = [], proposalRecipes = [], proposedCandidates = [], activeCandidates = [], issues = [];
  for (const place of PLACES) {
    const rule = settings.stations[place];
    const candidates = pools[place];
    const adopted = adoption?.recipes.find(row=>row.place===place);
    const { main, backup } = chooseCandidate(candidates, rule.threshold, adopted?.id);
    const label = data.defaults?.placeRules?.[place]?.label ?? place;
    const current = adopted ? rankCandidates(data,settings,place,settings.techMode,true).find(row=>row.id===adopted.id) : main;
    let issue = null;
    if (adopted) {
      if (!current) issue = '已采用的“' + adopted.name + '”缺少完整行情，需重新选择';
      else if (!candidates.some(row=>row.id===current.id)) issue = '已采用配方不再符合设置，请确认下一轮方案';
      else if (current.currentProfit <= 0 || (current.scenario && current.scenario.conservativeWeekly <= 0)) issue = '已采用配方出现亏损，请确认下一轮方案';
      else if (!current.scenario) issue = '已采用配方情景数据不足，请等待数据更新或重新选择';
      if (issue) issues.push(`${label}：${issue}`);
    }
    const other = place === 'tech' ? chooseCandidate(rankCandidates(data, settings, place, settings.techMode === 'short' ? 'long' : 'short'), 0).main : null;
    const reason = adopted && main?.id === adopted.id ? `保持已采用配方；其他方案保守周利润未高出${rule.threshold}%`
      : main?.preferred && !adopted ? `常用配方优先；换配方门槛${rule.threshold}%` : '允许范围内按单号保守周利润比较';
    const proposalCard = recipeCard(main,backup,place,label,reason);
    const currentCard = recipeCard(current,backup,place,label,issue ?? (adoption ? '已采用方案；新建议须确认后才生效' : reason),
      other ? {...other,mode:settings.techMode==='short'?'长时枪械':'短时配件'} : null);
    if (adopted && current && main && main.id !== current.id) {
      currentCard.suggestion = {
        id: main.id, name: main.name, hours: main.hours,
        weeklyDifference: score(main) - score(current),
        increasePercent: score(current) > 0 ? (score(main) / score(current) - 1) * 100 : null
      };
    }
    proposalRecipes.push(proposalCard);
    recipes.push(currentCard);
    if (main) proposedCandidates.push(main);
    if (current) {
      activeCandidates.push(current);
      recommendations.push({ place, label, cashSelected: current, cashCandidates: candidates });
    }
  }
  const buyPlan = buildWeeklyBuyAdvice({ recommendations, historiesByMaterial: data.materialHistories ?? {},
    now: new Date(data.builtAt ?? data.generatedAt), budgetPerAccount: settings.budgetWan * 10_000,
    materialFilter: { minimumSamples: 336, maxWeeklyCostShare: settings.stableShare / 100, maxPriceSpread: settings.stableSpread / 100 },
    pricePercentiles: { days7: settings.buy7 / 100, days14: settings.buy14 / 100, days30: settings.buy30 / 100 }
  });
  const catalog = materialCatalog(pools, data, settings);
  const now = new Date(data.builtAt ?? data.generatedAt);
  const historiesByKey = new Map(Object.entries(data.materialHistories ?? {}).map(([name, rows]) => [normalize(name), rows]));
  const stabilityCatalog = catalog.map(row => ({ ...row, stability: materialStability(row.name, row.currentPrice,
    historiesByKey.get(row.key) ?? [], now) }));
  const productEvidence = new WeakMap();
  for (const candidate of Object.values(pools).flat()) productEvidence.set(candidate, productStability(candidate, settings, now));
  const stableProduct = candidate => productEvidence.get(candidate)?.stable === true;
  const currentStockProfiles = stockedProfiles(stocked, catalog, settings.scenarioDays ?? 7);
  const monthlyStockProfiles = stockedProfiles(stocked, catalog, 30);
  const current = totalScenarios(activeCandidates, settings, currentStockProfiles);
  const currentMonthly = totalScenarios(activeCandidates, { ...settings, scenarioDays: 30 }, monthlyStockProfiles);
  const target = totalScenarios(activeCandidates,settings,buyPlan.materials);
  const proposed = totalScenarios(proposedCandidates,settings);
  const currentPlan = summaryFor(activeCandidates, settings, currentStockProfiles, monthlyStockProfiles);
  const currentBestCandidates = bestPortfolio(pools, settings);
  const currentBest = summaryFor(currentBestCandidates, settings);
  const volatileProfiles = catalog.filter(row => row.volatile && finite(row.tierThresholds?.[`days${settings.scenarioDays}`]) != null);
  const lowWeeklyProfiles = overrideProfiles(volatileProfiles.map(row => ({ ...row,
    unitPrice: row.tierThresholds[`days${settings.scenarioDays}`] })), settings.scenarioDays, settings.scenarioDays);
  const lowMonthlyProfiles = overrideProfiles(volatileProfiles.map(row => ({ ...row,
    unitPrice: row.tierThresholds[`days${settings.scenarioDays}`] })), 30, settings.scenarioDays);
  const lowCandidates = bestPortfolio(pools, settings, lowWeeklyProfiles);
  const lowBest = summaryFor(lowCandidates, settings, lowWeeklyProfiles, lowMonthlyProfiles);
  const materialOpportunities = volatileProfiles.map(profile => buildOpportunity(profile, pools, settings, currentBest))
    .filter(Boolean).sort((a,b) => b.plan.conservativeWeekly - a.plan.conservativeWeekly || a.name.localeCompare(b.name, 'zh-CN'));
  const stableMaterials = stabilityCatalog.filter(row => row.stability.stable && finite(row.stability.targetPrice) != null);
  const stableRows = stableMaterials.map(row => ({ ...row, unitPrice: row.stability.targetPrice }));
  const stableWeeklyProfiles = overrideProfiles(stableRows, settings.scenarioDays ?? 7, settings.scenarioDays ?? 7);
  const stableMonthlyProfiles = overrideProfiles(stableRows, 30, settings.scenarioDays ?? 7);
  const stableCandidates = bestPortfolio(pools, settings, stableWeeklyProfiles, stableProduct);
  const stablePlan = summaryFor(stableCandidates, settings, stableWeeklyProfiles, stableMonthlyProfiles);
  const stableMaterialOpportunities = stableMaterials.map(profile => buildOpportunity(profile, pools, settings, currentBest, {
    coverageDays: 30, targetPrice: profile.stability.targetPrice, allowStable: true, predicate: stableProduct
  })).filter(Boolean).map(item => ({ ...item, stability: stableMaterials.find(row => row.key === item.key)?.stability }))
    .sort((a,b) => b.plan.conservativeMonthly - a.plan.conservativeMonthly || a.name.localeCompare(b.name, 'zh-CN'));

  const lazyBestCandidates = bestPortfolio(pools, settings, null, stableProduct);
  const lazyBest = summaryFor(lazyBestCandidates, settings);
  const lazyCurrentCandidates = [];
  const lazyRecommendedCandidates = [];
  const lazySuggestions = [];
  for (const place of PLACES) {
    const best = lazyBestCandidates.find(row => row.place === place);
    const adoptedId = adoption?.recipes.find(row => row.place === place)?.id;
    const currentCandidate = adoptedId == null ? null : (pools[place] ?? []).find(row => row.id === adoptedId);
    const currentEvidence = currentCandidate ? productEvidence.get(currentCandidate) : null;
    if (currentCandidate) lazyCurrentCandidates.push(currentCandidate);
    const validCurrent = currentCandidate && currentEvidence?.stable && currentCandidate.scenario?.conservativeWeekly > 0;
    const threshold = settings.lazySwitchThreshold / 100;
    const shouldSwitch = !validCurrent || (best && best.id !== currentCandidate.id
      && best.scenario?.conservativeWeekly > currentCandidate.scenario?.conservativeWeekly * (1 + threshold));
    if (shouldSwitch && best) {
      lazyRecommendedCandidates.push(best);
      lazySuggestions.push({ place, from: currentCandidate?.name ?? null, to: best.name, id: best.id,
        reason: validCurrent ? `保守月利润提升超过${settings.lazySwitchThreshold}%` : '当前配方不再满足稳定现买条件',
        increasePercent: validCurrent && currentCandidate.scenario?.conservativeWeekly > 0
          ? (best.scenario.conservativeWeekly / currentCandidate.scenario.conservativeWeekly - 1) * 100 : null });
    } else if (currentCandidate) lazyRecommendedCandidates.push(currentCandidate);
  }
  const lazyCurrent = summaryFor(lazyCurrentCandidates, settings);
  const lazyRecommended = summaryFor(lazyRecommendedCandidates, settings);
  const anomalousMaterials = stabilityCatalog.filter(row => row.stability.anomalous);
  const anomalousStableProducts = stableCandidates.filter(candidate => productEvidence.get(candidate)?.anomalous);
  const anomalyShare = stabilityCatalog.length ? anomalousMaterials.length / stabilityCatalog.length : 0;
  const marketRegime = {
    status: anomalyShare > 0.30 || anomalousStableProducts.length ? 'suspicious' : 'normal',
    materialAnomalyShare: anomalyShare, anomalousMaterials: anomalousMaterials.map(row => row.name),
    anomalousProducts: anomalousStableProducts.map(row => row.name), checkedAt: now.toISOString(),
    reason: anomalyShare > 0.30 ? `重点材料中${Math.round(anomalyShare * 100)}%出现近72小时异常` :
      anomalousStableProducts.length ? `稳定方案成品近72小时利润异常：${anomalousStableProducts.map(row => row.name).join('、')}` :
      '近72小时未发现足以暂停长期方案的集中异常'
  };
  const changes = proposalRecipes.filter(row => !adoption || adoption.recipes.find(old=>old.place===row.place)?.id !== row.id);
  const proposedBuy = buildWeeklyBuyAdvice({recommendations:proposedCandidates.map(row=>({place:row.place,cashSelected:row})), now:new Date(data.builtAt??data.generatedAt)});
  const materialNames = plan => plan.materials.filter(row=>!row.watchOnly).map(row=>row.name);
  const oldNames = materialNames(buyPlan), newNames = materialNames(proposedBuy);
  return { plan: { recipes, profit: {
    conservativeWeeklyPerAccount: current?.conservativeWeekly ?? null, conservativeDailyPerAccount: current?.conservativeDaily ?? null,
    conservativeMonthlyPerAccount: currentMonthly?.conservativeMonthly ?? null, highWeeklyPerAccount: current?.highWeekly ?? null,
    highMonthlyPerAccount: currentMonthly?.highMonthly ?? null,
    highDailyPerAccount: current ? current.highWeekly/7 : null, provisional: !current,
    basis: `${adoption?'已采用方案':'待确认方案预览'} · 本网站估算：最近${settings.historyDays}天同点原生利润加回成本，再扣现价买料成本。保守${settings.conservativePercentile}%、较高${settings.highPercentile}%分位。按${settings.scenarioDays}天完整采购摊销（含取整余料），实际收益取决于成交和收菜频率。${current?'':'情景数据待更新，不以原生历史利润代替。'}`,
    target, targetIncrease: current && target ? target.conservativeWeekly-current.conservativeWeekly : null
  }, preview: !adoption, issues, adoptedAt: adoption?.adoptedAt ?? null,
    comparisons: { current: currentPlan, currentBest, lowBest, stablePlan }, materialOpportunities, stableMaterialOpportunities,
    stablePlan, stabilityEvidence: {
      materials: stabilityCatalog.map(row => ({ name: row.name, ...row.stability })),
      products: Object.fromEntries(Object.entries(pools).map(([place, rows]) => [place, rows.map(row => ({ id: row.id, name: row.name, ...productEvidence.get(row) }))]))
    }, marketRegime,
    lazyPlan: { canEnable: lazyBest.canAdopt, best: lazyBest, current: lazyCurrent, recommended: lazyRecommended,
      suggestions: lazySuggestions, threshold: settings.lazySwitchThreshold,
      missingPlaces: PLACES.filter(place => !lazyBest.recipes.some(row => row.place === place)) },
    stockedMaterials: stocked.items.map(item => ({ ...item, currentPrice: catalog.find(row => row.key === item.key)?.currentPrice ?? null })) }, buyPlan,
    proposal: {recipes:proposalRecipes,changes,canAdopt:proposalRecipes.every(row=>!row.unavailable),
      needsConfirmation:!adoption || changes.length>0, weeklyProfit:proposed?.conservativeWeekly ?? null,
      weeklyDifference:proposed && current && adoption ? proposed.conservativeWeekly-current.conservativeWeekly : null,
      addedMaterials:newNames.filter(name=>!oldNames.includes(name)), removedMaterials:oldNames.filter(name=>!newNames.includes(name))},
    sell: { ...buildPortfolioSaleTiming(recommendations), undercutLevels: 1 } };
}

export function sortMaterials(rows) {
  const rank = item => item.action === 'buy' ? ({ 30: 0, 14: 1, 7: 2 }[item.tierDays] ?? 2) : item.action === 'wait' ? 3 : 4;
  return [...rows].sort((a, b) => rank(a) - rank(b) || (a.currentPrice / (a.targetPrice || 1) - b.currentPrice / (b.targetPrice || 1)) || a.name.localeCompare(b.name, 'zh-CN'));
}
