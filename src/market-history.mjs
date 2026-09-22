const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export async function fetchMaterialHistory(name, options = {}) {
  const origin = options.origin ?? 'https://moligod.com';
  const interval = options.interval ?? '1h';
  const limit = options.limit ?? 360;
  const url = new URL('/api/market/history', origin);
  url.searchParams.set('name', name);
  url.searchParams.set('interval', interval);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('lookup', 'name');
  const attempts = options.attempts ?? 3;
  let response;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'DeltaHarvestAdvisor/1.0 (personal low-frequency client)' },
        signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 20_000)
      });
      break;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await wait(600 * attempt);
    }
  }
  if (!response) throw lastError ?? new Error(`历史行情请求失败：${name}`);
  if (!response.ok) throw new Error(`历史行情请求失败：${name} HTTP ${response.status}`);
  const payload = await response.json();
  if (payload?.status !== 'ok' || !Array.isArray(payload.data)) {
    throw new Error(`历史行情格式异常：${name}`);
  }
  return payload.data;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function analyzeRecipeBuyWindow(selected, options = {}) {
  const materials = selected?.recipe?.materials ?? [];
  const histories = await Promise.all(materials.map(async material => ({
    name: material.display_name || material.name,
    count: Number(material.required_count),
    rows: await fetchMaterialHistory(material.display_name || material.name, options)
  })));
  const series = combineHistories(histories, options.now ?? new Date());
  return {
    recipeName: selected.name,
    hours: selected.hours,
    currentCost: selected.currentCost,
    materials: histories.map(item => item.name),
    ...analyzeSeries(series, selected.currentCost)
  };
}

export async function enrichRecommendationsWithMarketHistory(recommendations, config, options = {}) {
  const historyOptions = {
    ...options,
    limit: options.limit ?? config.history?.marketLimit ?? (config.history?.lookbackDays ?? 30) * 24
  };
  const completed = await Promise.all(recommendations.map(async item => {
    const selected = item.cashSelected ?? item.selected;
    if (!selected) return null;
    try {
      const timing = await analyzeRecipeBuyWindow(selected, historyOptions);
      const advice = timingBuyAdvice(selected, timing, config);
      item.cashTiming = timing;
      item.cashBuy = advice;
      if (!item.selected?.useHistoricalCost && item.selected?.name === selected.name) {
        item.marketTiming = timing;
        item.buy = advice;
      }
      return { item, timing };
    } catch (error) {
      const advice = {
        action: 'error',
        days: 0,
        reason: '30天材料行情暂时不可用，本轮不建议囤货',
        error: String(error?.message ?? error)
      };
      item.cashTiming = null;
      item.cashBuy = advice;
      if (!item.selected?.useHistoricalCost && item.selected?.name === selected.name) {
        item.marketTiming = null;
        item.buy = advice;
      }
      return null;
    }
  }));
  const analyses = completed.filter(Boolean).map(entry => entry.timing);
  return {
    recommendations,
    portfolio: {
      bestWeekdays: aggregateGroups(analyses, 'bestWeekdays'),
      bestHours: aggregateGroups(analyses, 'hourlyAverages'),
      bestPoweredHours: aggregateGroups(analyses, 'poweredHourAverages')
    }
  };
}

export function timingBuyAdvice(selected, timing, config) {
  const manual = findManualThreshold(selected.name, config.manualBuyThresholds ?? {});
  if (manual) {
    const totalOk = selected.currentCost <= Number(manual.totalCost);
    const materialChecks = Object.entries(manual.materials ?? {}).map(([name, threshold]) => {
      const material = (selected.recipe.materials ?? []).find(item => normalizeName(item.display_name || item.name) === normalizeName(name));
      return {
        name,
        threshold: Number(threshold),
        price: material ? Number(material.current_price) : null,
        ok: Boolean(material && Number(material.current_price) <= Number(threshold))
      };
    });
    if (totalOk && materialChecks.every(item => item.ok)) {
      return { action: 'buy', days: 14, reason: '达到人工验证的深度低价线', marketTiming: timing, manual: { totalOk, materialChecks } };
    }
  }

  const tiers = [...(config.buyTiers ?? [])]
    .sort((a, b) => Number(a.maxPercentile) - Number(b.maxPercentile));
  const tier = tiers.find(item => timing.currentPercentile <= Number(item.maxPercentile));
  if (tier) {
    return {
      action: 'buy',
      days: Number(tier.days),
      tier: String(tier.label ?? ''),
      reason: `整套材料成本进入近30天最低${Number(tier.maxPercentile)}%区间`,
      marketTiming: timing,
      manual
    };
  }
  if (timing.currentPercentile <= 50) {
    return { action: 'small-buy', days: 3, reason: '整套材料价格处于近30天正常偏低区，只补约3天', marketTiming: timing };
  }
  return { action: 'wait', days: 1, reason: `整套材料处于近30天约${timing.currentPercentile.toFixed(0)}%分位，偏贵，继续等待`, marketTiming: timing };
}

