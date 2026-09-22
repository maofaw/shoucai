import fs from 'node:fs';
import { fetchSpecialOpsSnapshot } from '../src/moligod.mjs';
import { buildRecommendations } from '../src/recommend.mjs';
import { analyzeRecipeBuyWindow } from '../src/market-history.mjs';

const config = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const { snapshot, metadata } = await fetchSpecialOpsSnapshot(config.snapshotUrl);
const recommendations = buildRecommendations(snapshot, config);

const analyses = [];
for (const item of recommendations) {
  const selected = item.cashSelected ?? item.selected;
  if (!selected) continue;
  const analysis = await analyzeRecipeBuyWindow(selected);
  analyses.push({ place: item.place, label: item.label, hours: selected.hours, ...analysis });
}

const portfolioWeekdays = aggregateGroups(analyses, 'bestWeekdays');
const portfolioHours = aggregateGroups(analyses, 'hourlyAverages');
const portfolioPoweredHours = aggregateGroups(analyses, 'poweredHourAverages');

console.log(JSON.stringify({
  generatedAt: new Date(metadata.generatedAtMs ?? metadata.fetchedAtMs).toISOString(),
  analyses,
  portfolio: {
    bestWeekdays: portfolioWeekdays,
    bestHours: portfolioHours,
    bestPoweredHours: portfolioPoweredHours
  }
}, null, 2));

function aggregateGroups(items, field) {
  const keys = new Set(items.flatMap(item => item[field].map(group => group.key)));
  return [...keys].map(key => ({
    key,
    averageDailyCost: items.reduce((sum, item) => {
      const group = item[field].find(candidate => candidate.key === key);
      return sum + (group?.average ?? 0) * (24 / item.hours);
    }, 0)
  })).sort((a, b) => a.averageDailyCost - b.averageDailyCost);
}
