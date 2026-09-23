import { normalizeName } from './recommend.mjs';

export function latestHistoryPrice(rows = []) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const price = Number(row?.last ?? row?.avg);
    if (Number.isFinite(price) && price > 0) return price;
  }
  return null;
}

export function applyExchangePricing(snapshot, rules = [], historiesByMaterial = {}) {
  const ruleMap = new Map(rules.map(rule => [normalizeName(rule.target), rule]));
  const historyMap = new Map(Object.entries(historiesByMaterial)
    .map(([name, rows]) => [normalizeName(name), rows]));
  const recipes = snapshot.recipes.map(recipe => {
    const materials = (recipe.materials ?? []).map(material => {
      const name = String(material.display_name || material.name || '').trim();
      const rule = ruleMap.get(normalizeName(name));
      if (!rule) return material;
      const outputCount = Number(rule.outputCount);
      const sources = (rule.sources ?? []).map(source => ({
        name: source.name,
        count: Number(source.count ?? 1),
        currentPrice: latestHistoryPrice(historyMap.get(normalizeName(source.name)) ?? [])
      }));
      const hasPrices = outputCount > 0 && sources.length > 0
        && sources.every(source => Number.isFinite(source.currentPrice));
      const exchangeBundleCost = hasPrices
        ? sources.reduce((sum, source) => sum + source.count * source.currentPrice, 0)
        : null;
      const exchangeUnitPrice = exchangeBundleCost === null ? null : exchangeBundleCost / outputCount;
      const directUnitPrice = Number(material.current_price);
      const useExchange = Number.isFinite(exchangeUnitPrice)
        && (!Number.isFinite(directUnitPrice) || exchangeUnitPrice < directUnitPrice);
      const sourceText = sources.map(source => `${source.count}个${source.name}`).join('＋');
      const acquisition = {
        mode: useExchange ? 'exchange' : 'direct',
        target: name,
        outputCount,
        directUnitPrice: Number.isFinite(directUnitPrice) ? directUnitPrice : null,
        exchangeUnitPrice,
        sources,
        note: exchangeUnitPrice === null
          ? null
          : useExchange
            ? `按${sourceText}兑换${outputCount}个${name}，当前比直接购买便宜`
            : `当前直接购买不贵于${sourceText}兑换${outputCount}个${name}`
      };
      return {
        ...material,
        current_price: useExchange ? exchangeUnitPrice : directUnitPrice,
        market_current_price: Number.isFinite(directUnitPrice) ? directUnitPrice : null,
        acquisition
      };
    });
    const complete = materials.length > 0 && materials.every(material =>
      Number.isFinite(Number(material.current_price)) && Number.isFinite(Number(material.required_count)));
    if (!complete) return { ...recipe, materials };
    const estimatedMaterialCost = materials.reduce((sum, material) =>
      sum + Number(material.current_price) * Number(material.required_count), 0);
    const revenue = Number(recipe.estimated_revenue);
    const fee = Number(recipe.estimated_fee);
    return {
      ...recipe,
      materials,
      estimated_material_cost: estimatedMaterialCost,
      estimated_profit: Number.isFinite(revenue) && Number.isFinite(fee)
        ? revenue - fee - estimatedMaterialCost
        : recipe.estimated_profit
    };
  });
  return { ...snapshot, recipes };
}
