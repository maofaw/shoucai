import { fetchMaterialHistory } from './market-history.mjs';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export function analyzeWeekendSaleHistory(rows, options = {}) {
  const now = options.now ?? new Date();
  const lookbackWeeks = Number(options.lookbackWeeks ?? 4);
  const lowerPercentile = Number(options.lowerPercentile ?? 0.25);
  const higherPercentile = Number(options.higherPercentile ?? 0.75);
  const cutoff = now.getTime() - (lookbackWeeks * 7 + 1) * DAY_MS;
  const points = (rows ?? []).map(row => {
    const date = parseChinaMarketTime(row.time, now);
    const price = Number(row.avg ?? row.last);
    return { date, price };
  }).filter(point => Number.isFinite(point.price)
    && point.price > 0
    && point.date.getTime() >= cutoff
    && point.date.getTime() <= now.getTime()
    && isChinaWeekend(point.date));
  const prices = points.map(point => point.price).sort((a, b) => a - b);
  const observedWeeks = new Set(points.map(point => chinaWeekKey(point.date))).size;
  const minimumWeeks = Number(options.minimumWeeks ?? 3);
  const minimumSamples = Number(options.minimumSamples ?? 12);
  const ready = observedWeeks >= minimumWeeks && prices.length >= minimumSamples;
  const windowHours = Number(options.windowHours ?? 2);
  const minStartHour = Number(options.minStartHour ?? 9);
  const maxStartHour = Number(options.maxStartHour ?? 22);
  const saleWindows = ready
    ? buildSaleWindows(points, {
        overallConservativePrice: percentile(prices, lowerPercentile),
        overallMedianPrice: percentile(prices, 0.5),
        lowerPercentile,
        minimumWeeks,
        windowHours,
        minStartHour,
        maxStartHour
      })
    : [];

  return {
    ready,
    source: 'Moligod 每小时历史行情（周六、周日）',
    sampleCount: prices.length,
    observedWeeks,
    lookbackWeeks,
    conservativePrice: ready ? percentile(prices, lowerPercentile) : null,
    highPrice: ready ? percentile(prices, higherPercentile) : null,
    medianPrice: ready ? percentile(prices, 0.5) : null,
    lowerPercentile,
    higherPercentile,
    windowHours,
    saleWindows
  };
}

export function saleScenariosForCandidate(candidate, historyAnalysis) {
  const recipe = candidate.recipe;
  const outputCount = Number(recipe.per_count ?? recipe.output_count ?? 0)
    || Number(candidate.revenue) / Number(recipe.output_current_price);
  const feeRate = Number.isFinite(Number(recipe.fee_rate))
    ? Number(recipe.fee_rate)
    : Number(candidate.fee) / Number(candidate.revenue);
  const usableUnit = Number.isFinite(outputCount) && outputCount > 0;
  const usableFee = Number.isFinite(feeRate) && feeRate >= 0 && feeRate < 1;
  const evidenced = Boolean(historyAnalysis?.ready && usableUnit && usableFee);
  const conservativeRevenue = evidenced
    ? historyAnalysis.conservativePrice * outputCount
    : Number(candidate.revenue);
  const highRevenue = evidenced
    ? historyAnalysis.highPrice * outputCount
    : Number(candidate.revenue);
  const conservativeFee = evidenced
    ? conservativeRevenue * feeRate
    : Number(candidate.fee);
  const highFee = evidenced
    ? highRevenue * feeRate
    : Number(candidate.fee);
  const materialCost = Number(candidate.currentCost);
  const conservativeProfit = conservativeRevenue - conservativeFee - materialCost;
  const highProfit = highRevenue - highFee - materialCost;
  return {
    ...candidate,
    conservativeRevenue,
    highRevenue,
    conservativeFee,
    highFee,
    conservativeProfit,
    highProfit,
    conservativeWeeklyProfit: conservativeProfit * candidate.runsPerWeek,
    highWeeklyProfit: highProfit * candidate.runsPerWeek,
    priceEvidence: {
      source: evidenced ? historyAnalysis.source : 'Moligod 当前配方快照',
      provisional: !evidenced,
      sampleCount: historyAnalysis?.sampleCount ?? 0,
      observedWeeks: historyAnalysis?.observedWeeks ?? 0,
      lookbackWeeks: historyAnalysis?.lookbackWeeks ?? 4,
      conservativeUnitPrice: evidenced ? historyAnalysis.conservativePrice : null,
      highUnitPrice: evidenced ? historyAnalysis.highPrice : null,
      currentUnitPrice: Number(recipe.output_current_price) || (usableUnit ? candidate.revenue / outputCount : null),
      lowerPercentile: historyAnalysis?.lowerPercentile ?? 0.25,
      higherPercentile: historyAnalysis?.higherPercentile ?? 0.75,
      saleWindows: evidenced ? historyAnalysis.saleWindows ?? [] : []
    }
  };
}

