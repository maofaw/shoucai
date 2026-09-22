import fs from 'node:fs';
import { fetchSpecialOpsSnapshot } from '../src/moligod.mjs';
import { chooseRecipe, recipeMetrics } from '../src/recommend.mjs';

const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const { snapshot, metadata } = await fetchSpecialOpsSnapshot(config.snapshotUrl);

const result = {
  generatedAt: new Date(metadata.generatedAtMs ?? metadata.fetchedAtMs).toISOString(),
  recipeCount: snapshot.recipes.length,
  places: []
};

for (const [place, sourceRule] of Object.entries(config.placeRules)) {
  const stockRule = { ...sourceRule, place };
  const cashRule = {
    ...sourceRule,
    place,
    historicalStock: sourceRule.historicalStock
      ? { ...sourceRule.historicalStock, enabled: false }
      : undefined
  };
  const allowed = new Set((sourceRule.allowedHours ?? []).map(Number));
  const currentCandidates = snapshot.recipes
    .filter(recipe => recipe.place === place)
    .filter(recipe => allowed.size === 0 || allowed.has(Number(recipe.period_hours)))
    .filter(recipe => Number(recipe.missing_price_count ?? 0) === 0)
    .map(recipe => recipeMetrics(recipe, cashRule))
    .filter(item => Number.isFinite(item.dailyProfit))
    .sort((a, b) => b.dailyProfit - a.dailyProfit)
    .slice(0, 5)
    .map(item => ({
      name: item.name,
      hours: item.hours,
      materialCost: Math.round(item.currentCost),
      profitPerRun: Math.round(item.websiteProfit),
      profitPerDay: Math.round(item.dailyProfit)
    }));

  const stockChoice = chooseRecipe(snapshot.recipes, stockRule, config.switchThreshold);
  const cashChoice = chooseRecipe(snapshot.recipes, cashRule, config.switchThreshold);
  result.places.push({
    place,
    label: sourceRule.label,
    stockChoice: stockChoice.selected ? {
      name: stockChoice.selected.name,
      hours: stockChoice.selected.hours,
      effectiveMaterialCost: Math.round(stockChoice.selected.effectiveMaterialCost),
      profitPerRun: Math.round(stockChoice.selected.effectiveProfit),
      profitPerDay: Math.round(stockChoice.selected.dailyProfit),
      usesHistoricalCost: stockChoice.selected.useHistoricalCost,
      reason: stockChoice.reason
    } : null,
    cashChoice: cashChoice.selected ? {
      name: cashChoice.selected.name,
      hours: cashChoice.selected.hours,
      materialCost: Math.round(cashChoice.selected.currentCost),
      profitPerRun: Math.round(cashChoice.selected.websiteProfit),
      profitPerDay: Math.round(cashChoice.selected.dailyProfit),
      reason: cashChoice.reason
    } : null,
    cashPreferred: cashChoice.preferred ? {
      name: cashChoice.preferred.name,
      hours: cashChoice.preferred.hours,
      materialCost: Math.round(cashChoice.preferred.currentCost),
      profitPerRun: Math.round(cashChoice.preferred.websiteProfit),
      profitPerDay: Math.round(cashChoice.preferred.dailyProfit)
    } : null,
    selectedMaterials: {
      stock: (stockChoice.selected?.recipe.materials ?? []).map(material => ({
        name: material.display_name || material.name,
        requiredCount: Number(material.required_count),
        currentPrice: Number(material.current_price)
      })),
      cash: (cashChoice.selected?.recipe.materials ?? []).map(material => ({
        name: material.display_name || material.name,
        requiredCount: Number(material.required_count),
        currentPrice: Number(material.current_price)
      }))
    },
    currentCandidates
  });
}

console.log(JSON.stringify(result, null, 2));
