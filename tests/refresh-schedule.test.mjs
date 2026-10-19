import test from 'node:test';
import assert from 'node:assert/strict';
import { latestMarketSlot, nextMarketSlot, scheduleMarketChecks } from '../web/refresh-schedule.js';
const at = time => Date.parse('2026-10-19T' + time + '+08:00');
const memory = () => { const map = new Map(); return { getItem: key => map.get(key), setItem: (key, value) => map.set(key, value) }; };

test('fixed checks follow Beijing 07/19 across dates and timezone boundaries', () => {
  assert.equal(latestMarketSlot(at('06:59:59')), Date.parse('2026-10-18T19:00:00+08:00'));
  assert.equal(latestMarketSlot(at('07:00:00')), at('07:00:00'));
  assert.equal(nextMarketSlot(at('07:00:00')), at('19:00:00'));
  assert.equal(nextMarketSlot(at('23:00:00')), Date.parse('2026-10-20T07:00:00+08:00'));
});
test('opening schedules no request, missed slot waits 30 seconds and is deduplicated across reloads', async () => {
  const storage = memory(); let now = at('09:00:00'), calls = 0, queued;
  const options = { storage, now: () => now, generatedAt: () => '2026-10-18T19:05:00+08:00', check: async () => { calls++; return { generatedAt: new Date(now).toISOString() }; },
    setTimer: (fn, delay) => { queued = { fn, delay }; return 1; }, clearTimer: () => {} };
  const stop = scheduleMarketChecks(options);
  assert.equal(calls, 0); assert.equal(queued.delay, 30000);
  now += queued.delay; await queued.fn(); assert.equal(calls, 1);
  stop(); scheduleMarketChecks(options);
  assert.equal(queued.delay, at('19:00:00') - now);
  now = at('19:00:00'); await queued.fn(); assert.equal(calls, 2);
});
test('deployment delays and failed requests retry at most three times, with 15 minute spacing', async () => {
  let now = at('09:00:00'), queued, calls = 0;
  scheduleMarketChecks({ storage: memory(), now: () => now, generatedAt: () => '2026-10-18T19:00:00+08:00',
    check: async () => { calls++; return { error: '暂未发布' }; }, setTimer: (fn, delay) => { queued = { fn, delay }; } });
  for (let index = 0; index < 3; index++) {
    now += queued.delay; await queued.fn();
    assert.equal(calls, index + 1);
    if (index < 2) assert.equal(queued.delay, 15 * 60_000);
  }
  assert.equal(queued.delay, at('19:00:00') - now);
});
test('hidden tabs make no request and failure never loops aggressively', async () => {
  let queued, calls = 0;
  scheduleMarketChecks({ storage: memory(), now: () => at('09:00:00'), generatedAt: () => null,
    isVisible: () => false, check: async () => calls++, setTimer: (fn, delay) => { queued = { fn, delay }; } });
  await queued.fn(); assert.equal(calls, 0); assert.equal(queued.delay, 60000);
});
