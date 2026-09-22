import fs from 'node:fs';
import path from 'node:path';
import { portfolioSummary, stockEstimate } from './recommend.mjs';

const nf = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });

export function buildMarkdownReport({ snapshot, metadata, recommendations, config, buyTiming, generatedAt = new Date() }) {
  const stockSummary = portfolioSummary(recommendations, config, 'stock');
  const cashSummary = portfolioSummary(recommendations, config, 'cash');
  const timestamp = formatChinaTime(generatedAt);
  const snapshotTimestamp = formatChinaTime(new Date(metadata.generatedAtMs ?? metadata.fetchedAtMs));
  const lines = [
    '---',
    'title: 三角洲收菜实时建议',
    `updated: ${toFrontmatterTime(generatedAt)}`,
    'tags:',
    '  - 三角洲行动',
    '  - 特勤处',
    '  - 实时行情',
    'source: moligod',
    'document_role: dynamic_snapshot',
    '---',
    '',
    '# 三角洲收菜实时建议',
    '',
    `> [!info] 更新时间\n> 建议生成：${timestamp}；市场快照：${snapshotTimestamp}；配方数：${snapshot.recipes.length}。`,
    '',
    '> [!warning] 口径说明',
    `> 本页是当前行情快照，表中的利润用于发现候选配方，不等于周末实际落袋利润。切换门槛按整周预计净利润计算：候选方案高出常用方案${Math.round((config.switchThreshold ?? 0.05) * 100)}%才允许切换，并继续检查周末售价、流动性和仓库占用。`,
    '',
    '## 按账号状态执行',
    '',
    '> [!tip] 不用提前清点库存',
    '> 制药台能直接开工、不需要现买材料：造 **精密护甲维修包（金甲修）**；需要现买金甲修材料：改造 **感知强化剂**；感知材料不方便时用 **M2肌肉注射剂**。',
    '',
    '## 本轮制造结论',
    '',
    '| 制造台 | 建议 | 时长 | 网站当前单轮利润 | 实际成本口径单轮利润 | 当前行情整周理论利润 | 原因 |',
    '|---|---|---:|---:|---:|---:|---|'
  ];

  for (const item of recommendations) {
    if (!item.selected) {
      lines.push(`| ${item.label} | 无可用配方 | - | - | - | - | ${item.buy.reason} |`);
      continue;
    }
    const s = item.selected;
    const conditionalName = item.cashSelected && item.cashSelected.name !== s.name
      ? `**${escapePipe(s.name)}**（有旧料） / **${escapePipe(item.cashSelected.name)}**（需买料）`
      : `**${escapePipe(s.name)}**`;
    lines.push(`| ${item.label} | ${conditionalName} | ${s.hours}h | ${money(s.websiteProfit)} | ${money(s.effectiveProfit)} | ${money(s.weeklyProfit)} | ${escapePipe(item.reason)} |`);
  }

  lines.push('', '## 买料建议', '');
  for (const item of recommendations) {
    if (!item.selected) continue;
    const buy = item.buy;
    const icon = buy.action === 'buy' ? '✅' : buy.action === 'use-stock' ? '📦' : buy.action === 'wait' ? '⏳' : '⚠️';
    lines.push(`### ${icon} ${item.label} · ${item.selected.name}`);
    lines.push('');
    lines.push(`- 建议：${buyLabel(buy)}`);
    lines.push(`- 原因：${buy.reason}`);
    lines.push(`- 当前单轮材料成本：${money(item.selected.currentCost)}`);
    if (buy.history?.count) {
      lines.push(`- 本地样本：${buy.history.count}条，跨度${buy.history.spanHours.toFixed(1)}小时，中位数${money(buy.history.median)}`);
    }
    if (buy.days > 0) {
      const stock = stockEstimate(item.selected, buy.days, config.accounts);
      lines.push(`- ${buy.days}天用量：每号${stock.runsPerAccount}轮，28号总材料预算约${money(stock.totalCost)}`);
      if (buy.action === 'buy') {
        const compact = stock.materials.map(material => `${material.name}×${nf.format(material.allAccounts)}`).join('；');
        lines.push(`- 28号材料数量：${compact}`);
      }
    }
    if (item.cashSelected && item.cashSelected.name !== item.selected.name) {
      lines.push(`- 无库存主选：${item.cashSelected.name}，当前单轮利润${money(item.cashSelected.websiteProfit)}`);
      lines.push(`- 无库存原因：${item.cashReason}`);
      lines.push(`- 无库存买料：${buyLabel(item.cashBuy)}；${item.cashBuy.reason}`);
    }
    lines.push('');
  }

  const overallDay = buyTiming?.portfolio?.bestWeekdays?.[0]?.key;
  const overallHour = buyTiming?.portfolio?.bestHours?.[0]?.key;
  const overallPoweredHour = buyTiming?.portfolio?.bestPoweredHours?.[0]?.key;
  lines.push(
    '## 30天历史买入窗口',
    '',
    '> [!info] 判断口径',
    '> 使用 moligod 过去30天、每小时价格重建整套配方材料成本。价格百分位优先，星期和每日时段只作为辅助。',
    ''
  );
  if (overallDay || overallHour !== undefined) {
    lines.push(`- 星期参考：当前样本整体以 **${overallDay ?? '不固定星期'}** 成本较低；全天低价时段约为 **${String(overallHour).padStart(2, '0')}:00左右**。星期与小时分别统计，不代表该组合每周必然最低。`);
    if (overallPoweredHour !== undefined) {
      lines.push(`- 电脑通电时段的备选低价点约为 **${String(overallPoweredHour).padStart(2, '0')}:00**；夜间手机采购应优先参考全天低价时段。`);
    }
    lines.push('- 实际执行优先级：先看价格是否进入低位，再参考星期和时段；不要只因到了固定时间就囤货。');
    lines.push('');
  }
  lines.push(
    '| 制造台 | 无库存配方 | 当前成本 | 30天位置 | 14天线（P15） | 7天线（P30） | 全天低价点 | 通电备选 | 当前动作 |',
    '|---|---|---:|---:|---:|---:|---|---|---|'
  );
  for (const item of recommendations) {
    const timing = item.cashTiming;
    const selected = item.cashSelected ?? item.selected;
    if (!timing || !selected) continue;
    const hours = timing.bestHours.slice(0, 2).map(entry => `${String(entry.key).padStart(2, '0')}:00`).join('、');
    const poweredHours = timing.bestPoweredHours.slice(0, 2).map(entry => `${String(entry.key).padStart(2, '0')}:00`).join('、');
    lines.push(`| ${item.label} | ${escapePipe(selected.name)} | ${money(timing.currentCost)} | ${timing.currentPercentile.toFixed(0)}% | ${money(timing.p15)} | ${money(timing.p30)} | ${hours} | ${poweredHours} | ${escapePipe(buyLabel(item.cashBuy))} |`);
  }
  lines.push('');

  lines.push(
    '## 收益与资金概览',
    '',
    `- 全部无旧库存时，按当前行情计算的单号24小时理论净利润：**${money(cashSummary.dailyPerAccount)}哈夫币**。`,
    `- 长期稳定考核线：**${money(config.stableDailyProfitTargetPerAccount ?? 1600000)}哈夫币/号/天**；以周末实际成交结果复盘，不以本页瞬时数字代替。`,
    `- 对应28号合计制造净利润：**${money(cashSummary.dailyGross)}哈夫币/天**。`,
    `- 库存情况未知时，按26个有效收益号折算约 **${Math.min(cashSummary.dailyUserCny, stockSummary.dailyUserCny).toFixed(2)}–${Math.max(cashSummary.dailyUserCny, stockSummary.dailyUserCny).toFixed(2)}元/天**。`,
    `- 按当前材料价维持无库存方案，每号每天需约${money(cashSummary.currentMaterialPerAccount)}哈夫币。`,
    `- 每号保留${money(config.cashReservePerAccount)}后，可用资金约${money(cashSummary.investablePerAccount)}，约可覆盖${cashSummary.runwayDays?.toFixed(1) ?? '-'}天。`,
    '',
    '> [!warning] 使用说明',
    '> 金甲修若标记“旧库存成本”，利润按每轮10万历史材料成本计算；材料耗尽后请把 `config.json` 中 `historicalStock.enabled` 改为 `false`。实时推荐不等于保证成交价，周末出售前仍需重新检查行情。',
    '',
    '## 运行状态',
    '',
    `- 数据源：[moligod特勤处制造](https://moligod.com/crafting)`,
    `- 本地采集频率：${config.schedule.join('、')}`,
    '- 程序模式：定时启动、单次采集后退出，不常驻内存。',
    '- 相关档案：[[200-Projects/三角洲收菜运营/三角洲收菜运营档案|三角洲收菜运营档案]]',
    ''
  );
  return lines.join('\n');
}

