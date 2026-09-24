import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateSettings, calculatePlan, rankCandidates, chooseCandidate, sortMaterials } from '../web/planner.js';

const defaults = { accounts: 28, sharedAccounts: 10, ownerSharePercent: 80, haffPerCnyWan: 52, placeRules: {
  workbench: { label: '工作台', allowedHours: [8], weeklyRuns: 17.5 },
  tech: { label: '技术中心', allowedHours: [16,24], longHours: [16,24], shortHours: [4,4.5,6,7,8], weeklyRunsByHours: {4:17.5,4.5:17.5,6:17.5,7:17.5,8:17.5,16:9,24:6} },
  pharmacy: { allowedHours: [8], weeklyRuns: 17.5 }, armory: { allowedHours: [8], weeklyRuns: 17.5 }
} };
const sample = (id, place = 'workbench', overrides = {}) => ({ id, place, name: `配方${id}`, hours: 8, category: 'acc',
  currentProfit: 100, currentRevenue: 200, currentCost: 80, currentFee: 20, profitSamplesByRange: { '15d': Array(96).fill(100), '1d': Array(24).fill(20) },
  evidenceByRange: { '15d': { weekendOnly: true }, '1d': { weekendOnly: false } },
  materials: [{ name: '材料' + id, count: 1, currentPrice: 10 }], ...overrides });
const dataFor = (pool = {}) => ({ defaults, generatedAt: '2026-09-24T02:00:00Z', builtAt: '2026-09-24T02:00:00Z',
  candidatePools: {workbench: [], tech: [], pharmacy: [], armory: [], ...pool}, materialHistories: {} });

test('migration preserves accounts, zero owner share, mode-specific rules and explicit automatic recipe', () => {
  const settings = migrateSettings({ accounts: 32, sharedAccounts: 12, userShare: 0, stations: { workbench: { preferred: '' }, tech: { runsByHours: { 8: 12 }, shortPreferred: '配件' } } }, defaults);
  assert.equal(settings.accounts, 32); assert.equal(settings.sharedAccounts, 12); assert.equal(settings.userShare, 0);
  assert.equal(settings.stations.workbench.preferred, ''); assert.equal(settings.stations.tech.runsByHours[8], 12);
  assert.equal(settings.stations.tech.runsByHours[6], 17.5); assert.equal(settings.stations.tech.shortPreferred, '配件');
  assert.equal(migrateSettings(null, defaults).accounts, 28);
});

test('all 4–8 hour accessories compete at actual frequency; mode and allowed hours are respected', () => {
  const data = dataFor({ tech: [sample(1,'tech'), sample(2,'tech',{hours:6,profitSamplesByRange:{'15d':Array(96).fill(500)}}), sample(3,'tech',{hours:16,category:'gun'})] });
  const settings = migrateSettings({ techMode: 'short' }, defaults);
  assert.deepEqual(rankCandidates(data, settings, 'tech').map(x=>x.id), [2,1]);
  assert.equal(rankCandidates(data, settings, 'tech')[0].conservativeWeeklyProfit, 8750);
  settings.stations.tech.shortHours = [8];
  assert.deepEqual(rankCandidates(data, settings, 'tech').map(x=>x.id), [1]);
  assert.deepEqual(rankCandidates(data, settings, 'tech', 'long').map(x=>x.id), [3]);
});

test('1-day evidence and samples replace 15-day evidence; missing samples use current profit', () => {
  const data = dataFor({ workbench: [sample(1)] });
  const settings = migrateSettings({ historyDays: 1 }, defaults);
  let row = rankCandidates(data, settings, 'workbench')[0];
  assert.equal(row.conservativeProfit, 20); assert.equal(row.evidence.sampleCount, 24); assert.equal(row.evidence.weekendOnly, false);
  settings.historyDays = 7;
  row = rankCandidates(data, settings, 'workbench')[0];
  assert.equal(row.conservativeProfit, 100); assert.equal(row.evidence.provisional, true); assert.equal(row.evidence.sampleCount, 0);
});

