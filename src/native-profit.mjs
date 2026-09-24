import fs from 'node:fs';
import path from 'node:path';

const HOUR_MS = 3_600_000;

export async function fetchItemDetail(objectId, options = {}) {
  const origin = options.origin ?? 'https://moligod.com';
  const url = new URL('/api/market/item-detail', origin);
  url.searchParams.set('object_id', String(objectId));
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'DeltaHarvestAdvisor/1.0 (personal low-frequency client)' },
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000)
  });
  if (!response.ok) throw new Error(`物品详情请求失败：HTTP ${response.status}`);
  return response.json();
}

export function analyzeNativeProfit(recipe, detail, options = {}) {
  const detailRecipe = detail?.crafting?.recipes?.find(item =>
    Number(item.recipe_id) === Number(recipe.id ?? recipe.recipe_id));
  const rows = detailRecipe?.charts?.profit?.ranges?.['15d'] ?? [];
  const profitSamplesByRange = Object.fromEntries(['1d', '7d', '15d'].map(range => [range,
    (detailRecipe?.charts?.profit?.ranges?.[range] ?? []).map(row => Number(row.profit)).filter(Number.isFinite).sort((a, b) => a - b)
  ]));
  const usable = rows.map(row => ({
    time: String(row.time ?? ''), profit: Number(row.profit), revenue: Number(row.revenue), cost: Number(row.cost)
  })).filter(row => Number.isFinite(row.profit));
  const weekend = usable.filter(row => isChinaWeekend(row.time, options.now ?? new Date()));
  const evidence = weekend.length >= 24 ? weekend : usable;
  const profits = evidence.map(row => row.profit).sort((a, b) => a - b);
  profitSamplesByRange['15d'] = profits;
  const conservativePercentile = Number(options.conservativePercentile ?? 0.25);
  const highPercentile = Number(options.highPercentile ?? 0.75);
  return {
    source: 'Moligod 原生特勤收益曲线',
    range: '15d',
    weekendOnly: weekend.length >= 24,
    sampleCount: evidence.length,
    profitSamples: profits,
    profitSamplesByRange,
    conservativePercentile,
    highPercentile,
    conservativeProfit: percentile(profits, conservativePercentile),
    highProfit: percentile(profits, highPercentile),
    minProfit: profits[0] ?? null,
    medianProfit: percentile(profits, 0.5),
    maxProfit: profits.at(-1) ?? null,
    provisional: profits.length < 24
  };
}

export async function enrichSnapshotWithNativeProfit(snapshot, config, options = {}) {
  const cacheDir = options.cacheDir ?? path.resolve('.cache', 'moligod-item-details');
  const cacheHours = Number(options.cacheHours ?? 12);
  const concurrency = Math.max(1, Number(options.concurrency ?? 3));
  fs.mkdirSync(cacheDir, { recursive: true });
  const rules = config.placeRules ?? {};
  const recipes = snapshot.recipes.filter(recipe => {
    const rule = rules[recipe.place];
    if (!rule || Number(recipe.missing_price_count ?? 0) !== 0) return false;
    const hours = new Set([...(rule.allowedHours ?? []), ...(rule.longHours ?? []), ...(rule.shortHours ?? [])].map(Number));
    return hours.size === 0 || hours.has(Number(recipe.period_hours));
  });
  const queue = [...recipes];
  const nativeById = new Map();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const recipe = queue.shift();
      try {
        const detail = await cachedDetail(recipe.output_object_id, { cacheDir, cacheHours, ...options });
        nativeById.set(Number(recipe.id), analyzeNativeProfit(recipe, detail, {
          conservativePercentile: config.dashboard?.nativeConservativePercentile ?? 0.25,
          highPercentile: config.dashboard?.nativeHighPercentile ?? 0.75
        }));
      } catch (error) {
        nativeById.set(Number(recipe.id), { source: 'Moligod 当前配方快照', sampleCount: 0, provisional: true,
          conservativeProfit: Number(recipe.estimated_profit), highProfit: Number(recipe.estimated_profit), error: String(error?.message ?? error) });
      }
    }
  }));
  return { ...snapshot, recipes: snapshot.recipes.map(recipe => ({ ...recipe, native_profit: nativeById.get(Number(recipe.id)) ?? null })) };
}

async function cachedDetail(objectId, options) {
  if (!objectId) throw new Error('配方缺少产物ID');
  const file = path.join(options.cacheDir, `${String(objectId).replace(/[^\w.-]/g, '_')}.json`);
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs < options.cacheHours * HOUR_MS) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  const detail = await fetchItemDetail(objectId, options);
  fs.writeFileSync(file, JSON.stringify(detail), 'utf8');
  return detail;
}

function isChinaWeekend(value, now) {
  const match = /^(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const year = new Date(now.getTime() + 8 * HOUR_MS).getUTCFullYear();
  const date = new Date(`${year}-${match[1]}-${match[2]}T${match[3]}:${match[4]}:00+08:00`);
  const day = new Date(date.getTime() + 8 * HOUR_MS).getUTCDay();
  return day === 0 || day === 6;
}

function percentile(sorted, probability) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}
