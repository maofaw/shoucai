import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNotification } from '../src/report.mjs';

const config = {
  accounts: 28,
  effectiveIncomeAccounts: 26,
  haffPerCny: 520000,
  balancePerAccount: 20000000,
  cashReservePerAccount: 3000000,
  collectionTimes: ['07:00', '15:00', '23:00'],
  notifications: {
    maxBodyLength: 300,
    weekendSell: {
      weekday: 'Sat', reminderTime: '21:20', startTime: '21:30', minutesPerAccount: 4, undercutLevels: 1
    }
  }
};

function recommendations(action = 'wait') {
  return [{
    label: '工作台',
    selected: {
      name: '4.6 x 30mm AP ST', hours: 8, currentCost: 200000,
      dailyProfit: 1000000, dailyCurrentMaterialCost: 600000,
      recipe: { materials: [] }
    },
    buy: { action, days: action === 'buy' ? 14 : 1 }
  }];
}

test('morning notification is an operational collection reminder', () => {
  const result = buildNotification(recommendations(), config, new Date('2026-09-21T06:50:00+08:00'));
  assert.equal(result.title, '07:00收菜提醒');
  assert.match(result.body, /10分钟后收菜/);
  assert.match(result.body, /理论利润/);
});

test('actionable buy notification includes duration and total budget', () => {
  const result = buildNotification(recommendations('buy'), config, new Date('2026-09-21T01:00:00+08:00'));
  assert.equal(result.title, '材料进入低价区');
  assert.match(result.body, /囤14天/);
  assert.match(result.body, /28号约/);
});

test('Saturday notification switches to sell reminder', () => {
  const result = buildNotification(recommendations(), config, new Date('2026-09-26T21:20:00+08:00'));
  assert.equal(result.title, '21:30开始清仓');
  assert.match(result.body, /112分钟/);
});

test('notification shows conditional stocked and no-stock picks', () => {
  const items = recommendations();
  items[0].cashSelected = { ...items[0].selected, name: '5.45x39mm BS' };
  const result = buildNotification(items, config, new Date('2026-09-21T06:50:00+08:00'));
  assert.match(result.body, /有料AP ST\/缺料5.45x39mm BS/);
});
