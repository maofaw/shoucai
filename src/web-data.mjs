import { stockEstimate } from './recommend.mjs';

const ACTION_LABELS = {
  buy: '现在适合囤货',
  wait: '等待更低价格',
  'small-buy': '只补生产刚需',
  'use-stock': '使用已有库存',
  error: '暂时无法判断'
};

export function buildDashboardData({ snapshot, metadata, recommendations, buyTiming, config, generatedAt = new Date(), stockedCosts = {} }) {
  const recipeCards = recommendations.map(item => {
    const main = item.selected;
    if (!main) return { place: item.place, label: item.label, unavailable: true };
    const backup = item.candidates.find(candidate => candidate.name !== main.name) ?? null;
    return {
      place: item.place,
      label: item.label,
      main: main.name,
      hours: main.hours,
      backup: backup?.name ?? null,
      backupHours: backup?.hours ?? null,
      backupDeltaPercent: backup && main.weeklyProfit !== 0
        ? round((backup.weeklyProfit / main.weeklyProfit - 1) * 100, 1)
        : null,
      reason: item.reason,
      weeklyRuns: main.runsPerWeek
    };
  });

  const noStockWeekly = recommendations.reduce((sum, item) => {
    const selected = item.cashSelected ?? item.selected;
    return sum + Number(selected?.weeklyProfit ?? 0);
  }, 0);
  const stockedValues = recommendations.map(item => {
    const selected = item.selected;
    if (!selected) return null;
    const savedCost = stockedCosts[String(selected.recipe.id)];
    if (!Number.isFinite(Number(savedCost))) return null;
    return (selected.revenue - selected.fee - Number(savedCost)) * selected.runsPerWeek;
  });
  const hasCompleteStockedPlan = stockedValues.length > 0 && stockedValues.every(Number.isFinite);

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
    schemaVersion: 1,
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
      haffPerCnyWan: Number(config.dashboard?.defaultHaffPerCnyWan ?? 52)
    },
    plan: {
      locked: false,
      basis: '最近4个周末较低25%成交价；样本不足时使用当前行情临时估算',
      recipes: recipeCards,
      profit: {
        stockedWeeklyPerAccount: hasCompleteStockedPlan
          ? round(stockedValues.reduce((sum, value) => sum + value, 0))
          : null,
        stockedStatus: hasCompleteStockedPlan ? '已按最近买入信号计算' : '等待首次买入信号',
        noStockWeeklyPerAccount: round(noStockWeekly),
        provisional: true
      }
    },
    buys,
    sell: {
      preferredWeekday: '周六',
      preferredStartTime: '21:30',
      undercutLevels: 1,
      remindersMinutesBefore: [720, 30, 10],
      basis: '最近4个周末价格样本；第一版样本不足时沿用周六21:30'
    },
    harvest: {
      cycleHours: 8,
      managedInBrowser: true
    },
    market: buyTiming?.portfolio ? {
      bestWeekday: buyTiming.portfolio.bestWeekdays?.[0]?.key ?? null,
      bestHour: buyTiming.portfolio.bestHours?.[0]?.key ?? null,
      bestPoweredHour: buyTiming.portfolio.bestPoweredHours?.[0]?.key ?? null
    } : null
  };
}

function round(value, digits = 0) {
  if (!Number.isFinite(Number(value))) return null;
  const factor = 10 ** digits;
  return Math.round(Number(value) * factor) / factor;
}