export function writeReport(report, destinations) {
  const written = [];
  for (const destination of destinations.filter(Boolean)) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, report, 'utf8');
    written.push(destination);
  }
  return written;
}

export function buildNotification(recommendations, config, generatedAt = new Date()) {
  const picks = recommendations
    .filter(item => item.selected)
    .map(item => item.cashSelected && item.cashSelected.name !== item.selected.name
      ? `${item.label}:有料${shortName(item.selected.name)}/缺料${shortName(item.cashSelected.name)}`
      : `${item.label}:${shortName(item.selected.name)}`)
    .join('｜');
  const actionable = recommendations.filter(item => item.selected && (item.cashBuy ?? item.buy)?.action === 'buy');
  const buys = actionable.map(item => {
    const selected = item.cashSelected ?? item.selected;
    const buy = item.cashBuy ?? item.buy;
    const stock = stockEstimate(selected, buy.days, config.accounts);
    return `${item.label}囤${buy.days}天(28号约${compactMoney(stock.totalCost)})`;
  });
  const stockSummary = portfolioSummary(recommendations, config, 'stock');
  const cashSummary = portfolioSummary(recommendations, config, 'cash');
  const clock = chinaClock(generatedAt);
  const sell = config.notifications?.weekendSell;
  const sellReminder = sell
    && clock.weekday === sell.weekday
    && clock.hhmm === sell.reminderTime;

  if (sellReminder) {
    const totalMinutes = config.accounts * Number(sell.minutesPerAccount ?? 4);
    return {
      title: `${sell.startTime}开始清仓`,
      body: `共${config.accounts}号，预计${totalMinutes}分钟；按计划降${sell.undercutLevels ?? 1}个价位快速卖出。\n出售前已更新行情，详细建议见Obsidian。`
        .slice(0, config.notifications.maxBodyLength ?? 300)
    };
  }

  const collectionTime = collectionTarget(clock.hour, config.collectionTimes ?? []);
  if (collectionTime) {
    const buyLine = buys.length
      ? `买料：${buys.join('、')}`
      : '买料：暂无大囤信号，只补生产所需';
    return {
      title: `${collectionTime}收菜提醒`,
      body: `10分钟后收菜｜${picks}\n${buyLine}\n当前行情理论利润约${Math.min(cashSummary.dailyUserCny, stockSummary.dailyUserCny).toFixed(2)}–${Math.max(cashSummary.dailyUserCny, stockSummary.dailyUserCny).toFixed(2)}元/天。`
        .slice(0, config.notifications.maxBodyLength ?? 300)
    };
  }

  return {
    title: actionable.length ? '材料进入低价区' : '三角洲行情已更新',
    body: (buys.length ? `建议：${buys.join('、')}` : `${picks}\n暂无大额囤料信号`)
      .slice(0, config.notifications.maxBodyLength ?? 300)
  };
}

