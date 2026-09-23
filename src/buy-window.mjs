import { combineHistories } from './market-history.mjs';
import { normalizeName } from './recommend.mjs';

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const NO_RELIABLE_WINDOW = '本周没有可靠的首选时段，达到好价就买';
const PLAN_VERSION = 'buy-v2-focus-materials';

/**
 * Builds one weekly shopping plan for the materials used by all selected stations.
 * `historiesByMaterial` is keyed by material display name; values are the rows
 * returned by fetchMaterialHistory. No network calls or mutable state occur here.
 */
export function buildWeeklyBuyAdvice({
  recommendations = [],
  historiesByMaterial = {},
  now = new Date(),
  budgetPerAccount = null,
  previousPlan = null,
  materialFilter = {}
} = {}) {
  const asOf = new Date(now);
  if (Number.isNaN(asOf.getTime())) throw new TypeError('now 必须是有效日期');

  const materialDemand = gatherMaterialDemand(recommendations);
  const weekStart = chinaWeekStart(asOf);
  const weekKey = chinaDateKey(weekStart);
  const recipeSignature = buildRecipeSignature(recommendations);
  const histories = new Map(Object.entries(historiesByMaterial).map(([name, rows]) => [
    normalizeName(name), Array.isArray(rows) ? rows : []
  ]));
  const totalExpectedCost7Days = materialDemand.every(material => Number.isFinite(material.currentPrice))
    ? materialDemand.reduce((sum, material) => sum + material.expectedPerAccount7Days * material.currentPrice, 0)
    : null;
  const materialProfiles = materialDemand.map(material => profileMaterial(
    material,
    histories.get(material.key) ?? [],
    asOf,
    totalExpectedCost7Days,
    materialFilter
  ));
  const focusDemand = materialProfiles.filter(profile => !profile.ignored).map(profile => profile.material);
  const basketMaterials = focusDemand.length > 0 ? focusDemand : materialDemand;
  const basketSeries = combineHistories(basketMaterials.map(material => ({
    name: material.name,
    count: material.expectedPerAccount7Days,
    rows: histories.get(material.key) ?? []
  })), asOf).filter(point => point.date <= asOf).sort((a, b) => a.date - b.date);
  const shoppingSeries = basketSeries.filter(point => point.date >= new Date(weekStart.getTime() - 3 * WEEK_MS)
    && point.date < weekStart);
  const historicalPlan = reusableWindowPlan(previousPlan, weekKey, recipeSignature)
    ?? rankWeeklyWindows(shoppingSeries, weekStart);

  const currentBasketCostPerAccount7Days = basketMaterials.length > 0
    && basketMaterials.every(material => Number.isFinite(material.currentPrice))
    ? basketMaterials.reduce((total, material) => total + material.expectedPerAccount7Days * material.currentPrice, 0)
    : null;
  const purchaseCostPerAccount7Days = purchaseCost(materialDemand, 7);
  const purchaseCostPerAccount14Days = purchaseCost(materialDemand, 14);
  const purchaseCostPerAccount30Days = purchaseCost(materialDemand, 30);
  const allBasketPrices = basketSeries.map(point => point.value).filter(Number.isFinite).sort((a, b) => a - b);
  const basketP15 = percentile(allBasketPrices, 0.15);
  const basketP05 = percentile(allBasketPrices, 0.05);
  const basketP30 = percentile(allBasketPrices, 0.30);
  const basketMedian = percentile(allBasketPrices, 0.50);
  const budget = positiveBudgetOrNull(budgetPerAccount);
  const primaryTypical = historicalPlan.primaryWindow?.typicalCostPerAccount7Days ?? null;
  const sufficientlyPriced = allBasketPrices.length >= 72;

  let nowAction = 'wait';
  let suggestedDays = 0;
  let nowReason = historicalPlan.status === 'ready'
    ? '整套材料还没有达到合适价格，先关注首选买料时段'
    : '整套材料还没有达到合适价格，达到好价再买';
  if (currentBasketCostPerAccount7Days === null) {
    nowAction = 'unknown';
    nowReason = '部分材料缺少当前价格，暂时无法判断现在是否值得囤';
  } else if (!sufficientlyPriced && primaryTypical === null) {
    nowAction = 'unknown';
    nowReason = '材料历史价格样本不足，暂时无法判断现在是否到了好价';
  } else if (sufficientlyPriced && currentBasketCostPerAccount7Days <= basketP05
      && currentBasketCostPerAccount7Days < basketMedian * 0.97) {
    nowAction = 'buy';
    suggestedDays = 30;
    nowReason = '整套材料已到最近30天极低价，建议一次买够一个月';
  } else if (sufficientlyPriced && currentBasketCostPerAccount7Days <= basketP15
      && currentBasketCostPerAccount7Days < basketMedian * 0.98) {
    nowAction = 'buy';
    suggestedDays = 14;
    nowReason = '整套材料比最近常见价格明显便宜，建议一次买够两周';
  } else if ((sufficientlyPriced && currentBasketCostPerAccount7Days <= basketP30
      && currentBasketCostPerAccount7Days < basketMedian * 0.99)
      || (primaryTypical !== null && currentBasketCostPerAccount7Days < primaryTypical)) {
    nowAction = 'buy';
    suggestedDays = 7;
    nowReason = primaryTypical !== null && currentBasketCostPerAccount7Days < primaryTypical
      ? '现在买齐比本周首选时段的历史常见成本还便宜，建议提前买够一周'
      : '整套材料已到最近的常见低价，建议买够一周';
  }

  let budgetGapPerAccount = null;
  if (nowAction === 'buy' && budget !== null) {
    if (suggestedDays === 30 && purchaseCostPerAccount30Days > budget) {
      if (purchaseCostPerAccount14Days <= budget) {
        suggestedDays = 14;
        nowReason += '；按你的单号预算，先买两周';
      } else if (purchaseCostPerAccount7Days <= budget) {
        suggestedDays = 7;
        nowReason += '；按你的单号预算，先买一周';
      }
    }
    if (suggestedDays === 14 && purchaseCostPerAccount14Days > budget
      && purchaseCostPerAccount7Days <= budget) {
      suggestedDays = 7;
      nowReason += '；按你的单号预算，先买一周';
    } else if (purchaseCostPerAccount7Days > budget) {
      nowAction = 'budget-shortfall';
      suggestedDays = 0;
      budgetGapPerAccount = purchaseCostPerAccount7Days - budget;
      nowReason = `价格值得买，但单号预算还差约${formatWan(budgetGapPerAccount)}，请自行决定买多少`;
    }
  }

  const materials = materialProfiles.map(profile => materialAdvice(profile));
  const ignoredMaterials = materials.filter(material => material.ignored);
  const estimatedPerAccountCost = suggestedDays === 30
    ? purchaseCostPerAccount30Days
    : suggestedDays === 14 ? purchaseCostPerAccount14Days
    : suggestedDays === 7 ? purchaseCostPerAccount7Days : null;

  return {
    status: historicalPlan.status,
    weekKey,
    recipeSignature,
    primaryWindow: historicalPlan.primaryWindow,
    backupWindow: historicalPlan.backupWindow,
    windowMessage: historicalPlan.windowMessage,
    nowAction,
    nowReason,
    suggestedDays,
    estimatedPerAccountCost,
    budgetGapPerAccount,
    currentBasketCostPerAccount7Days,
    purchaseCostPerAccount7Days,
    purchaseCostPerAccount14Days,
    purchaseCostPerAccount30Days,
    materials,
    ignoredMaterialsCount: ignoredMaterials.length,
    ignoredMaterialNames: ignoredMaterials.map(material => material.name),
    ignoredMaterialsCostPerAccount7Days: ignoredMaterials.reduce((sum, material) =>
      sum + Number(material.currentPrice ?? 0) * Number(material.perAccount7Days ?? 0), 0),
    evidence: historicalPlan.evidence
  };
}

