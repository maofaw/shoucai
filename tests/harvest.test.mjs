import test from 'node:test';
import assert from 'node:assert/strict';
import { HARVEST_KEY, recordHarvest, pendingUndo, revertHarvest, serialQueue } from '../web/harvest.js';
function storage() { const values = new Map(); return {getItem: key => values.get(key) ?? null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)}; }
const now = Date.parse('2026-09-24T10:00:00Z');

test('repeated accidental clicks undo to original time, even after re-reading persistent state', () => {
  const db=storage(); const original='2026-09-24T02:00:00.000Z'; db.setItem(HARVEST_KEY,original);
  recordHarvest(db,new Date(now).toISOString(),now);
  recordHarvest(db,new Date(now+1000).toISOString(),now+1000);
  assert.equal(pendingUndo(db,now+2000).previous,original);
  assert.equal(revertHarvest(db,now+2000),original);
  assert.equal(db.getItem(HARVEST_KEY),original);
});

test('undo first record clears time; expired undo and invalid/future times are rejected', () => {
  const db=storage(); recordHarvest(db,new Date(now).toISOString(),now); revertHarvest(db,now+10);
  assert.equal(db.getItem(HARVEST_KEY),null);
  assert.throws(()=>recordHarvest(db,'bad',now));
  assert.throws(()=>recordHarvest(db,new Date(now+1).toISOString(),now));
  recordHarvest(db,new Date(now).toISOString(),now);
  assert.throws(()=>revertHarvest(db,now+10001));
});

test('cloud write queue keeps edit/undo order and continues after failed writes', async () => {
  const enqueue=serialQueue(), values=[];
  const first=enqueue(async()=>{await new Promise(resolve=>setTimeout(resolve,10));values.push('edit');throw Error('network');});
  const undo=enqueue(async()=>values.push('undo'));
  await assert.rejects(first); await undo; assert.deepEqual(values,['edit','undo']);
});
