const PLACE_ORDER = ['workbench', 'tech', 'pharmacy', 'armory'];

export function normalizeName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s·×*]/g, '')
    .replace(/[（）()]/g, '');
}

function displayName(recipe) {
  return String(recipe.output_display_name || recipe.output_name || '未知产物');
}

function isPreferred(recipe, rule) {
  const target = normalizeName(displayName(recipe));
  return (rule.preferredNames ?? []).some(name => target === normalizeName(name));
}

function hasCompletePrice(recipe) {
  return Number(recipe.missing_price_count ?? 0) === 0
    && Number.isFinite(Number(recipe.estimated_profit))
    && Number.isFinite(Number(recipe.estimated_material_cost));
}

export function recipeMetrics(recipe, rule = {}) {
  const hours = Number(recipe.period_hours);
  const currentCost = Number(recipe.estimated_material_cost);
  const revenue = Number(recipe.estimated_revenue);
  const fee = Number(recipe.estimated_fee);
  const websiteProfit = Number(recipe.estimated_profit);
  const preferred = isPreferred(recipe, rule);
  const historical = rule.historicalStock;
  const useHistoricalCost = Boolean(preferred && historical?.enabled);
  const effectiveMaterialCost = useHistoricalCost
    ? Number(historical.materialCostPerRun)
    : currentCost;
  const effectiveProfit = useHistoricalCost
    ? revenue - fee - effectiveMaterialCost
    : websiteProfit;
  const runsPerDay = 24 / hours;
  const runsPerWeek = weeklyRunsFor(rule, hours);

  return {
    recipe,
    name: displayName(recipe),
    hours,
    currentCost,
    revenue,
    fee,
    websiteProfit,
    effectiveMaterialCost,
    effectiveProfit,
    runsPerWeek,
    dailyProfit: effectiveProfit * runsPerDay,
    weeklyProfit: effectiveProfit * runsPerWeek,
    dailyCurrentMaterialCost: currentCost * runsPerDay,
    weeklyCurrentMaterialCost: currentCost * runsPerWeek,
    capitalReturn: effectiveMaterialCost > 0 ? effectiveProfit / effectiveMaterialCost : null,
    preferred,
    useHistoricalCost
  };
}

export function chooseRecipe(recipes, rule, switchThreshold = 0.05) {
  const allowed = new Set((rule.allowedHours ?? []).map(Number));
  const candidates = recipes
    .filter(recipe => recipe.place === rule.place)
    .filter(hasCompletePrice)
    .filter(recipe => allowed.size === 0 || allowed.has(Number(recipe.period_hours)))
    .map(recipe => recipeMetrics(recipe, rule))
    .sort((a, b) => b.weeklyProfit - a.weeklyProfit);

  if (candidates.length === 0) return { selected: null, best: null, preferred: null, candidates };

  const best = candidates[0];
  const preferred = candidates.find(candidate => candidate.preferred) ?? null;
  let selected = best;
  let reason = '允许时长内整周预计净利润最高';

  if (preferred && best.name !== preferred.name) {
    const preferredIsLoss = preferred.weeklyProfit <= 0;
    const required = preferred.weeklyProfit * (1 + switchThreshold);
    if (!preferredIsLoss && best.weeklyProfit < required) {
      selected = preferred;
      reason = `其他配方未比常用配方高出${Math.round(switchThreshold * 100)}%`;
    } else if (preferredIsLoss) {
      reason = `常用配方按当前材料价亏损，切换到正利润配方`;
    } else {
      reason = `比常用配方的整周预计净利润高出${formatPercent(best.weeklyProfit / preferred.weeklyProfit - 1)}`;
    }
  } else if (preferred) {
    reason = preferred.useHistoricalCost
      ? '按旧低价库存成本计算后最优'
      : '常用配方当前仍是最优或接近最优';
  }

  return { selected, best, preferred, candidates, reason };
}

export function buildRecommendations(snapshot, config, historyProvider = () => []) {
  const results = [];
  for (const place of PLACE_ORDER) {
    const sourceRule = config.placeRules[place];
    if (!sourceRule) continue;
    const rule = { ...sourceRule, place };
    const switchThreshold = Number(sourceRule.switchThreshold ?? config.switchThreshold ?? 0.05);
    const choice = chooseRecipe(snapshot.recipes, rule, switchThreshold);
    if (!choice.selected) {
      results.push({ place, label: rule.label, ...choice, buy: { action: 'error', reason: '没有符合条件且价格完整的配方' } });
      continue;
    }
    const cashRule = {
      ...rule,
      historicalStock: rule.historicalStock
        ? { ...rule.historicalStock, enabled: false }
        : undefined
    };
    const cashChoice = chooseRecipe(snapshot.recipes, cashRule, switchThreshold);
    const history = historyProvider(choice.selected.recipe.id);
    const buy = evaluateBuy(choice.selected, history, config, rule);
    const cashHistory = cashChoice.selected
      ? historyProvider(cashChoice.selected.recipe.id)
      : [];
    const cashBuy = cashChoice.selected
      ? evaluateBuy(cashChoice.selected, cashHistory, config, cashRule)
      : buy;
    results.push({
      place,
      label: rule.label,
      ...choice,
      buy,
      cashSelected: cashChoice.selected,
      cashReason: cashChoice.reason,
      cashBuy
    });
  }
  return results;
}