export function materialNamesForSelectedRecipes(recommendations = []) {
  return gatherMaterialDemand(recommendations).map(material => material.name);
}

function gatherMaterialDemand(recommendations) {
  const materials = new Map();
  for (const item of recommendations) {
    const selected = item.cashSelected ?? item.selected;
    if (!selected) continue;
    const runs7 = plannedWeeklyRuns(item.place, Number(selected.hours));
    const runs14 = runs7 * 2;
    if (!(runs7 > 0)) continue;
    for (const ingredient of selected.recipe?.materials ?? []) {
      const name = String(ingredient.display_name || ingredient.name || '').trim();
      const key = normalizeName(name);
      const perRun = Number(ingredient.required_count);
      if (!key || !(perRun > 0)) continue;
      const currentPrice = Number(ingredient.current_price);
      const previous = materials.get(key) ?? {
        key, name, currentPrice: null,
        expectedPerAccount7Days: 0,
        perAccount7Days: 0,
        perAccount14Days: 0,
        perAccount30Days: 0
      };
      previous.expectedPerAccount7Days += perRun * runs7;
      previous.perAccount7Days += perRun * Math.ceil(runs7);
      previous.perAccount14Days += perRun * Math.ceil(runs14);
      previous.perAccount30Days += perRun * Math.ceil(runs7 * 30 / 7);
      if (Number.isFinite(currentPrice) && currentPrice > 0) previous.currentPrice = currentPrice;
      materials.set(key, previous);
    }
  }
  return [...materials.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
}

function plannedWeeklyRuns(place, hours) {
  if (place === 'tech') {
    if (hours === 16) return 9;
    if (hours === 24) return 6;
    return Number.isFinite(hours) && hours > 0 ? 168 / hours : 0;
  }
  if (['workbench', 'pharmacy', 'armory'].includes(place)) return 17.5;
  return Number.isFinite(hours) && hours > 0 ? 168 / hours : 0;
}

function buildRecipeSignature(recommendations) {
  const recipes = recommendations.map(item => {
    const selected = item.cashSelected ?? item.selected;
    if (!selected) return `${item.place}:none`;
    const materials = (selected.recipe?.materials ?? [])
      .map(material => `${normalizeName(material.display_name || material.name)}:${Number(material.required_count)}`)
      .sort().join(',');
    return `${item.place}:${selected.recipe?.id ?? normalizeName(selected.name)}:${selected.hours}:${materials}`;
  }).sort().join('|');
  return `${PLAN_VERSION}|${recipes}`;
}

function rankWeeklyWindows(series, weekStart) {
  const weeks = new Map();
  for (const point of series) {
    if (!(point.date instanceof Date) || !Number.isFinite(point.value)) continue;
    const key = chinaDateKey(chinaWeekStart(point.date));
    if (!weeks.has(key)) weeks.set(key, []);
    weeks.get(key).push(point);
  }
  const completeWeeks = [...weeks.entries()].filter(([, points]) => points.length >= 120);
  const evidence = {
    sampleCount: series.length,
    weekCount: completeWeeks.length,
    lookbackWeeks: 3,
    through: chinaDateKey(new Date(weekStart.getTime() - DAY_MS))
  };
  if (completeWeeks.length < 3) return insufficient(evidence);

  const slots = new Map();
  for (const [weekKey, points] of completeWeeks) {
    const weekMedian = median(points.map(point => point.value));
    const weekSlots = new Map();
    for (const point of points) {
      const parts = chinaParts(point.date);
      const startHour = Math.floor(parts.hour / 2) * 2;
      const slotKey = `${parts.weekday}-${startHour}`;
      if (!weekSlots.has(slotKey)) weekSlots.set(slotKey, []);
      weekSlots.get(slotKey).push(point.value);
    }
    for (const [slotKey, values] of weekSlots) {
      if (values.length < 2) continue;
      if (!slots.has(slotKey)) slots.set(slotKey, []);
      const slotCost = median(values);
      slots.get(slotKey).push({ weekKey, cost: slotCost, saving: 1 - slotCost / weekMedian });
    }
  }
  const candidates = [...slots.entries()].map(([key, samples]) => {
    const [weekday, startHour] = key.split('-').map(Number);
    const saving = median(samples.map(sample => sample.saving));
    const cheapWeeks = samples.filter(sample => sample.saving >= 0.015).length;
    return {
      weekday, startHour, samples, saving, cheapWeeks,
      typicalCost: median(samples.map(sample => sample.cost))
    };
  }).filter(candidate => candidate.samples.length === 3
    && candidate.cheapWeeks === 3
    && candidate.saving >= 0.025)
    .sort((a, b) => b.saving - a.saving || a.weekday - b.weekday || a.startHour - b.startHour);

  const primary = candidates[0];
  const backup = candidates.find(candidate => candidate.weekday !== primary?.weekday
    || Math.abs(candidate.startHour - primary.startHour) >= 4);
  if (!primary || !backup) return insufficient(evidence);

  return {
    status: 'ready',
    primaryWindow: describeWindow(primary, null),
    backupWindow: describeWindow(backup, primary),
    windowMessage: '按最近三个完整自然周的整套材料价格估算，本周首选和备选时段已固定',
    evidence
  };
}

function describeWindow(candidate, primary) {
  const startTime = `${String(candidate.startHour).padStart(2, '0')}:00`;
  const endTime = `${String(candidate.startHour + 2).padStart(2, '0')}:00`;
  const label = `${WEEKDAYS[candidate.weekday]} ${startTime}–${endTime}`;
  const savingPercent = round(candidate.saving * 100, 1);
  const reason = primary
    ? `最近3周，这段时间整套材料都比各周常见价格低约${savingPercent}%；若错过首选，可在这里买。与首选的历史成本相差约${round((candidate.typicalCost / primary.typicalCost - 1) * 100, 1)}%。`
    : `最近3周，这段时间整套材料都比各周常见价格低约${savingPercent}%，是重复出现的低价时段。`;
  return {
    label,
    weekday: WEEKDAYS[candidate.weekday],
    startTime,
    endTime,
    reason,
    typicalCostPerAccount7Days: round(candidate.typicalCost),
    savingPercent,
    observedWeeks: candidate.samples.length
  };
}

function insufficient(evidence) {
  return {
    status: 'insufficient',
    primaryWindow: null,
    backupWindow: null,
    windowMessage: NO_RELIABLE_WINDOW,
    evidence
  };
}

function reusableWindowPlan(previousPlan, weekKey, recipeSignature) {
  if (previousPlan?.weekKey !== weekKey || previousPlan?.recipeSignature !== recipeSignature) return null;
  if (previousPlan.status !== 'ready' && previousPlan.status !== 'insufficient') return null;
  return {
    status: previousPlan.status,
    primaryWindow: previousPlan.primaryWindow ?? null,
    backupWindow: previousPlan.backupWindow ?? null,
    windowMessage: previousPlan.windowMessage ?? NO_RELIABLE_WINDOW,
    evidence: previousPlan.evidence ?? { sampleCount: 0, weekCount: 0, lookbackWeeks: 3 }
  };
}

function profileMaterial(material, rows, now, totalExpectedCost7Days, options = {}) {
  const points = combineHistories([{ count: 1, rows }], now)
    .filter(point => point.date >= new Date(now.getTime() - 30 * DAY_MS) && point.date <= now);
  const values = points.map(point => point.value).filter(Number.isFinite).sort((a, b) => a - b);
  const minimumSamples = Number(options.minimumSamples ?? 336);
  const maxWeeklyCostShare = Number(options.maxWeeklyCostShare ?? 0.03);
  const maxPriceSpread = Number(options.maxPriceSpread ?? 0.08);
  const medianPrice = values.length >= minimumSamples ? percentile(values, 0.50) : null;
  const p10 = values.length >= minimumSamples ? percentile(values, 0.10) : null;
  const p90 = values.length >= minimumSamples ? percentile(values, 0.90) : null;
  const priceSpread = medianPrice > 0 ? (p90 - p10) / medianPrice : null;
  const weeklyCostShare = totalExpectedCost7Days > 0 && Number.isFinite(material.currentPrice)
    ? material.expectedPerAccount7Days * material.currentPrice / totalExpectedCost7Days
    : null;
  const ignored = values.length >= minimumSamples
    && weeklyCostShare !== null && weeklyCostShare <= maxWeeklyCostShare
    && priceSpread !== null && priceSpread <= maxPriceSpread;
  return { material, values, weeklyCostShare, priceSpread, ignored };
}

function materialAdvice(profile) {
  const { material, values, weeklyCostShare, priceSpread, ignored } = profile;
  const lowPrice = values.length >= 72 ? percentile(values, 0.30) : null;
  const targetPrice = lowPrice;
  let action = ignored ? 'ignored' : 'unknown';
  let reason = ignored
    ? '单号一周成本占比很低且价格稳定，不作为重点统计'
    : '历史价格样本不足，暂时没有可靠的买入价';
  if (!ignored && targetPrice !== null && Number.isFinite(material.currentPrice)) {
    action = material.currentPrice <= targetPrice ? 'buy' : 'wait';
    reason = action === 'buy'
      ? `现价已到建议买入价，可先买这项材料`
      : `现价还高于建议买入价，适合继续等`;
  }
  return {
    name: material.name,
    currentPrice: material.currentPrice,
    targetPrice: targetPrice === null ? null : round(targetPrice),
    perAccount7Days: material.perAccount7Days,
    perAccount14Days: material.perAccount14Days,
    perAccount30Days: material.perAccount30Days,
    sampleCount: values.length,
    weeklyCostSharePercent: weeklyCostShare === null ? null : round(weeklyCostShare * 100, 2),
    priceSpreadPercent: priceSpread === null ? null : round(priceSpread * 100, 1),
    ignored,
    action,
    reason
  };
}

function purchaseCost(materials, days) {
  if (materials.length === 0 || materials.some(material => !Number.isFinite(material.currentPrice))) return null;
  return materials.reduce((total, material) => total
    + material.currentPrice * (days === 30
      ? material.perAccount30Days
      : days === 14 ? material.perAccount14Days : material.perAccount7Days), 0);
}

function positiveBudgetOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const budget = Number(value);
  return Number.isFinite(budget) && budget > 0 ? budget : null;
}

function chinaWeekStart(date) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const weekday = shifted.getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(),
    shifted.getUTCDate() - daysSinceMonday) - 8 * 60 * 60 * 1000);
}

function chinaParts(date) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return { weekday: shifted.getUTCDay(), hour: shifted.getUTCHours() };
}

function chinaDateKey(date) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function percentile(sortedValues, probability) {
  if (!sortedValues.length) return null;
  const index = (sortedValues.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
}

function median(values) {
  return percentile([...values].sort((a, b) => a - b), 0.5);
}

function round(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatWan(value) {
  return `${round(value / 10_000, 1)}万哈夫币`;
}
