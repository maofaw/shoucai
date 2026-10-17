import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSpecialOpsSnapshot } from './moligod.mjs';
import { MarketStore } from './store.mjs';
import { buildRecommendations } from './recommend.mjs';
import { buildMarkdownReport, writeReport } from './report.mjs';
import { enrichRecommendationsWithMarketHistory } from './market-history.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveProjectPath(value) {
  if (!value) return null;
  return path.isAbsolute(value) ? value : path.join(projectRoot, value);
}

function loadConfig() {
  const file = path.join(projectRoot, 'config.json');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function appendLog(file, message) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`, 'utf8');
}

async function run() {
  const config = loadConfig();
  const dbPath = resolveProjectPath(config.paths.database);
  const logPath = resolveProjectPath(config.paths.log);
  const store = new MarketStore(dbPath);

  try {
    const { snapshot, metadata } = await fetchSpecialOpsSnapshot(config.snapshotUrl);
    const saved = store.saveSnapshot(snapshot, metadata);
    const recommendations = buildRecommendations(
      snapshot,
      config,
      recipeId => store.getRecipeHistory(recipeId, config.history.lookbackDays, metadata.fetchedAtMs)
    );
    const buyTiming = await enrichRecommendationsWithMarketHistory(recommendations, config);
    const report = buildMarkdownReport({ snapshot, metadata, recommendations, config, buyTiming });
    const destinations = [
      resolveProjectPath(config.paths.latestReport),
      resolveProjectPath(config.paths.obsidianReport)
    ];
    const written = writeReport(report, destinations);
    appendLog(logPath, `OK snapshot=${saved.snapshotId} recipes=${snapshot.recipes.length} reports=${written.length}`);

    console.log(report);
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    appendLog(logPath, `ERROR ${message.replaceAll('\n', ' | ')}`);
    throw error;
  } finally {
    store.close();
  }
}

const command = process.argv[2] ?? 'run';
if (command !== 'run') {
  console.error(`未知命令：${command}`);
  process.exitCode = 2;
} else {
  await run();
}
