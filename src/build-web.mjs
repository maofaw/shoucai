import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSpecialOpsSnapshot } from './moligod.mjs';
import { buildRecommendations } from './recommend.mjs';
import { enrichRecommendationsWithMarketHistory } from './market-history.mjs';
import { buildDashboardData } from './web-data.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configName = process.env.DASHBOARD_CONFIG ?? 'config.site.json';
const config = JSON.parse(fs.readFileSync(path.join(projectRoot, configName), 'utf8'));
const { snapshot, metadata } = await fetchSpecialOpsSnapshot(config.snapshotUrl);
const recommendations = buildRecommendations(snapshot, config);
const buyTiming = await enrichRecommendationsWithMarketHistory(recommendations, config);
const dashboard = buildDashboardData({ snapshot, metadata, recommendations, buyTiming, config });
const destination = path.join(projectRoot, 'web', 'data', 'latest.json');
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, `${JSON.stringify(dashboard, null, 2)}\n`, 'utf8');
console.log(`Dashboard data written: ${destination}`);
