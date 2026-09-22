import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSpecialOpsSnapshot } from './moligod.mjs';
import { MarketStore } from './store.mjs';
import { buildRecommendations } from './recommend.mjs';
import { buildMarkdownReport, buildNotification, hasActionableBuy, writeReport } from './report.mjs';
import { showWindowsToast } from './notify.mjs';
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

function chinaHour() {
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false
  }).format(new Date()));
}

function chinaDateHour() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day} ${map.hour}`;
}

async function run() {
  const config = loadConfig();
  const wantsNotification = process.argv.includes('--notify') && config.notifications.enabled;
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

    if (wantsNotification) {
      const isNight = chinaHour() <= 2;
      const isTemporarilySuppressed = (config.notifications.temporarySuppressNotificationHours ?? [])
        .includes(chinaDateHour());
      const shouldNotify = !isTemporarilySuppressed && (
        !isNight
        || !config.notifications.nightOnlyWhenActionable
        || hasActionableBuy(recommendations)
      );
      if (shouldNotify) {
        const notification = buildNotification(recommendations, config);
        await showWindowsToast(notification.title, notification.body);
      }
    }

    console.log(report);
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    appendLog(logPath, `ERROR ${message.replaceAll('\n', ' | ')}`);
    if (wantsNotification) {
      await showWindowsToast('三角洲收菜助手运行失败', String(error?.message || error));
    }
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
