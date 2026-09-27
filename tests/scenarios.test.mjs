import test from 'node:test';
import assert from 'node:assert/strict';
import { procurement, profitScenario, totalScenarios } from '../web/scenarios.js';
import { calculatePlan, migrateSettings, adoptProposal, validAdoption } from '../web/planner.js';
const settings = {historyDays:15,scenarioDays:7,conservativePercentile:25,highPercentile:75};
const rows = Array.from({length:24},(_,i)=>({time:`2026-09-19T${String(i).padStart(2,'0')}:00:00Z`,profit:100,cost:200,revenue:330}));
const candidate = (id=1,place='workbench',extra={})=>({id,place,name:`配方${id}`,hours:8,currentProfit:100,runsPerWeek:17.5,
  materials:[{name:'材料'+id,count:1,currentPrice:100}],pairedHistoryByRange:{'15d':rows},...extra});

test('scenarios add back paired historical cost, keep fees and compare identical output runs',()=>{
  const row=candidate();
  const current=profitScenario(row,settings);
  const low=profitScenario(row,settings,[{name:'材料1',ignored:false,tierThresholds:{days7:50}}]);
  assert.equal(current.conservativeWeekly,300*17.5-18*100);
  assert.equal(low.conservativeWeekly-current.conservativeWeekly,18*50);
  assert.equal(profitScenario(row,settings,[{name:'材料1',ignored:true}]).conservativeWeekly,current.conservativeWeekly);
  assert.equal(profitScenario(row,settings,[{name:'材料1',tierThresholds:{days7:110}}]).conservativeWeekly,current.conservativeWeekly);
});
test('missing paired costs or purchase prices produce no scenario, never synthetic zero profit',()=>{
  for(const invalid of [undefined,[],rows.map(row=>({...row,cost:null})),rows.slice(0,23)]) {
    assert.equal(profitScenario(candidate(1,'workbench',{pairedHistoryByRange:{'15d':invalid}}),settings),null);
  }
  assert.equal(profitScenario(candidate(),settings,[]),null);
  assert.equal(profitScenario(candidate(1,'workbench',{materials:[{name:'未知',count:1,currentPrice:null}]}),settings),null);
});
test('exchange-only costs use source bundles across full procurement period and never target price',()=>{
  const row=candidate(1,'workbench',{materials:[{name:'高级燃料',count:1,currentPrice:999999,acquisition:{mode:'exchange',outputCount:4,sources:[{name:'咖啡',count:1,currentPrice:100},{name:'弯刀',count:1,currentPrice:200}]}}]});
  assert.equal(procurement(row,7).cost,5*300);
  assert.equal(procurement(row,14).cost,9*300);
  assert.equal(procurement(row,30).cost,19*300);
  assert.equal(profitScenario(row,{...settings,scenarioDays:14}).weeklyCost,9*300/2);
});
test('complete totals use exactly 30 days and account sharing is a downstream multiplier',()=>{
  const total=totalScenarios([candidate(),candidate(),candidate(),candidate()],settings);
  assert.equal(total.conservativeMonthly,total.conservativeDaily*30);
  assert.equal(total.conservativeWeekly*(28-10+10*.8),total.conservativeWeekly*26);
  assert.equal(totalScenarios([candidate()],settings),null);
});

const defaults={placeRules:Object.fromEntries(['workbench','tech','pharmacy','armory'].map(place=>[place,{label:place,allowedHours:[8],weeklyRuns:1,
  longHours:[16],shortHours:[8],weeklyRunsByHours:{16:1},switchThreshold:.05}]))};
const data = () => ({schemaVersion:5,defaults,generatedAt:'2026-09-24T00:00:00Z',builtAt:'2026-09-24T00:00:00Z',materialHistories:{},
 candidatePools:{workbench:[candidate(1),candidate(2)],tech:[candidate(3,'tech',{hours:16,category:'gun'})],pharmacy:[candidate(4,'pharmacy')],armory:[candidate(5,'armory')]}});
function setProfit(row, profit) { row.pairedHistoryByRange={'15d':rows.map(item=>({...item,profit,cost:100}))}; }

test('adopted A100 vs B101 stays on A at 5%, new 106 proposal cannot silently replace production',()=>{
  const d=data(),s=migrateSettings({},defaults);
  setProfit(d.candidatePools.workbench[0],100);setProfit(d.candidatePools.workbench[1],99);
  const first=calculatePlan(d,s);
  assert.equal(first.plan.preview,true);
  const adopted=adoptProposal(first.proposal);
  assert.ok(validAdoption(adopted));
  setProfit(d.candidatePools.workbench[1],101);
  let next=calculatePlan(d,s,adopted);
  assert.equal(next.proposal.needsConfirmation,false);
  assert.equal(next.plan.recipes[0].id,1);
  setProfit(d.candidatePools.workbench[1],106);
  next=calculatePlan(d,s,adopted);
  assert.equal(next.proposal.recipes[0].id,2);
  assert.equal(next.plan.recipes[0].id,1);
  assert.equal(next.proposal.weeklyDifference,6);
  assert.ok(next.buyPlan.materials.some(row=>row.name==='材料1'&&!row.watchOnly));
  assert.ok(!next.buyPlan.materials.some(row=>row.name==='材料2'&&!row.watchOnly));
  assert.deepEqual(next.proposal.addedMaterials,['材料2']);
  assert.equal(calculatePlan(d,s,adoptProposal(next.proposal)).plan.recipes[0].id,2);
});
test('invalidated adopted plans remain recorded and do not silently select a replacement',()=>{
  const d=data(),s=migrateSettings({},defaults),adopted=adoptProposal(calculatePlan(d,s).proposal);
  const original=JSON.stringify(adopted);
  s.stations.workbench.allowedHours=[7];
  let result=calculatePlan(d,s,adopted);
  assert.equal(result.plan.recipes[0].id,1);
  assert.match(result.plan.issues[0],/不再符合/);
  d.candidatePools.workbench=[];
  result=calculatePlan(d,s,adopted);
  assert.equal(result.plan.recipes[0].unavailable,true);
  assert.equal(result.plan.profit.conservativeWeeklyPerAccount,null);
  assert.equal(JSON.stringify(adopted),original);
});
test('current loss raises warning without changing adopted recipe',()=>{
  const d=data(),s=migrateSettings({},defaults),adopted=adoptProposal(calculatePlan(d,s).proposal);
  d.candidatePools.workbench[0].currentProfit=-1;
  const result=calculatePlan(d,s,adopted);
  assert.equal(result.plan.recipes[0].id,1);assert.match(result.plan.issues[0],/亏损/);
  assert.equal(result.proposal.recipes[0].id,2);
});
