import fs from 'node:fs';
import { calculatePlan, migrateSettings } from '../web/planner.js';
import { homeSnapshot } from '../web/computed-cache.js';

export function buildBootstrap(data) {
  const settings = migrateSettings(null, data.defaults);
  const result = calculatePlan(data, settings);
  const compact = homeSnapshot(data, result, settings);
  // Only current home information travels on the first visit.
  compact.plan.comparisons = {};
  compact.plan.lazyPlan = null;
  compact.buyPlan = compact.buyPlan ? { ...compact.buyPlan,
    materials: compact.buyPlan.materials?.map(({ name, action, watchOnly }) => ({ name, action, watchOnly })) } : null;
  return compact;
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/build-bootstrap.mjs')) {
  const data = JSON.parse(fs.readFileSync(new URL('../web/data/latest.json', import.meta.url), 'utf8'));
  fs.writeFileSync(new URL('../web/data/bootstrap.json', import.meta.url), JSON.stringify(buildBootstrap(data)) + '\n');
}
