import { buildWeeklyBuyAdvice } from './engine/buy-window.mjs';
import { buildPortfolioSaleTiming } from './engine/weekend-prices.mjs';
import { profitScenario, totalScenarios } from './scenarios.js';

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
    version: 5, accounts, sharedAccounts: Math.floor(bounded(saved.sharedAccounts, defaults.sharedAccounts ?? 10, 0, accounts)),
    scenarioDays: [7,14,30].includes(Number(saved.scenarioDays)) ? Number(saved.scenarioDays) : 7,
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
      const runsPerWeek = Math.min(168 / item.hours, place === 'tech' ? rule.runsByHours[item.hours] ?? 17.5 : rule.weeklyRuns);
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
export function validAdoption(record) {
  if (record?.version !== 1 || !Number.isFinite(Date.parse(record.adoptedAt)) || !Array.isArray(record.recipes) || record.recipes.length !== 4) return null;
  if (!PLACES.every(place => record.recipes.filter(row=>row.place===place && Number.isInteger(row.id) && row.id>0).length === 1)) return null;
  return record;
}
export function adoptProposal(proposal, now = new Date()) {
  if (!proposal.canAdopt) throw new Error('四台建议尚未齐全，暂不能采用。');
  return { version: 1, adoptedAt: now.toISOString(), recipes: proposal.recipes.map(row=>({place:row.place,id:row.id,name:row.main,hours:row.hours})) };
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

export function calculatePlan(data, settings, savedAdoption = null) {
  const adoption = validAdoption(savedAdoption);
  const recipes = [], recommendations = [], proposalRecipes = [], proposedCandidates = [], activeCandidates = [], issues = [];
  for (const place of PLACES) {
    const rule = settings.stations[place];
    const candidates = rankCandidates(data, settings, place);
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
    proposalRecipes.push(recipeCard(main,backup,place,label,reason));
    recipes.push(recipeCard(current,backup,place,label,issue ?? (adoption ? '已采用方案；新建议须确认后才生效' : reason),
      other ? {...other,mode:settings.techMode==='short'?'长时枪械':'短时配件'} : null));
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
  const current = totalScenarios(activeCandidates,settings);
  const target = totalScenarios(activeCandidates,settings,buyPlan.materials);
  const proposed = totalScenarios(proposedCandidates,settings);
  const changes = proposalRecipes.filter(row => !adoption || adoption.recipes.find(old=>old.place===row.place)?.id !== row.id);
  const proposedBuy = buildWeeklyBuyAdvice({recommendations:proposedCandidates.map(row=>({place:row.place,cashSelected:row})), now:new Date(data.builtAt??data.generatedAt)});
  const materialNames = plan => plan.materials.filter(row=>!row.watchOnly).map(row=>row.name);
  const oldNames = materialNames(buyPlan), newNames = materialNames(proposedBuy);
  return { plan: { recipes, profit: {
    conservativeWeeklyPerAccount: current?.conservativeWeekly ?? null, conservativeDailyPerAccount: current?.conservativeDaily ?? null,
    conservativeMonthlyPerAccount: current?.conservativeMonthly ?? null, highWeeklyPerAccount: current?.highWeekly ?? null,
    highDailyPerAccount: current ? current.highWeekly/7 : null, provisional: !current,
    basis: `${adoption?'已采用方案':'待确认方案预览'} · 本网站估算：最近${settings.historyDays}天同点原生利润加回成本，再扣现价买料成本。保守${settings.conservativePercentile}%、较高${settings.highPercentile}%分位。按${settings.scenarioDays}天完整采购摊销（含取整余料），实际收益取决于成交和收菜频率。${current?'':'情景数据待更新，不以原生历史利润代替。'}`,
    target, targetIncrease: current && target ? target.conservativeWeekly-current.conservativeWeekly : null
  }, preview: !adoption, issues, adoptedAt: adoption?.adoptedAt ?? null }, buyPlan,
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
