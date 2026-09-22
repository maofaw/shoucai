import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSeries, combineHistories } from '../src/market-history.mjs';

test('combineHistories reconstructs recipe cost from material quantities', () => {
  const histories = [
    { count: 2, rows: [{ time: '09-21 07:00', avg: 10 }, { time: '09-21 08:00', avg: 20 }] },
    { count: 1, rows: [{ time: '09-21 07:00', avg: 5 }, { time: '09-21 08:00', avg: 7 }] }
  ];
  const series = combineHistories(histories, new Date('2026-09-22T09:00:00+08:00'));
  assert.deepEqual(series.map(point => point.value), [25, 47]);
});

test('analyzeSeries ranks current cost and excludes outage hours from powered window', () => {
  const series = [
    { date: new Date('2026-09-21T03:00:00+08:00'), value: 10 },
    { date: new Date('2026-09-21T07:00:00+08:00'), value: 20 },
    { date: new Date('2026-09-21T15:00:00+08:00'), value: 30 }
  ];
  const result = analyzeSeries(series, 20);
  assert.equal(Math.round(result.currentPercentile), 67);
  assert.equal(result.bestHours[0].key, 3);
  assert.equal(result.bestPoweredHours[0].key, 7);
});

test('weekday ranking ignores incomplete calendar days', () => {
  const series = [];
  for (let hour = 0; hour < 24; hour += 1) {
    series.push({ date: new Date(`2026-09-21T${String(hour).padStart(2, '0')}:00:00+08:00`), value: 100 });
  }
  series.push({ date: new Date('2026-09-22T01:00:00+08:00'), value: 1 });
  const result = analyzeSeries(series, 100);
  assert.equal(result.bestWeekdays.length, 1);
  assert.equal(result.bestWeekdays[0].key, '周一');
});