export function buildPortfolioSaleTiming(recommendations, config = {}) {
  const dashboard = config.dashboard ?? config;
  const selected = (recommendations ?? [])
    .map(item => item.cashSelected ?? item.selected)
    .filter(Boolean);
  const totalRecipes = selected.length;
  const minimumCoverageRatio = Number(dashboard.weekendSellMinimumCoverage ?? 0.75);
  const minimumCoveredRecipes = totalRecipes
    ? Math.max(1, Math.ceil(totalRecipes * minimumCoverageRatio))
    : 0;
  const byKey = new Map();

  for (const candidate of selected) {
    const windows = candidate.priceEvidence?.saleWindows ?? [];
    const weight = Math.max(1, Number(candidate.conservativeRevenue ?? candidate.revenue ?? 1)
      * Number(candidate.runsPerWeek ?? 1));
    for (const window of windows) {
      if (!window.ready) continue;
      const current = byKey.get(window.key) ?? {
        ...window,
        weightedScore: 0,
        weight: 0,
        sampleCount: 0,
        observedWeeks: Infinity,
        coveredRecipes: 0
      };
      current.weightedScore += Number(window.score) * weight;
      current.weight += weight;
      current.sampleCount += Number(window.sampleCount ?? 0);
      current.observedWeeks = Math.min(current.observedWeeks, Number(window.observedWeeks ?? 0));
      current.coveredRecipes += 1;
      byKey.set(window.key, current);
    }
  }

  const ranked = [...byKey.values()]
    .filter(window => window.coveredRecipes >= minimumCoveredRecipes)
    .map(window => ({
      ...window,
      score: window.weight ? window.weightedScore / window.weight : 0,
      liftPercent: window.weight ? (window.weightedScore / window.weight - 1) * 100 : null
    }))
    .sort((a, b) => b.score - a.score
      || b.coveredRecipes - a.coveredRecipes
      || b.observedWeeks - a.observedWeeks);
  const primary = ranked[0] ?? null;
  const backup = primary
    ? ranked.find(window => window.weekday !== primary.weekday
      || Math.abs(window.startHour - primary.startHour) >= Number(window.windowHours ?? 2)) ?? null
    : null;
  const ready = Boolean(primary && totalRecipes > 0);
  const highConfidence = ready
    && primary.coveredRecipes === totalRecipes
    && primary.observedWeeks >= Number(dashboard.weekendLookbackWeeks ?? 4);

  if (!ready) {
    return {
      ready: false,
      preferredWeekday: '周六',
      preferredStartTime: '21:30',
      preferredEndTime: null,
      preferredWindow: '周六 21:30',
      backupWindow: null,
      confidence: '样本不足',
      sampleCount: 0,
      observedWeeks: 0,
      coveredRecipes: 0,
      totalRecipes,
      basis: '周末历史样本还不足，暂时沿用你的习惯：周六21:30集中出售'
    };
  }

  const coverageText = `覆盖${primary.coveredRecipes}/${totalRecipes}个制造台、${primary.observedWeeks}个周末、${primary.sampleCount}条小时行情`;
  const liftText = Math.abs(primary.liftPercent) < 0.5
    ? '与周末平均价基本持平，但稳定性最好'
    : primary.liftPercent > 0
      ? `综合保守价比各成品周末平均约高${primary.liftPercent.toFixed(1)}%`
      : '这是当前可操作时段里综合最稳的窗口';
  return {
    ready: true,
    preferredWeekday: primary.weekdayLabel,
    preferredStartTime: formatHour(primary.startHour),
    preferredEndTime: formatHour(primary.endHour),
    preferredWindow: formatSaleWindow(primary),
    backupWindow: backup ? formatSaleWindow(backup) : null,
    confidence: highConfidence ? '高' : '中',
    sampleCount: primary.sampleCount,
    observedWeeks: primary.observedWeeks,
    coveredRecipes: primary.coveredRecipes,
    totalRecipes,
    liftPercent: round(primary.liftPercent, 1),
    basis: `按最近${Number(dashboard.weekendLookbackWeeks ?? 4)}个周末比较连续${primary.windowHours}小时售价；${coverageText}。${liftText}`
  };
}