export function hasActionableBuy(recommendations) {
  return recommendations.some(item => item.buy?.action === 'buy' || item.cashBuy?.action === 'buy');
}

function money(value) {
  return nf.format(Math.round(Number(value) || 0));
}

function compactMoney(value) {
  const amount = Number(value) || 0;
  if (amount >= 100_000_000) return `${(amount / 100_000_000).toFixed(2)}亿`;
  if (amount >= 10_000) return `${(amount / 10_000).toFixed(0)}万`;
  return money(amount);
}

function shortName(value) {
  const name = String(value);
  if (/4[.]6.*30mm.*AP ST/i.test(name)) return 'AP ST';
  if (/SVD/i.test(name)) return 'SVD';
  if (name.includes('精密护甲维修包')) return '金甲修';
  if (/H09/i.test(name)) return 'H09';
  return name;
}

function chinaClock(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return {
    weekday: values.weekday,
    hour: Number(values.hour),
    hhmm: `${values.hour}:${values.minute}`
  };
}

function collectionTarget(hour, collectionTimes) {
  if (hour >= 5 && hour <= 9) return collectionTimes[0] ?? '07:00';
  if (hour >= 13 && hour <= 17) return collectionTimes[1] ?? '15:00';
  if (hour >= 22 || hour === 21) return collectionTimes[2] ?? '23:00';
  return null;
}

function buyLabel(buy) {
  if (buy.action === 'buy') return `购买约${buy.days}天用量`;
  if (buy.action === 'use-stock') return '使用旧库存，不补新料';
  if (buy.action === 'wait') return '暂不囤货，仅按需补料';
  if (buy.action === 'small-buy') return `只补约${buy.days ?? 1}天`;
  return '暂无法判断';
}

function escapePipe(value) {
  return String(value).replaceAll('|', '\\|');
}

function formatChinaTime(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).format(date);
}

function toFrontmatterTime(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}T${map.hour}:${map.minute}:${map.second}+08:00`;
}
