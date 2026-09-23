function numberOrNull(value) {
  return value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
}

export function materialCostForDays(plan, days) {
  const materials = (plan?.materials || []).filter(material => !material.watchOnly);
  if (!materials.length) return null;
  const unit = days === 30 ? 'perAccount30Days' : days === 14 ? 'perAccount14Days' : 'perAccount7Days';
  if (!materials.every(material => numberOrNull(material.currentPrice) != null && numberOrNull(material[unit]) != null)) return null;
  return materials.reduce((sum, material) => sum + Number(material.currentPrice) * Number(material[unit]), 0);
}

export function suggestedDaysForBudget(plan, budgetWan) {
  const requested = [7, 14, 30].includes(Number(plan?.suggestedDays)) ? Number(plan.suggestedDays) : 7;
  const budget = Math.max(0, Number(budgetWan) || 0) * 10_000;
  const candidates = [30, 14, 7].filter(days => days <= requested);
  return candidates.find(days => {
    const cost = materialCostForDays(plan, days);
    return cost != null && cost <= budget;
  }) || 7;
}
