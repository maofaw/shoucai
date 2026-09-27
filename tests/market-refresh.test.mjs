import test from 'node:test';
import assert from 'node:assert/strict';
import {createMarketRefresher,MARKET_CHECK_MS} from '../web/market-refresh.js';
const snapshot = date => ({generatedAt:date,builtAt:date,candidatePools:{workbench:[],tech:[],pharmacy:[],armory:[]},defaults:{placeRules:{}}});
test('initial, five-minute, visibility and manual checks share a throttle and preserve same data',async()=>{
  let now=0,calls=0,updates=0;
  const refresher=createMarketRefresher({now:()=>now,load:async()=>{calls++;return {data:snapshot('2026-09-27T00:00:00Z')}},onData:()=>updates++});
  await refresher.check(); await refresher.check();assert.equal(calls,1);
  now=MARKET_CHECK_MS-1;await refresher.check();assert.equal(calls,1);
  now++;await refresher.check();assert.equal(calls,2);assert.equal(updates,1);
  await refresher.check(true);assert.equal(calls,3);
});
test('network failure and stale server results retain last good data and recover',async()=>{
  let fail=false,stale=false,now=1,displayed=null;
  const refresher=createMarketRefresher({now:()=>now,load:async()=>{
    if(fail)throw new Error('断网');return {data:snapshot(stale?'2026-09-26T00:00:00Z':'2026-09-27T00:00:00Z')};
  },onData:data=>{displayed=data;}});
  await refresher.check();const good=displayed;
  fail=true;now++;await refresher.check(true);assert.equal(displayed,good);assert.equal(refresher.status().lastSuccess,1);
  fail=false;stale=true;await refresher.check(true);assert.match(refresher.status().error,/较旧/);assert.equal(displayed,good);
  stale=false;await refresher.check(true);assert.equal(refresher.status().error,null);
});
test('offline cache loads on first visit but is not marked as a successful refresh',async()=>{
  let updates=0;
  const refresher=createMarketRefresher({load:async()=>({data:snapshot('2026-09-27T00:00:00Z'),offline:true}),onData:()=>updates++});
  await refresher.check();assert.equal(updates,1);assert.equal(refresher.status().lastSuccess,null);assert.match(refresher.status().error,/离线/);
  await refresher.check(true);assert.equal(updates,1);
});
test('concurrent checks have only one in-flight request',async()=>{
  let release,calls=0;
  const refresher=createMarketRefresher({load:()=>{calls++;return new Promise(resolve=>release=resolve)},onData:()=>{}});
  const a=refresher.check(),b=refresher.check(true);
  release({data:snapshot('2026-09-27T00:00:00Z')});await Promise.all([a,b]);assert.equal(calls,1);
});