export function chooseByConservativeProfit(candidates, preferred, switchThreshold = 0.05, options = {}) {
  const ordered = [...candidates].sort((a, b) => b.conservativeWeeklyProfit - a.conservativeWeeklyProfit);
  const best = ordered[0] ?? null;
  if (!best || best.conservativeWeeklyProfit <= 0) {
    return { selected: null, best, candidates: ordered, reason: '当前没有正利润配方，建议暂缓开工' };
  }
  const baseline = preferred ? ordered.find(candidate => candidate.recipe.id === preferred.recipe.id) : null;
  if (!baseline || baseline.recipe.id === best.recipe.id) {
    return {
      selected: best,
      best,
      candidates: ordered,
      reason: baseline ? '常用配方的保守周利润仍然领先' : '保守周利润最高'
    };
  }
  if (baseline.conservativeWeeklyProfit <= 0) {
    return { selected: best, best, candidates: ordered, reason: '常用配方目前亏损，下一轮改造正利润配方' };
  }

  let threshold = Number(switchThreshold);
  const baselineWeekendPrice = baseline.priceEvidence?.conservativeUnitPrice;
  const baselineCurrentPrice = baseline.priceEvidence?.currentUnitPrice;
  if (options.place === 'armory'
    && Number.isFinite(baselineWeekendPrice)
    && Number.isFinite(baselineCurrentPrice)
    && baselineWeekendPrice < baselineCurrentPrice * (1 - Number(options.weakeningThreshold ?? 0.1))) {
    threshold = 0.05;
  }
  const improvement = best.conservativeWeeklyProfit / baseline.conservativeWeeklyProfit - 1;
  if (improvement <= threshold) {
    return {
      selected: baseline,
      best,
      candidates: ordered,
      reason: `其他配方的保守周利润没有高出${Math.round(threshold * 100)}%，继续造常用配方`
    };
  }
  return {
    selected: best,
    best,
    candidates: ordered,
    reason: `保守周利润比常用配方高${(improvement * 100).toFixed(1)}%，下一轮建议换`
  };
}

export async function enrichRecommendationsWithWeekendPrices(recommendations, config, options = {}) {
  const now = options.now ?? new Date();
  const fetchHistory = options.fetchHistory ?? fetchMaterialHistory;
  const historyCache = new Map();
  const candidateLimit = Number(config.dashboard?.weekendCandidateLimit ?? 6);
  const historyOptions = {
    limit: Number(config.dashboard?.weekendHistoryLimit ?? 900),
    attempts: 2,
    timeoutMs: 15_000,
    ...options.historyOptions
  };
  const results = [];

  for (const item of recommendations) {
    const rule = config.placeRules?.[item.place] ?? {};
    const allCandidates = item.cashCandidates ?? item.candidates ?? [];
    const preferred = item.cashPreferred ?? item.preferred;
    const shortlist = allCandidates.slice(0, candidateLimit);
    if (preferred && !shortlist.some(candidate => candidate.recipe.id === preferred.recipe.id)) shortlist.push(preferred);
    if (!shortlist.length) {
      results.push(item);
      continue;
    }
    const scenarios = await Promise.all(shortlist.map(async candidate => {
      const name = candidate.name;
      if (!historyCache.has(name)) {
        historyCache.set(name, Promise.resolve()
          .then(() => fetchHistory(name, historyOptions))
          .then(rows => analyzeWeekendSaleHistory(rows, {
            now,
            lookbackWeeks: Number(config.dashboard?.weekendLookbackWeeks ?? 4),
            lowerPercentile: Number(config.dashboard?.weekendConservativePercentile ?? 0.25),
            higherPercentile: Number(config.dashboard?.weekendHighPercentile ?? 0.75),
            minimumWeeks: Number(config.dashboard?.weekendSellMinimumWeeks ?? 3),
            windowHours: Number(config.dashboard?.weekendSellWindowHours ?? 2),
            minStartHour: Number(config.dashboard?.weekendSellMinHour ?? 9),
            maxStartHour: Number(config.dashboard?.weekendSellMaxHour ?? 22)
          }))
          .catch(() => null));
      }
      return saleScenariosForCandidate(candidate, await historyCache.get(name));
    }));
    const choice = chooseByConservativeProfit(scenarios, preferred,
      Number(rule.switchThreshold ?? config.switchThreshold ?? 0.05),
      { place: item.place, weakeningThreshold: rule.weakeningThreshold });
    const selected = choice.selected;
    results.push({
      ...item,
      selected,
      cashSelected: selected,
      candidates: choice.candidates,
      cashCandidates: choice.candidates,
      best: choice.best,
      reason: choice.reason,
      cashReason: choice.reason
    });
  }
  return results;
}