test('currently losing recipes are never selected solely because history was profitable', () => {
  const data = dataFor({ workbench: [sample(1,'workbench',{currentProfit:-1}), sample(2)] });
  const result = chooseCandidate(rankCandidates(data, migrateSettings({},defaults), 'workbench'),5);
  assert.equal(result.main.id,2);
});

test('switching recipes and back retains histories, rebuilds materials and preserves baseline watch', () => {
  const data = dataFor({ workbench: [sample(1), sample(2, 'workbench', { profitSamplesByRange: {'15d': Array(96).fill(200)} })] });
  const settings = migrateSettings({},defaults);
  settings.stations.workbench.preferred = '配方1'; settings.stations.workbench.threshold = 100;
  const original = calculatePlan(data,settings);
  settings.stations.workbench.threshold = 5;
  const switched = calculatePlan(data,settings);
  assert.equal(switched.plan.recipes[0].main,'配方2');
  assert.ok(switched.buyPlan.materials.find(x=>x.name==='材料1').watchOnly);
  assert.equal(switched.buyPlan.materials.find(x=>x.name==='材料2').perAccount7Days,18);
  assert.notEqual(switched.buyPlan.recipeSignature,original.buyPlan.recipeSignature);
  settings.stations.workbench.threshold = 100;
  assert.deepEqual(calculatePlan(data,settings), original);
});

test('14-day demand rounds the full period and exchange demand always uses whole bundles', () => {
  const data = dataFor({ workbench: [sample(1, 'workbench', {materials:[{name:'高级燃料',count:1,currentPrice:50,acquisition:{mode:'exchange',target:'高级燃料',outputCount:4,sources:[{name:'咖啡',count:1,currentPrice:100},{name:'弯刀',count:1,currentPrice:100}]}}]})] });
  const settings = migrateSettings({},defaults);
  const result = calculatePlan(data,settings);
  const coffee = result.buyPlan.materials.find(x=>x.name==='咖啡');
  assert.deepEqual([coffee.perAccount7Days,coffee.perAccount14Days,coffee.perAccount30Days],[5,9,19]);
  assert.equal(result.plan.profit.conservativeMonthlyPerAccount, result.plan.profit.conservativeDailyPerAccount * 30);
  settings.stations.workbench.weeklyRuns=10;
  assert.equal(calculatePlan(data,settings).buyPlan.materials[0].perAccount7Days,3);
});

test('unknown material prices remain unknown and cannot be hidden as cheap stable materials', () => {
  const data = dataFor({workbench:[sample(1,'workbench',{materials:[{name:'未知',count:1,currentPrice:null}]})]});
  const result=calculatePlan(data,migrateSettings({},defaults));
  assert.equal(result.buyPlan.nowAction,'unknown');
  assert.equal(result.buyPlan.materials[0].action,'unknown');
  assert.equal(result.buyPlan.materials[0].ignored,false);
  assert.equal(result.buyPlan.purchaseCostPerAccount7Days,null);
});

test('buyable materials precede waiting and unknown materials, deepest discount first', () => {
  const sorted=sortMaterials([{name:'未知',action:'unknown'},{name:'等待',action:'wait',currentPrice:101,targetPrice:100},{name:'七天',action:'buy',tierDays:7,currentPrice:90,targetPrice:100},{name:'月',action:'buy',tierDays:30,currentPrice:50,targetPrice:100}]);
  assert.deepEqual(sorted.map(x=>x.name),['月','七天','等待','未知']);
});

test('displayed material buy ceiling agrees with the minimum-discount signal', () => {
  const data = dataFor({workbench:[sample(1,'workbench',{materials:[{name:'平价材料',count:1,currentPrice:100}]})]});
  data.materialHistories['平价材料'] = Array.from({length:100},(_,i)=>({time:new Date(Date.parse(data.builtAt)+8*3600000-i*3600000).toISOString().slice(5,16).replace('T',' '),avg:100,last:100}));
  const settings = migrateSettings({},defaults);
  const material = calculatePlan(data,settings).buyPlan.materials[0];
  assert.equal(material.action,'wait');
  assert.ok(material.targetPrice < material.currentPrice);
  data.candidatePools.workbench[0].materials[0].currentPrice = material.targetPrice;
  assert.equal(calculatePlan(data,settings).buyPlan.materials[0].action,'buy');
});