export function combineHistories(histories, now = new Date()) {
  if (!histories.length) return [];
  const maps = histories.map(material => ({
    ...material,
    values: new Map(material.rows.map(row => [row.time, Number(row.avg ?? row.last)]))
  }));
  const commonTimes = [...maps[0].values.keys()]
    .filter(time => maps.every(material => Number.isFinite(material.values.get(time))));
  return commonTimes.map(time => ({
    time,
    date: parseMarketTime(time, now),
    value: maps.reduce((sum, material) => sum + material.values.get(time) * material.count, 0)
  })).filter(point => !Number.isNaN(point.date.getTime()));
}

export function analyzeSeries(series, currentValue) {
  const values = series.map(point => point.value).filter(Number.isFinite).sort((a, b) => a - b);
  const byHour = groupedAverages(series, point => chinaParts(point.date).hour);
  const dailySeries = completeDailyAverages(series);
  const byWeekday = groupedAverages(dailySeries, point => WEEKDAYS[chinaParts(point.date).weekday]);
  const bySlot = groupedAverages(series, point => {
    const parts = chinaParts(point.date);
    return `${WEEKDAYS[parts.weekday]} ${String(parts.hour).padStart(2, '0')}:00`;
  })
    .filter(item => item.count >= 2);
  const currentPercentile = values.length
    ? values.filter(value => value <= currentValue).length / values.length * 100
    : null;
  return {
    sampleCount: values.length,
    min: values[0] ?? null,
    p15: percentile(values, 0.15),
    p30: percentile(values, 0.30),
    p05: percentile(values, 0.05),
    median: percentile(values, 0.50),
    max: values.at(-1) ?? null,
    currentPercentile,
    hourlyAverages: byHour,
    poweredHourAverages: byHour.filter(item => Number(item.key) >= 7 && Number(item.key) <= 23),
    bestHours: [...byHour].sort((a, b) => a.average - b.average).slice(0, 5),
    bestPoweredHours: byHour
      .filter(item => Number(item.key) >= 7 && Number(item.key) <= 23)
      .sort((a, b) => a.average - b.average)
      .slice(0, 5),
    bestWeekdays: [...byWeekday].sort((a, b) => a.average - b.average),
    bestSlots: [...bySlot].sort((a, b) => a.average - b.average).slice(0, 8)
  };
}

function completeDailyAverages(series) {
  const days = new Map();
  for (const point of series) {
    const parts = chinaParts(point.date);
    const key = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
    const day = days.get(key) ?? { date: point.date, total: 0, count: 0 };
    day.total += point.value;
    day.count += 1;
    days.set(key, day);
  }
  return [...days.values()]
    .filter(day => day.count >= 20)
    .map(day => ({ date: day.date, value: day.total / day.count }));
}

function chinaParts(date) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    weekday: shifted.getUTCDay()
  };
}

function groupedAverages(series, keyFn) {
  const groups = new Map();
  for (const point of series) {
    const key = keyFn(point);
    const current = groups.get(key) ?? { key, total: 0, count: 0 };
    current.total += point.value;
    current.count += 1;
    groups.set(key, current);
  }
  return [...groups.values()].map(item => ({
    key: item.key,
    count: item.count,
    average: item.total / item.count
  }));
}

function aggregateGroups(items, field) {
  const keys = new Set(items.flatMap(item => (item[field] ?? []).map(group => group.key)));
  return [...keys].map(key => ({
    key,
    averageDailyCost: items.reduce((sum, item) => {
      const group = (item[field] ?? []).find(candidate => candidate.key === key);
      return sum + (group?.average ?? 0) * (24 / item.hours);
    }, 0)
  })).sort((a, b) => a.averageDailyCost - b.averageDailyCost);
}

function findManualThreshold(name, thresholds) {
  const target = normalizeName(name);
  for (const [candidate, value] of Object.entries(thresholds)) {
    if (normalizeName(candidate) === target) return value;
  }
  return null;
}

function normalizeName(value) {
  return String(value ?? '').toLowerCase().replace(/[\s·×*]/g, '').replace(/[（）()]/g, '');
}

function parseMarketTime(value, now) {
  const match = /^(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(String(value));
  if (!match) return new Date(NaN);
  const [, month, day, hour, minute] = match;
  const chinaYear = Number(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric'
  }).format(now));
  let year = chinaYear;
  const candidate = new Date(`${year}-${month}-${day}T${hour}:${minute}:00+08:00`);
  if (candidate.getTime() - now.getTime() > 7 * 86_400_000) year -= 1;
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:00+08:00`);
}

function percentile(sortedValues, probability) {
  if (!sortedValues.length) return null;
  const index = (sortedValues.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}