function parseChinaMarketTime(value, now) {
  const match = /^(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(String(value));
  if (!match) return new Date(NaN);
  const [, month, day, hour, minute] = match;
  const currentYear = new Date(now.getTime() + 8 * HOUR_MS).getUTCFullYear();
  let date = new Date(`${currentYear}-${month}-${day}T${hour}:${minute}:00+08:00`);
  if (date.getTime() > now.getTime() + DAY_MS) {
    date = new Date(`${currentYear - 1}-${month}-${day}T${hour}:${minute}:00+08:00`);
  }
  return date;
}

function isChinaWeekend(date) {
  const shifted = new Date(date.getTime() + 8 * HOUR_MS);
  return shifted.getUTCDay() === 0 || shifted.getUTCDay() === 6;
}

function chinaWeekKey(date) {
  const shifted = new Date(date.getTime() + 8 * HOUR_MS);
  const weekday = shifted.getUTCDay();
  shifted.setUTCHours(0, 0, 0, 0);
  shifted.setUTCDate(shifted.getUTCDate() - ((weekday + 6) % 7));
  return shifted.toISOString().slice(0, 10);
}

function buildSaleWindows(points, options) {
  const results = [];
  for (const weekday of [6, 0]) {
    for (let startHour = options.minStartHour; startHour <= options.maxStartHour; startHour += 1) {
      const endHour = startHour + options.windowHours;
      if (endHour > 24) continue;
      const windowPoints = points.filter(point => {
        const parts = chinaParts(point.date);
        return parts.weekday === weekday && parts.hour >= startHour && parts.hour < endHour;
      });
      const prices = windowPoints.map(point => point.price).sort((a, b) => a - b);
      const observedWeeks = new Set(windowPoints.map(point => chinaWeekKey(point.date))).size;
      const minimumSamples = options.minimumWeeks * options.windowHours;
      const ready = observedWeeks >= options.minimumWeeks && prices.length >= minimumSamples;
      if (!ready) continue;
      const conservativePrice = percentile(prices, options.lowerPercentile);
      const medianPrice = percentile(prices, 0.5);
      const conservativeRatio = options.overallConservativePrice > 0
        ? conservativePrice / options.overallConservativePrice
        : 1;
      const medianRatio = options.overallMedianPrice > 0
        ? medianPrice / options.overallMedianPrice
        : 1;
      results.push({
        key: `${weekday}-${startHour}`,
        weekday,
        weekdayLabel: weekday === 6 ? '周六' : '周日',
        startHour,
        endHour,
        windowHours: options.windowHours,
        ready,
        sampleCount: prices.length,
        observedWeeks,
        conservativePrice,
        medianPrice,
        score: conservativeRatio * 0.7 + medianRatio * 0.3
      });
    }
  }
  return results.sort((a, b) => b.score - a.score);
}

function chinaParts(date) {
  const shifted = new Date(date.getTime() + 8 * HOUR_MS);
  return { weekday: shifted.getUTCDay(), hour: shifted.getUTCHours() };
}

function formatSaleWindow(window) {
  return `${window.weekdayLabel} ${formatHour(window.startHour)}–${formatHour(window.endHour)}`;
}

function formatHour(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

function round(value, digits = 0) {
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function percentile(sortedValues, probability) {
  if (!sortedValues.length) return null;
  const index = (sortedValues.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * (index - lower);
}
