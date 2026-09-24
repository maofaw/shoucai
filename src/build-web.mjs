import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSpecialOpsSnapshot } from './moligod.mjs';
import { buildRecommendations } from './recommend.mjs';
import { fetchMaterialHistory } from './market-history.mjs';
import { buildPortfolioSaleTiming, enrichRecommendationsWithWeekendPrices } from './weekend-prices.mjs';
import { buildWeeklyBuyAdvice, materialNamesForSelectedRecipes } from './buy-window.mjs';
import { applyExchangePricing } from './exchange-pricing.mjs';
import { buildDashboardData } from './web-data.mjs';
import { enrichSnapshotWithNativeProfit } from './native-profit.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configName = process.env.DASHBOARD_CONFIG ?? 'config.site.json';
const config = JSON.parse(fs.readFileSync(path.join(projectRoot, configName), 'utf8'));
const { snapshot: rawSnapshot, metadata } = await fetchSpecialOpsSnapshot(config.snapshotUrl);
const destination = path.join(projectRoot, 'web', 'data', 'latest.json');
const exchangeSourceNames = [...new Set((config.exchangeRules ?? [])
  .flatMap(rule => rule.sources ?? [])
  .map(source => source.name))];
const exchangeHistories = Object.fromEntries(await Promise.all(exchangeSourceNames.map(async name => {
  try {
    return [name, await fetchMaterialHistory(name, {
      limit: Number(config.history?.marketLimit ?? 720), attempts: 2, timeoutMs: 15_000
    })];
  } catch (error) {
    console.warn(`Exchange material history unavailable: ${name}: ${error?.message ?? error}`);
    return [name, []];
  }
})));
const historySnapshot = await enrichSnapshotWithNativeProfit(rawSnapshot, config, { concurrency: 3, cacheHours: 12 });
const snapshot = applyExchangePricing(historySnapshot, config.exchangeRules, exchangeHistories);
const baseRecommendations = buildRecommendations(snapshot, config);
const recommendations = await enrichRecommendationsWithWeekendPrices(baseRecommendations, config);
const sellPlan = buildPortfolioSaleTiming(recommendations, config);
const materialNames = materialNamesForSelectedRecipes(recommendations);
const historiesByMaterial = Object.fromEntries(await Promise.all(materialNames.map(async name => {
  if (exchangeHistories[name]) return [name, exchangeHistories[name]];
  try {
    return [name, await fetchMaterialHistory(name, {
      limit: Number(config.history?.marketLimit ?? 720),
      attempts: 2,
      timeoutMs: 15_000
    })];
  } catch (error) {
    console.warn(`Material history unavailable: ${name}: ${error?.message ?? error}`);
    return [name, []];
  }
})));
let previousPlan = null;
try {
  previousPlan = JSON.parse(fs.readFileSync(destination, 'utf8')).buyPlan ?? null;
} catch {
  // First build or an old schema has no reusable weekly plan.
}
const buyPlan = buildWeeklyBuyAdvice({
  recommendations,
  historiesByMaterial,
  budgetPerAccount: Number(config.dashboard?.defaultBuyBudgetPerAccount ?? 10_000_000),
  previousPlan,
  materialFilter: config.buyMaterialFilter
});
const dashboard = buildDashboardData({ snapshot, metadata, recommendations, buyPlan, sellPlan, config });
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, `${JSON.stringify(dashboard, null, 2)}\n`, 'utf8');
console.log(`Dashboard data written: ${destination}`);