export function evaluateBuy(selected, history, config, rule) {
  if (selected.useHistoricalCost) {
    return {
      action: 'use-stock',
      days: 0,
      reason: '继续使用旧低价库存，暂不购买当前高价材料',
      history: historyStats(history)
    };
  }

  const manual = findManualThreshold(selected, config.manualBuyThresholds ?? {});
  if (manual) {
    const totalOk = selected.currentCost <= Number(manual.totalCost);
    const materialChecks = Object.entries(manual.materials ?? {}).map(([name, threshold]) => {
      const material = (selected.recipe.materials ?? []).find(item => normalizeName(item.display_name || item.name) === normalizeName(name));
      return {
        name,
        threshold: Number(threshold),
        price: material ? Number(material.current_price) : null,
        ok: material ? Number(material.current_price) <= Number(threshold) : false
      };
    });
    if (totalOk && materialChecks.every(item => item.ok)) {
      return { action: 'buy', days: 14, reason: '达到人工验证的低价观察线', manual: { totalOk, materialChecks }, history: historyStats(history) };
    }
  }

  const stats = historyStats(history);
  const ready = stats.count >= config.history.minimumSamples
    && stats.spanHours >= config.history.minimumSpanHours;
  if (!ready) {
    return {
      action: 'small-buy',
      days: 1,
      reason: `本地历史样本不足（${stats.count}条，跨度${stats.spanHours.toFixed(1)}小时），只补1天，不大囤`,
      history: stats,
      manual
    };
  }

  if (selected.currentCost <= stats.p15) {
    return { action: 'buy', days: 14, reason: '材料成本处于本地历史约15%低位', history: stats, manual };
  }
  if (selected.currentCost <= stats.p30) {
    return { action: 'buy', days: 7, reason: '材料成本处于本地历史约30%低位', history: stats, manual };
  }
  return { action: 'wait', days: 1, reason: '材料未进入低价区，仅按生产需要补1天', history: stats, manual };
}

function findManualThreshold(selected, thresholds) {
  const target = normalizeName(selected.name);
  for (const [name, value] of Object.entries(thresholds)) {
    if (normalizeName(name) === target) return value;
  }
  return null;
}

export function historyStats(history) {
  const usable = history
    .map(row => ({ time: Number(row.fetched_at_ms), cost: Number(row.material_cost) }))
    .filter(row => Number.isFinite(row.time) && Number.isFinite(row.cost))
    .sort((a, b) => a.time - b.time);
  const costs = usable.map(row => row.cost).sort((a, b) => a - b);
  const first = usable[0]?.time ?? Date.now();
  const last = usable.at(-1)?.time ?? first;
  return {
    count: costs.length,
    spanHours: (last - first) / 3_600_000,
    min: costs.length ? costs[0] : null,
    max: costs.length ? costs.at(-1) : null,
    p15: percentile(costs, 0.15),
    p30: percentile(costs, 0.30),
    median: percentile(costs, 0.50)
  };
}

export function percentile(sortedValues, probability) {
  if (!sortedValues.length) return null;
  const index = (sortedValues.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

export function stockEstimate(selected, days, accounts) {
  const weeklyRuns = Number(selected.runsPerWeek) || (7 * 24 / selected.hours);
  const exactRunsPerAccount = days * weeklyRuns / 7;
  const runsPerAccount = Math.ceil(exactRunsPerAccount);
  const materialCostPerAccount = selected.currentCost * runsPerAccount;
  const totalCost = materialCostPerAccount * accounts;
  const materials = (selected.recipe.materials ?? []).map(material => ({
    name: material.display_name || material.name,
    perRun: Number(material.required_count),
    perAccount: Number(material.required_count) * runsPerAccount,
    allAccounts: Number(material.required_count) * runsPerAccount * accounts
  }));
  return { runsPerAccount, materialCostPerAccount, totalCost, materials };
}

export function weeklyRunsFor(rule, hours) {
  const mapped = rule.weeklyRunsByHours?.[String(Number(hours))]
    ?? rule.weeklyRunsByHours?.[Number(hours)];
  if (Number.isFinite(Number(mapped))) return Number(mapped);
  if (Number.isFinite(Number(rule.weeklyRuns))) return Number(rule.weeklyRuns);
  return 7 * 24 / Number(hours);
}

export function portfolioSummary(recommendations, config, plan = 'stock') {
  const selected = recommendations
    .map(item => plan === 'cash' ? (item.cashSelected ?? item.selected) : item.selected)
    .filter(Boolean);
  const weeklyPerAccount = selected.reduce((sum, item) => {
    const weekly = Number.isFinite(Number(item.weeklyProfit))
      ? Number(item.weeklyProfit)
      : Number(item.dailyProfit ?? 0) * 7;
    return sum + weekly;
  }, 0);
  const dailyPerAccount = weeklyPerAccount / 7;
  const dailyGross = dailyPerAccount * config.accounts;
  const dailyUserHaff = dailyPerAccount * config.effectiveIncomeAccounts;
  const dailyUserCny = dailyUserHaff / config.haffPerCny;
  const weeklyCurrentMaterialPerAccount = selected.reduce((sum, item) => {
    const weekly = Number.isFinite(Number(item.weeklyCurrentMaterialCost))
      ? Number(item.weeklyCurrentMaterialCost)
      : Number(item.dailyCurrentMaterialCost ?? 0) * 7;
    return sum + weekly;
  }, 0);
  const currentMaterialPerAccount = weeklyCurrentMaterialPerAccount / 7;
  const investablePerAccount = config.balancePerAccount - config.cashReservePerAccount;
  const runwayDays = currentMaterialPerAccount > 0 ? investablePerAccount / currentMaterialPerAccount : null;
  return {
    weeklyPerAccount,
    dailyPerAccount,
    dailyGross,
    dailyUserHaff,
    dailyUserCny,
    weeklyCurrentMaterialPerAccount,
    currentMaterialPerAccount,
    investablePerAccount,
    runwayDays
  };
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}
