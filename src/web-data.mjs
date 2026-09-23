import { stockEstimate } from './recommend.mjs';

const WEEKS_PER_MONTH = 4.33;

const ACTION_LABELS = {
  buy: '现在适合囤货',
  wait: '等待更低价格',
  'small-buy': '只补生产刚需',
  'use-stock': '使用已有库存',
  error: '暂时无法判断'
};

export function buildDashboardData({ snapshot, metadata, recommendations, buyPlan = null, sellPlan = null, config, generatedAt = new Date() }) {
  const recipeCards = recommendations.map(item => {
    const main = item.cashSelected ?? item.selected;
    if (!main) return { place: item.place, label: item.label, unavailable: true };
    const candidates = item.cashCandidates ?? item.candidates ?? [];
    const backup = candidates.find(candidate => candidate.name !== main.name) ?? null;
    const mainWeekly = Number(main.conservativeWeeklyProfit ?? main.weeklyProfit);
    const backupWeekly = Number(backup?.conservativeWeeklyProfit ?? backup?.weeklyProfit);
    return {
      place: item.place,
      label: item.label,
      main: main.name,
      hours: main.hours,
      backup: backup?.name ?? null,
      backupHours: backup?.hours ?? null,
      backupDeltaPercent: backup && mainWeekly !== 0
        ? round((backupWeekly / mainWeekly - 1) * 100, 1)
        : null,
      reason: item.cashReason ?? item.reason,
      weeklyRuns: main.runsPerWeek,
      currentCost: round(main.currentCost),
      fee: round(main.conservativeFee ?? main.fee),
      revenueConservative: round(main.conservativeRevenue ?? main.revenue),
      revenueHigh: round(main.highRevenue ?? main.revenue),
      perRunConservativeProfit: round(main.conservativeProfit ?? main.effectiveProfit ?? main.websiteProfit),
      perRunHighProfit: round(main.highProfit ?? main.effectiveProfit ?? main.websiteProfit),
      weeklyConservativeProfit: round(mainWeekly),
      weeklyHighProfit: round(main.highWeeklyProfit ?? main.weeklyProfit),
      provisional: Boolean(main.priceEvidence?.provisional ?? true),
      evidence: publicPriceEvidence(main.priceEvidence)
    };
  });

  const conservativeWeekly = recommendations.reduce((sum, item) => {
    const selected = item.cashSelected ?? item.selected;
    return sum + Number(selected?.conservativeWeeklyProfit ?? selected?.weeklyProfit ?? 0);
  }, 0);
  const highWeekly = recommendations.reduce((sum, item) => {
    const selected = item.cashSelected ?? item.selected;
    return sum + Number(selected?.highWeeklyProfit ?? selected?.weeklyProfit ?? 0);
  }, 0);
  const evidenceReady = recommendations
    .map(item => item.cashSelected ?? item.selected)
    .filter(Boolean)
    .every(selected => selected.priceEvidence && !selected.priceEvidence.provisional);

  const buys = recommendations.map(item => {
    const selected = item.cashSelected ?? item.selected;
    const advice = item.cashBuy ?? item.buy;
    const timing = item.cashTiming ?? item.marketTiming;
    if (!selected) return { place: item.place, label: item.label, unavailable: true };
    const days = advice?.action === 'buy' ? Number(advice.days) : 0;
    const estimate = days > 0 ? stockEstimate(selected, days, 1) : null;
    return {
      place: item.place,
      label: item.label,
      recipe: selected.name,
      action: advice?.action ?? 'error',
      actionLabel: ACTION_LABELS[advice?.action] ?? ACTION_LABELS.error,
      tier: advice?.tier ?? null,
      days,
      reason: advice?.reason ?? '暂无建议',
      currentCost: round(selected.currentCost),
      currentPercentile: Number.isFinite(timing?.currentPercentile)
        ? round(timing.currentPercentile, 1)
        : null,
      thresholds: timing ? {
        days30: round(timing.p05),
        days14: round(timing.p15),
        days7: round(timing.p30)
      } : null,
      perAccountBudget: estimate ? round(estimate.materialCostPerAccount) : null,
      perAccountMaterials: estimate
        ? estimate.materials.map(material => ({ name: material.name, count: round(material.perAccount, 2) }))
        : []
    };
  });

  const generatedAtMs = Number(metadata.generatedAtMs ?? metadata.fetchedAtMs ?? generatedAt.getTime());
  return {
    schemaVersion: 2,
    generatedAt: new Date(generatedAtMs).toISOString(),
    builtAt: generatedAt.toISOString(),
    staleAfterHours: Number(config.dashboard?.staleAfterHours ?? 4),
    source: {
      name: 'Moligod',
      url: 'https://moligod.com/crafting',
      recipeCount: snapshot.recipes.length
    },
    defaults: {
      accounts: Number(config.dashboard?.defaultAccounts ?? config.accounts ?? 28),
      sharedAccounts: Number(config.dashboard?.defaultSharedAccounts ?? 10),
      ownerSharePercent: Number(config.dashboard?.defaultOwnerSharePercent ?? 80),
      buyBudgetPerAccount: Number(config.dashboard?.defaultBuyBudgetPerAccount ?? 10_000_000),
      haffPerCnyWan: Number(config.dashboard?.defaultHaffPerCnyWan ?? 52)
    },
    plan: {
      locked: false,
      basis: '最近4个周末较低25%成交价；样本不足时使用当前行情临时估算',
      recipes: recipeCards,
      profit: {
        conservativeWeeklyPerAccount: round(conservativeWeekly),
        conservativeMonthlyPerAccount: round(conservativeWeekly * WEEKS_PER_MONTH),
        conservativeDailyPerAccount: round(conservativeWeekly / 7),
        highWeeklyPerAccount: round(highWeekly),
        highDailyPerAccount: round(highWeekly / 7),
        stockedWeeklyPerAccount: null,
        stockedDailyPerAccount: null,
        stockedStatus: '新版按当前材料价统一估算，不读取既有库存',
        noStockWeeklyPerAccount: round(conservativeWeekly),
        noStockDailyPerAccount: round(conservativeWeekly / 7),
        basis: evidenceReady
          ? '材料按当前价，成品按最近4个周末的偏低价与较高常见价估算'
          : '部分成品历史样本不足，暂以当前售价估算；材料均按当前价',
        provisional: !evidenceReady
      }
    },
    buyPlan,
    buys,
    sell: {
      ready: Boolean(sellPlan?.ready),
      preferredWeekday: sellPlan?.preferredWeekday ?? '周六',
      preferredStartTime: sellPlan?.preferredStartTime ?? '21:30',
      preferredEndTime: sellPlan?.preferredEndTime ?? null,
      preferredWindow: sellPlan?.preferredWindow ?? '周六 21:30',
      backupWindow: sellPlan?.backupWindow ?? null,
      confidence: sellPlan?.confidence ?? '样本不足',
      sampleCount: Number(sellPlan?.sampleCount ?? 0),
      observedWeeks: Number(sellPlan?.observedWeeks ?? 0),
      coveredRecipes: Number(sellPlan?.coveredRecipes ?? 0),
      totalRecipes: Number(sellPlan?.totalRecipes ?? recommendations.length),
      liftPercent: Number.isFinite(Number(sellPlan?.liftPercent)) ? Number(sellPlan.liftPercent) : null,
      undercutLevels: 1,
      basis: sellPlan?.basis ?? '周末历史样本还不足，暂时沿用你的习惯：周六21:30集中出售'
    },
    harvest: {
      cycleHours: 8,
      managedInBrowser: true
    },
    market: null
  };
}

function round(value, digits = 0) {
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}

function publicPriceEvidence(evidence) {
  if (!evidence) return null;
  const { saleWindows: _saleWindows, ...publicEvidence } = evidence;
  return publicEvidence;
}
