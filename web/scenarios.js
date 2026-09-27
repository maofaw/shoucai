// A scenario is not Moligod's original profit. Each historical row keeps its
// paired cost, so profit + cost is the original net sale receipt after fees.
const numeric = value => value != null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
function percentile(values, p) {
  const sorted = [...values].sort((a,b) => a-b), index = (sorted.length-1)*p;
  return sorted[Math.floor(index)] + (sorted[Math.ceil(index)]-sorted[Math.floor(index)])*(index%1);
}
const key = name => String(name).toLowerCase().replace(/[\s·×*（）()]/g,'');

export function procurement(candidate, days = 7, profiles = null) {
  const runs = Math.ceil(candidate.runsPerWeek * days / 7);
  const demand = new Map();
  const add = (name, count, price) => {
    const id = key(name), old = demand.get(id);
    demand.set(id, {name, count: count + (old?.count ?? 0), price: numeric(price)});
  };
  if (!candidate.materials?.length || !(runs > 0)) return null;
  for (const material of candidate.materials) {
    if (!(numeric(material.count) > 0)) return null;
    const acquisition = material.acquisition;
    if (acquisition?.mode === 'exchange') {
      if (!(numeric(acquisition.outputCount) > 0) || !acquisition.sources?.length) return null;
      const bundles = Math.ceil(material.count * runs / acquisition.outputCount);
      for (const source of acquisition.sources) {
        if (!(numeric(source.count) > 0)) return null;
        add(source.name, bundles * source.count, source.currentPrice);
      }
    } else add(material.name, material.count * runs, material.currentPrice);
  }
  const profileRows = Array.isArray(profiles) ? profiles : profiles?.rows ?? [];
  const fallbackToCurrent = !Array.isArray(profiles) && profiles?.fallbackToCurrent === true;
  const profileMap = new Map(profileRows.map(row=>[key(row.name), row]));
  let cost = 0;
  for (const row of demand.values()) {
    let price = row.price;
    if (profiles) {
      const profile = profileMap.get(key(row.name));
      if (!profile && !fallbackToCurrent) return null;
      if (profile?.unitPrice != null) {
        price = numeric(profile.unitPrice);
      } else if (profile && !profile.ignored) {
        const target = numeric(profile.tierThresholds?.[`days${days}`]);
        if (target == null || price == null) return null;
        price = Math.min(price, target); // Never assume buying above an already lower current price.
      }
    }
    if (price == null || price < 0) return null;
    row.unitPrice = price; row.cost = row.count * price; cost += row.cost;
  }
  return { cost, days, runs, materials: [...demand.values()] };
}

export function profitScenario(candidate, settings, profiles = null) {
  const days = settings.scenarioDays ?? 7;
  const rows = (candidate.pairedHistoryByRange?.[`${settings.historyDays}d`] ?? [])
    .filter(row => row.time && Number.isFinite(Date.parse(row.time)) && numeric(row.profit) != null && numeric(row.cost) != null && Number(row.cost) >= 0);
  const purchase = procurement(candidate, days, profiles);
  if (rows.length < 24 || !purchase) return null;
  const receipts = rows.map(row => Number(row.profit) + Number(row.cost));
  const weeklyCost = purchase.cost * 7 / days;
  return { conservativeWeekly: percentile(receipts, settings.conservativePercentile / 100) * candidate.runsPerWeek - weeklyCost,
    highWeekly: percentile(receipts, settings.highPercentile / 100) * candidate.runsPerWeek - weeklyCost,
    weeklyCost, purchase, sampleCount: rows.length, historyReadAt: candidate.historyReadAt ?? null };
}

export function totalScenarios(candidates, settings, profiles = null) {
  const rows = candidates.map(candidate => profitScenario(candidate, settings, profiles));
  if (candidates.length !== 4 || rows.some(row=>!row)) return null;
  const conservativeWeekly = rows.reduce((sum,row)=>sum+row.conservativeWeekly,0);
  const highWeekly = rows.reduce((sum,row)=>sum+row.highWeekly,0);
  return { conservativeWeekly, highWeekly,
    conservativeDaily: conservativeWeekly/7, highDaily: highWeekly/7,
    conservativeMonthly: conservativeWeekly/7*30, highMonthly: highWeekly/7*30,
    weeklyCost: rows.reduce((sum,row)=>sum+row.weeklyCost,0), rows };
}
