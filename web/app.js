import { materialCostForDays, suggestedDaysForBudget } from './budget.js';
import { migrateSettings, calculatePlan, sortMaterials as orderMaterials, normalize as normalizeText } from './planner.js';
import { recordHarvest, revertHarvest, pendingUndo, serialQueue } from './harvest.js';

const state = {
  data: null,
  settings: loadJson('shoucai.settings', {}),
  selectedDays: 'auto',
  admin: location.hash.startsWith('#manage='),
  adminKey: location.hash.startsWith('#manage=') ? decodeURIComponent(location.hash.slice('#manage='.length)) : '',
  apiBase: String(window.SHOUCAI_CONFIG?.apiBase ?? '').replace(/\/$/, ''),
  countdownTimer: null,
  undoTimer: null
};
const queueRemote = serialQueue();

const nf = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const VALID_VIEWS = new Set(['home', 'buy', 'sell', 'settings']);

init().catch(error => {
  showToast('加载失败：' + error.message);
  const freshness = document.querySelector('#freshness');
  freshness.textContent = '行情读取失败';
  freshness.classList.add('is-stale');
  document.querySelector('#recipeList').innerHTML = '<p class="empty-state">行情读取失败，请检查网络后刷新页面。</p>';
});

async function init() {
  bindNavigation();
  bindActions();
  const response = await fetch('./data/latest.json?v=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  state.data = await response.json();
  await loadRemoteState();
  const defaults = state.data.defaults || {};
  state.settings = migrateSettings(state.settings, defaults);
  state.settings.sharedAccounts = Math.min(state.settings.sharedAccounts, state.settings.accounts);
  buildStationSettings();
  showSettings();
  document.querySelector('#finishSell').hidden = !state.admin;
  renderAll();
  restoreUndoNotice();
  setInterval(renderFreshness, 60_000);
  const initialView = new URLSearchParams(location.search).get('view');
  if (VALID_VIEWS.has(initialView) && initialView !== 'home') openView(initialView, { updateUrl: false, focus: false });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

function renderAll() {
  recomputeLocalPlan();
  renderFreshness();
  renderRecipes();
  renderBuyShortcut();
  renderProfit();
  renderBuys();
  renderSell();
  renderHarvest();
  document.querySelector('#sourceTime').textContent = '行情时间：' + formatDateTime(state.data.generatedAt);
  if (state.data.source?.url?.startsWith('https://moligod.com/')) document.querySelector('#sourceLink').href = state.data.source.url;
}

function recomputeLocalPlan() {
  if (!state.data.candidatePools) return;
  const result = calculatePlan(state.data, state.settings);
  state.data.plan = result.plan;
  state.data.buyPlan = result.buyPlan;
  state.data.sell = result.sell;
}

function renderFreshness() {
  const ageMs = Date.now() - new Date(state.data.generatedAt).getTime();
  const stale = !Number.isFinite(ageMs) || ageMs > (state.data.staleAfterHours || 4) * 3_600_000;
  const pill = document.querySelector('#freshness');
  pill.textContent = stale ? '数据已过期' : relativeAge(ageMs) + '更新';
  pill.classList.toggle('is-fresh', !stale);
  pill.classList.toggle('is-stale', stale);
  document.querySelector('#staleBanner').hidden = !stale;
  document.querySelector('#planState').textContent = state.data.plan?.locked ? '本周方案' : '随行情调整';
}

function renderRecipes() {
  const recipes = state.data.plan?.recipes || [];
  if (!recipes.length) {
    document.querySelector('#recipeList').innerHTML = '<p class="empty-state">暂时没有可用的制造建议。</p>';
    return;
  }
  document.querySelector('#recipeList').innerHTML = recipes.map(item => {
    if (item.unavailable) return '<article class="recipe-card"><span class="recipe-label">' + escapeHtml(item.label) + '</span><h3>本台暂缓开工</h3><p class="reason">所选时长内暂无当前及保守利润均为正的配方，请在设置中调整。本台未计入合计。</p></article>';
    const perRun = numberOrNull(item.perRunConservativeProfit);
    const weekly = numberOrNull(item.weeklyConservativeProfit);
    const backup = item.backup ? '备选：' + escapeHtml(item.backup) : '暂无备选配方';
    const delta = numberOrNull(item.backupDeltaPercent);
    const deltaText = delta == null ? '' : '（与主选相比 ' + (delta > 0 ? '+' : '') + delta.toFixed(1) + '%）';
    const detail = [
      detailRow('Moligod当前净利润', item.currentProfit),
      detailRow('今日最高（仅参考）', item.todayMaxProfit),
      detailRow('7日最高（仅参考）', item.sevenDayMaxProfit),
      detailRow('单轮保守净利润', perRun),
      detailRow('连续7天预计净利润', weekly)
    ].filter(Boolean).join('');
    const evidence = item.evidence ? `${item.evidence.source || 'Moligod'} · 最近${state.settings.historyDays}天 · ${item.evidence.sampleCount || 0}条样本${item.evidence.weekendOnly ? ' · 周末数据' : ' · 全时段'} · 每周${item.weeklyRuns}轮` : '历史样本不足';
    const otherMode = item.otherMode ? '<div class="alternate-mode"><span>' + escapeHtml(item.otherMode.mode) + '最佳</span><strong>' + escapeHtml(item.otherMode.name) + ' · ' + item.otherMode.hours + '小时</strong><small>单号周保守 ' + moneyWan(item.otherMode.weeklyProfit) + '</small></div>' : '';
    return '<article class="recipe-card">' +
      '<div class="recipe-card__top"><span class="recipe-label">' + escapeHtml(item.label || item.place) + '</span><span class="duration">' + (item.hours ?? '--') + '小时/轮</span></div>' +
      '<h3 class="recipe-main">' + escapeHtml(item.main || '暂无建议') + '</h3>' +
      '<div class="recipe-profit"><span>单号每轮保守净赚</span><strong>' + (perRun == null ? '待更新' : moneyWan(perRun)) + '</strong></div>' +
      '<p class="reason">' + escapeHtml(item.reason || '按当前行情选择') + '</p>' +
      '<div class="backup-row">' + backup + escapeHtml(deltaText) + '</div>' +
      otherMode + '<details class="recipe-details"><summary>查看利润依据</summary><div class="detail-list">' + (detail || '<p>明细正在更新，稍后再看。</p>') + '</div><p class="detail-note">' + escapeHtml(evidence) + (item.provisional ? '；历史不足，当前为临时估算。' : '；来自原生特勤收益曲线。') + '</p></details>' +
      '</article>';
  }).join('');
}

function detailRow(label, rawValue) {
  const value = numberOrNull(rawValue);
  return value == null ? '' : '<div><span>' + label + '</span><strong>' + moneyWan(value) + '</strong></div>';
}

function renderProfit() {
  const profit = state.data.plan?.profit || {};
  const factor = state.settings.accounts - state.settings.sharedAccounts + state.settings.sharedAccounts * state.settings.userShare / 100;
  const weeklyLow = numberOrNull(profit.conservativeWeeklyPerAccount ?? profit.noStockWeeklyPerAccount);
  const weeklyHigh = numberOrNull(profit.highWeeklyPerAccount);
  const monthlyLow = numberOrNull(profit.conservativeMonthlyPerAccount) ?? (weeklyLow == null ? null : weeklyLow * 30 / 7);
  const dailyLow = numberOrNull(profit.conservativeDailyPerAccount ?? profit.noStockDailyPerAccount) ?? (weeklyLow == null ? null : weeklyLow / 7);
  const dailyHigh = numberOrNull(profit.highDailyPerAccount) ?? (weeklyHigh == null ? null : weeklyHigh / 7);
  setText('#conservativeMonthly', monthlyLow == null ? '待更新' : moneyWan(monthlyLow * factor));
  setText('#conservativeWeekly', weeklyLow == null ? '待更新' : moneyWan(weeklyLow * factor));
  setText('#highWeekly', weeklyHigh == null ? '待更新' : moneyWan(weeklyHigh * factor));
  setText('#conservativeMonthlyCny', monthlyLow == null ? '人民币待更新' : '约 ' + nf.format(monthlyLow * factor / (state.settings.rate * 10_000)) + ' 元');
  setText('#conservativeCny', weeklyLow == null ? '人民币待更新' : '约 ' + nf.format(weeklyLow * factor / (state.settings.rate * 10_000)) + ' 元');
  setText('#highCny', weeklyHigh == null ? '人民币待更新' : '约 ' + nf.format(weeklyHigh * factor / (state.settings.rate * 10_000)) + ' 元');
  setText('#dailyRange', dailyLow == null ? '待更新' : moneyWan(dailyLow * factor) + (dailyHigh == null ? '' : ' ～ ' + moneyWan(dailyHigh * factor)));
  document.querySelector('#monthlyCard').classList.toggle('is-negative', monthlyLow != null && monthlyLow < 0);
  document.querySelector('#profitBreakdown').innerHTML = [detailRow('单号日均保守', dailyLow), detailRow('单号周保守', weeklyLow),
    detailRow('单号30天保守', monthlyLow), detailRow('所有账号周利润（未分成）', weeklyLow * state.settings.accounts),
    detailRow('每周朋友分成', weeklyLow * (state.settings.accounts - factor))].join('');
  document.querySelector('#conservativeCard').classList.toggle('is-negative', weeklyLow != null && weeklyLow < 0);
  document.querySelector('#highCard').classList.toggle('is-negative', weeklyHigh != null && weeklyHigh < 0);
  const basis = profit.basis || state.data.plan?.basis || '按当前材料价和历史周末卖价估算';
  setText('#profitBasis', basis + '；已按 ' + state.settings.accounts + ' 个号、其中 ' + state.settings.sharedAccounts + ' 个分成号（你拿 ' + state.settings.userShare + '%）计算。');
}

function renderBuyShortcut() {
  const plan = state.data.buyPlan;
  const buyable = plan?.materials?.filter(item => item.action === 'buy' && !item.watchOnly) ?? [];
  if (buyable.length) {
    setText('#buyShortcutTitle', buyable.length + '种材料已到囤货价');
    setText('#buyShortcutDetail', '查看各材料可买天数；整套采购还需参考预算和其他材料价格');
    return;
  }
  if (!plan || plan.status !== 'ready' || !plan.primaryWindow) {
    setText('#buyShortcutTitle', '本周没有可靠的最低买料时段');
    setText('#buyShortcutDetail', '达到好价就买，点开查看材料清单');
    return;
  }
  if (plan.nowAction === 'buy') {
    setText('#buyShortcutTitle', '现在可以买料');
    setText('#buyShortcutDetail', plan.nowReason || '现在的整套材料价格优于常见低价');
    return;
  }
  setText('#buyShortcutTitle', '本周首选 ' + plan.primaryWindow.label + ' 买料');
  setText('#buyShortcutDetail', plan.primaryWindow.reason || '点开查看备选时段和材料清单');
}

function renderBuys() {
  const plan = state.data.buyPlan;
  const timing = document.querySelector('#buyTiming');
  const now = document.querySelector('#buyNow');
  if (plan?.status === 'ready' && plan.primaryWindow) {
    timing.innerHTML = '<span class="card-kicker">本周买料时间</span>' +
      windowHtml('首选', plan.primaryWindow) +
      (plan.backupWindow ? windowHtml('备选', plan.backupWindow) : '') +
      '<p class="evidence-note">按四台一周需要的整套材料比较历史价格；配方变化时会重新计算。</p>';
  } else {
    timing.innerHTML = '<span class="card-kicker">本周买料时间</span><strong>没有可靠的首选时段</strong><p>历史价格看不出哪个时段明显更便宜。达到好价就买，不用特意熬夜等。</p>';
  }
  const suggested = suggestedDaysForBudget(plan, state.settings.budgetWan);
  const days = state.selectedDays === 'auto' ? suggested : Number(state.selectedDays);
  const sevenDayCost = materialCostForDays(plan, 7);
  const budget = state.settings.budgetWan * 10_000;
  const budgetShortfall = sevenDayCost != null && sevenDayCost > budget;
  now.classList.remove('is-buy', 'is-shortfall');
  if (!plan) {
    now.innerHTML = '<strong>当前是否该买：暂时无法判断</strong><p>价格明细仍在更新，请暂时参考制造建议。</p>';
  } else {
    const action = plan.nowAction;
    const canBuy = action === 'buy' && !budgetShortfall;
    const heading = budgetShortfall ? '预算还不够买7天' : action === 'buy' ? '现在适合买料' : action === 'budget-shortfall' ? '预算暂时不够' : action === 'wait' ? '现在先等一等' : '当前买料信号不足';
    const reason = budgetShortfall
      ? '按你设置的单号预算，还差' + moneyWan(sevenDayCost - budget) + '才能买够7天。'
      : plan.nowReason || '暂无判断依据';
    now.classList.toggle('is-buy', canBuy);
    now.classList.toggle('is-shortfall', budgetShortfall);
    now.innerHTML = '<span class="card-kicker">现在买，还是等？</span><strong>' + heading + '</strong><p>' + escapeHtml(reason) + '</p>';
  }
  document.querySelectorAll('.days-option').forEach(button => {
    const selected = button.dataset.days === state.selectedDays;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  renderMaterials(plan, days, suggested);
}

function windowHtml(kind, value) {
  const time = value.label || [value.weekday, value.startTime && value.endTime ? value.startTime + '–' + value.endTime : ''].filter(Boolean).join(' ');
  return '<div class="window-row"><span class="window-badge">' + kind + '</span><div><strong>' + escapeHtml(time || '待确认') + '</strong><p>' + escapeHtml(value.reason || '按历史价格统计') + '</p></div></div>';
}

function renderMaterials(plan, days, suggested) {
  const budget = state.settings.budgetWan * 10_000;
  const allMaterials = plan?.materials || [];
  const productionMaterials = allMaterials.filter(material => !material.watchOnly);
  const materials = sortMaterials(productionMaterials.filter(material => !material.ignored));
  const watchMaterials = sortMaterials(allMaterials.filter(material => material.watchOnly));
  const ignoredMaterials = productionMaterials.filter(material => material.ignored);
  const unit = days === 30 ? 'perAccount30Days' : days === 14 ? 'perAccount14Days' : 'perAccount7Days';
  const knownCosts = productionMaterials.filter(m => numberOrNull(m.currentPrice) != null && numberOrNull(m[unit]) != null);
  const cost = productionMaterials.length && knownCosts.length === productionMaterials.length
    ? productionMaterials.reduce((sum, m) => sum + Number(m.currentPrice) * Number(m[unit]), 0)
    : null;
  const explanation = state.selectedDays === 'auto' ? (plan?.nowAction === 'buy' ? '自动建议买' + suggested + '天；可手动改' : '先展示7天备料数量；请按各材料低价信号分批买') : '按你选的' + days + '天计算';
  setText('#buyBudget', explanation + '。单号预计花费 ' + (cost == null ? '待更新' : moneyWan(cost)) +
    '，你的单号预算 ' + moneyWan(budget) +
    (cost != null && cost > budget ? '，还差 ' + moneyWan(cost - budget) : '') + '。');
  if (!allMaterials.length) {
    document.querySelector('#buyList').innerHTML = '<div class="empty-state">材料单价和数量暂未拿到可靠数据，先不列出不准确的采购清单。</div>';
    return;
  }
  const ignoredNote = ignoredMaterials.length
    ? '<details class="ignored-material-note"><summary>已省略 ' + ignoredMaterials.length + ' 种便宜稳定材料</summary><p>' +
      escapeHtml(ignoredMaterials.map(material => material.name).join('、')) + '仍计入制造成本和总预算。</p></details>'
    : '';
  const materialCard = material => {
    const count = numberOrNull(material[unit]);
    const price = numberOrNull(material.currentPrice);
    const target = numberOrNull(material.tierThresholds?.['days' + days] ?? material.targetPrice);
    const buy = material.action === 'buy';
    return '<article class="material-card' + (material.watchOnly ? ' material-card--watch' : '') + '">' +
      '<div class="material-head"><strong>' + escapeHtml(material.name || '未知材料') + '</strong><span class="material-action ' + (buy ? 'is-buy' : '') + '">' + (buy ? '已到' + material.tierDays + '天好价' : material.action === 'wait' ? '再等等' : '暂无信号') + '</span></div>' +
      '<p class="material-reason">' + escapeHtml(material.reason || '按本周制造方案计算') + '</p>' +
      (buy && days > material.tierDays ? '<p class="material-reason">目前仅达到' + material.tierDays + '天好价；下方' + days + '天数量仅作备料参考，不建议一次买足。</p>' : '') +
      (material.exchangeFor ? '<p class="exchange-tag">用于兑换 ' + escapeHtml(material.exchangeFor) + '</p>' : material.acquisitionNote ? '<p class="acquisition-note">' + escapeHtml(material.acquisitionNote) + '</p>' : '') +
      '<div class="material-metrics"><div><span>当前单价</span><strong>' + (price == null ? '--' : nf.format(price)) + '</strong></div><div><span>建议最高买价</span><strong>' + (target == null ? '--' : nf.format(target)) + '</strong></div><div><span>单号' + (material.watchOnly ? '备料' : '买') + days + '天</span><strong>' + (count == null ? '--' : nf.format(count) + '个') + '</strong></div><div><span>单号预计花费</span><strong>' + (price == null || count == null ? '--' : moneyWan(price * count)) + '</strong></div></div><p class="material-recipes">用于：' + escapeHtml((material.recipes || []).join('、') || '当前制造方案') + '</p>' +
      '</article>';
  };
  const cards = materials.map(materialCard).join('');
  const watchSection = watchMaterials.length
    ? '<div class="watch-material-heading"><strong>稳定方案备料</strong><p>当前不一定生产，但继续盯价，避免常用配方需要切回时没有材料。</p></div>' + watchMaterials.map(materialCard).join('')
    : '';
  document.querySelector('#buyList').innerHTML = ignoredNote +
    (cards || '<div class="empty-state">当前生产材料都属于便宜稳定项，无需专门盯价。</div>') + watchSection;
}

function sortMaterials(rows) {
  return orderMaterials(rows);
}

function renderSell() {
  const sell = state.data.sell || {};
  setText('#sellWindow', sell.preferredWindow || [sell.preferredWeekday, sell.preferredStartTime].filter(Boolean).join(' ') || '待更新');
  setText('#sellBasis', sell.basis || '历史卖价样本不足，暂时无法进一步判断。');
  setText('#sellConfidence', sell.ready ? '可信度 ' + (sell.confidence || '中') : '暂用习惯时间');
  setText('#sellCoverage', sell.ready
    ? '覆盖 ' + (sell.coveredRecipes || 0) + '/' + (sell.totalRecipes || 4) + ' 台 · ' + (sell.observedWeeks || 0) + ' 个周末'
    : '等待更多周末样本');
  const backupRow = document.querySelector('#sellBackupRow');
  backupRow.hidden = !sell.backupWindow;
  if (sell.backupWindow) setText('#sellBackup', sell.backupWindow);
  setText('#sellRule', '比当前最低价低' + (sell.undercutLevels || 1) + '个价位');
}

function renderHarvest() {
  clearInterval(state.countdownTimer);
  const finishedAt = localStorage.getItem('shoucai.lastHarvestFinishedAt');
  const hours = state.data.harvest?.cycleHours || 8;
  const next = finishedAt ? new Date(new Date(finishedAt).getTime() + hours * 3_600_000) : null;
  const time = document.querySelector('#nextHarvest');
  const countdown = document.querySelector('#harvestCountdown');
  if (!next || Number.isNaN(next.getTime())) {
    time.textContent = '尚未记录';
    countdown.textContent = '完成本轮后点击按钮，会按实际时间推算下轮';
    setText('#lastHarvest', '本轮完成时间：尚未记录');
    return;
  }
  setText('#lastHarvest', '本轮完成时间：' + formatDateTime(new Date(finishedAt)));
  time.textContent = formatDateTime(next);
  const update = () => {
    const remaining = next.getTime() - Date.now();
    countdown.textContent = remaining <= 0 ? '已经可以收菜' : '还有 ' + formatDuration(remaining);
  };
  update();
  state.countdownTimer = setInterval(update, 30_000);
}

function bindNavigation() {
  document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => openView(button.dataset.target)));
}

function openView(target, { updateUrl = true, focus = true } = {}) {
  if (!VALID_VIEWS.has(target)) target = 'home';
  document.querySelectorAll('.nav-item').forEach(item => {
    const active = item.dataset.target === target;
    item.classList.toggle('is-active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  document.querySelectorAll('.view').forEach(view => {
    const active = view.dataset.view === target;
    view.hidden = !active;
    view.classList.toggle('is-active', active);
  });
  if (focus) document.querySelector('[data-view="' + target + '"] h2')?.focus();
  if (updateUrl) {
    const url = new URL(location.href);
    if (target === 'home') url.searchParams.delete('view');
    else url.searchParams.set('view', target);
    if (url.href !== location.href) history.pushState({ view: target }, '', url);
  }
  window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

function bindActions() {
  document.querySelector('#settingsForm').addEventListener('input', () => setText('#settingsStatus', '有尚未保存的修改，点击“保存并立即重算”后生效。'));
  window.addEventListener('popstate', () => openView(new URLSearchParams(location.search).get('view') || 'home', { updateUrl: false }));
  document.querySelector('#settingsForm').addEventListener('invalid', event => {
    event.target.closest('details')?.setAttribute('open', '');
    const error = document.querySelector('#settingsError');
    error.textContent = '请检查已展开的输入项：不能为空，数值需在允许范围内。'; error.hidden = false;
  }, true);
  document.querySelector('#buyShortcut').addEventListener('click', () => openView('buy'));
  document.querySelectorAll('.days-option').forEach(button => button.addEventListener('click', () => {
    state.selectedDays = button.dataset.days;
    renderBuys();
  }));
  document.querySelector('#settingsForm').addEventListener('submit', event => {
    event.preventDefault();
    const error = document.querySelector('#settingsError');
    try {
      const next = readSettingsForm();
      localStorage.setItem('shoucai.settings', JSON.stringify(next));
      state.settings = next;
      error.hidden = true;
      renderAll();
      setText('#settingsStatus', '已保存到当前设备，所有建议已重新计算');
      showToast('设置已保存，制造和买料建议已重新计算');
    } catch (failure) {
      error.textContent = failure.message; error.hidden = false;
      error.scrollIntoView({ block: 'center' });
    }
  });
  document.querySelector('#finishHarvest').addEventListener('click', async event => {
    const at = new Date().toISOString();
    try { recordHarvest(localStorage, at); } catch (error) { showToast(error.message); return; }
    renderHarvest();
    restoreUndoNotice();
    if (state.admin) await saveRemoteState('/state/harvest-finished', at, event.currentTarget);
  });
  document.querySelector('#editHarvest').addEventListener('click', () => {
    const stored = localStorage.getItem('shoucai.lastHarvestFinishedAt');
    const date = stored && Number.isFinite(new Date(stored).getTime()) ? new Date(stored) : new Date();
    document.querySelector('#harvestFinishedAt').value = toLocalInputValue(date);
    document.querySelector('#harvestFinishedAt').max = toLocalInputValue(new Date());
    document.querySelector('#harvestError').hidden = true;
    document.querySelector('#harvestEditForm').hidden = false;
  });
  document.querySelector('#cancelHarvestEdit').addEventListener('click', () => { document.querySelector('#harvestEditForm').hidden = true; });
  document.querySelector('#harvestEditForm').addEventListener('submit', async event => {
    event.preventDefault(); const input = document.querySelector('#harvestFinishedAt'); const date = new Date(input.value);
    const error = document.querySelector('#harvestError');
    if (Number.isNaN(date.getTime()) || date.getTime() > Date.now()) { error.textContent = '请选择有效且不晚于现在的完成时间。'; error.hidden = false; return; }
    const at = date.toISOString();
    try { recordHarvest(localStorage, at); } catch (failure) { error.textContent = failure.message; error.hidden = false; return; }
    error.hidden = true; event.currentTarget.hidden = true; renderHarvest();
    restoreUndoNotice(); if (state.admin) await saveRemoteState('/state/harvest-finished', at, document.querySelector('#editHarvest'));
  });
  document.querySelector('#resetSettings').addEventListener('click', () => {
    if (!confirm('确定恢复全部默认设置吗？账号、分成和制造规则都会恢复。')) return;
    localStorage.removeItem('shoucai.settings'); location.reload();
  });
  document.querySelectorAll('[data-reset-group]').forEach(button => button.addEventListener('click', () => resetSettingsGroup(button.dataset.resetGroup)));
  document.querySelector('#finishSell').addEventListener('click', async event => {
    const at = new Date().toISOString();
    localStorage.setItem('shoucai.lastSellFinishedAt', at);
    showToast('已记录清仓完成');
    await saveRemoteState('/state/sell-finished', at, event.currentTarget);
  });
}

function resetSettingsGroup(group) {
  const defaults = state.data.defaults || {};
  const fresh = migrateSettings({}, defaults);
  const draft = readSettingsForm(false);
  if (group === 'basic') Object.assign(state.settings, { accounts: fresh.accounts, sharedAccounts: fresh.sharedAccounts,
    userShare: fresh.userShare, rate: fresh.rate, budgetWan: fresh.budgetWan });
  if (group === 'stations') for (const place of ['workbench', 'pharmacy', 'armory']) state.settings.stations[place] = fresh.stations[place];
  if (group === 'tech') {
    state.settings.techMode = fresh.techMode;
    state.settings.stations.tech = fresh.stations.tech;
  }
  if (group === 'profit') Object.assign(state.settings, { conservativePercentile: 25, highPercentile: 75, historyDays: 15 });
  if (group === 'buy') Object.assign(state.settings, { buy7: 30, buy14: 15, buy30: 5, stableShare: 3, stableSpread: 8 });
  localStorage.setItem('shoucai.settings', JSON.stringify(state.settings));
  const saved = state.settings;
  if (group === 'basic') for (const key of ['accounts', 'sharedAccounts', 'userShare', 'rate', 'budgetWan']) draft[key] = saved[key];
  if (group === 'stations') for (const place of ['workbench', 'pharmacy', 'armory']) draft.stations[place] = saved.stations[place];
  if (group === 'tech') { draft.techMode = saved.techMode; draft.stations.tech = saved.stations.tech; }
  if (group === 'profit') for (const key of ['conservativePercentile', 'highPercentile', 'historyDays']) draft[key] = saved[key];
  if (group === 'buy') for (const key of ['buy7', 'buy14', 'buy30', 'stableShare', 'stableSpread']) draft[key] = saved[key];
  state.settings = draft; buildStationSettings(); showSettings(); state.settings = saved;
  renderAll(); showToast('本组已恢复默认；其他未保存的输入仍保留');
}

function readSettingsForm(validate = true) {
  const next = structuredClone(state.settings);
  const fields = { accounts: 'accounts', sharedAccounts: 'sharedAccounts', userShare: 'userShare', rate: 'rate', budgetWan: 'budget',
    conservativePercentile: 'conservativePercentile', highPercentile: 'highPercentile', historyDays: 'historyDays',
    buy7: 'buy7', buy14: 'buy14', buy30: 'buy30', stableShare: 'stableShare', stableSpread: 'stableSpread' };
  for (const [key, id] of Object.entries(fields)) next[key] = Number(document.getElementById(id).value);
  next.techMode = document.querySelector('#techMode').value;
  document.querySelectorAll('[data-station]').forEach(group => {
    const setting = next.stations[group.dataset.station];
    setting.allowedHours = [...group.querySelectorAll('[data-hour]:checked')].map(input => Number(input.value));
    setting.preferred = group.querySelector('[data-preferred]').value;
    setting.threshold = Number(group.querySelector('[data-threshold]').value);
    setting.weeklyRuns = Number(group.querySelector('[data-runs]').value);
  });
  next.stations.tech.threshold = Number(document.querySelector('#techThreshold').value);
  document.querySelectorAll('[data-tech-mode]').forEach(group => {
    const mode = group.dataset.techMode;
    next.stations.tech[`${mode}Hours`] = [...group.querySelectorAll('[data-hour]:checked')].map(input => Number(input.value));
    next.stations.tech[`${mode}Preferred`] = group.querySelector('[data-preferred]').value;
    group.querySelectorAll('[data-tech-runs]').forEach(input => { next.stations.tech.runsByHours[input.dataset.techRuns] = Number(input.value); });
  });
  if (validate) {
    if (next.sharedAccounts > next.accounts) throw new Error('分成号不能多于总账号数。');
    if (next.buy30 > next.buy14 || next.buy14 > next.buy7) throw new Error('囤货越久，买价要越低：30天分位 ≤ 14天分位 ≤ 7天分位。');
    for (const [place, rule] of Object.entries(next.stations)) {
      const hours = place === 'tech' ? rule[`${next.techMode}Hours`] : rule.allowedHours;
      if (!hours.length) throw new Error(`${state.data.defaults.placeRules[place].label}至少选择一种制造时长。`);
      if (place !== 'tech' && rule.weeklyRuns > Math.min(...hours.map(hour => 168 / hour))) throw new Error(`${state.data.defaults.placeRules[place].label}的周轮数超过所选时长的最高产能，请降低轮数或取消较长时长。`);
    }
  }
  return next;
}

function showSettings() {
  setValue('#accounts', state.settings.accounts);
  setValue('#sharedAccounts', state.settings.sharedAccounts);
  setValue('#userShare', state.settings.userShare);
  setValue('#rate', state.settings.rate);
  setValue('#budget', state.settings.budgetWan);
  setValue('#techMode', state.settings.techMode);
  setValue('#techThreshold', state.settings.stations.tech.threshold);
  setValue('#conservativePercentile', state.settings.conservativePercentile); setValue('#highPercentile', state.settings.highPercentile);
  setValue('#historyDays', state.settings.historyDays);
  setValue('#buy7', state.settings.buy7); setValue('#buy14', state.settings.buy14); setValue('#buy30', state.settings.buy30);
  setValue('#stableShare', state.settings.stableShare); setValue('#stableSpread', state.settings.stableSpread);
}

function buildStationSettings() {
  const labels = state.data.defaults.placeRules || {};
  document.querySelector('#stationSettings').innerHTML = ['workbench', 'pharmacy', 'armory'].map(place => {
    const rule = labels[place] || {}; const setting = state.settings.stations[place]; const pool = state.data.candidatePools?.[place] || [];
    const hours = [...new Set(pool.map(item => item.hours))].sort((a, b) => a - b);
    const options = '<option value="">自动选择，不保留常用配方</option>' + pool.map(item => '<option value="' + escapeHtml(item.name) + '"' + (normalizeText(item.name) === normalizeText(setting.preferred) ? ' selected' : '') + '>' + escapeHtml(item.name) + '（' + item.hours + '小时）</option>').join('');
    return '<fieldset class="station-rule" data-station="' + place + '"><legend>' + escapeHtml(rule.label || place) + '</legend>' +
      '<div class="hour-checks">' + hours.map(hour => '<label><input data-hour type="checkbox" value="' + hour + '"' + (setting.allowedHours.includes(hour) ? ' checked' : '') + '>' + hour + '小时</label>').join('') + '</div>' +
      '<label>常用配方<select data-preferred>' + options + '</select></label><label>换配方门槛<div class="input-suffix"><input data-threshold type="number" min="0" max="100" step="0.5" value="' + setting.threshold + '"><span>%</span></div></label>' +
      (place === 'tech' ? '' : '<label>每周实际轮数<input data-runs type="number" min="0.5" max="100" step="0.5" value="' + setting.weeklyRuns + '"></label>') + '</fieldset>';
  }).join('');
  const rule = state.settings.stations.tech;
  const pool = state.data.candidatePools.tech || [];
  document.querySelector('#techSettings').innerHTML = ['long', 'short'].map(mode => {
    const hours = mode === 'long' ? [16, 24] : [...new Set(pool.filter(item => item.category !== 'gun' && item.hours >= 4 && item.hours <= 8).map(item => item.hours))].sort((a,b) => a-b);
    const choices = pool.filter(item => hours.includes(item.hours) && (mode === 'long' ? item.category === 'gun' : item.category !== 'gun'));
    return '<fieldset class="station-rule" data-tech-mode="' + mode + '"><legend>' + (mode === 'long' ? '长时枪械' : '短时配件') + '</legend><div class="hour-checks">' + hours.map(hour => '<label><input type="checkbox" data-hour value="' + hour + '"' + (rule[mode + 'Hours'].includes(hour) ? ' checked' : '') + '>' + hour + '小时</label>').join('') + '</div><label>常用配方<select data-preferred><option value="">自动选择，不保留常用配方</option>' + choices.map(item => '<option value="' + escapeHtml(item.name) + '"' + (normalizeText(rule[mode + 'Preferred']) === normalizeText(item.name) ? ' selected' : '') + '>' + escapeHtml(item.name) + '（' + item.hours + '小时）</option>').join('') + '</select></label>' + hours.map(hour => '<label>' + hour + '小时每周实际收取轮数<input data-tech-runs="' + hour + '" type="number" min="0.5" step="0.5" max="' + Math.floor(168 / hour * 2) / 2 + '" value="' + (rule.runsByHours[hour] ?? 17.5) + '" required></label>').join('') + '</fieldset>';
  }).join('');
  document.querySelectorAll('#settingsForm input[type="number"]').forEach(input => { input.required = true; });
}

async function undoHarvest() {
  let value;
  try { value = revertHarvest(localStorage); } catch (error) { showToast(error.message); return; }
  renderHarvest(); showToast('已撤销本次记录');
  if (state.admin) await saveRemoteState('/state/harvest-finished', value, document.querySelector('#editHarvest'));
}

function restoreUndoNotice() {
  const record = pendingUndo(localStorage);
  if (record) showToast('已记录完成时间，10秒内可撤销', '撤销', undoHarvest, Math.max(0, record.expiresAt - Date.now()));
}

async function loadRemoteState() {
  if (!state.apiBase || !state.admin || localStorage.getItem('shoucai.pendingRemote') || pendingUndo(localStorage)) return;
  try {
    const response = await fetch(state.apiBase + '/state', { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return;
    const payload = await response.json();
    const harvest = payload.state?.lastHarvestFinishedAt?.value;
    const sell = payload.state?.lastSellFinishedAt?.value;
    if (harvest && Number.isFinite(new Date(harvest).getTime())) localStorage.setItem('shoucai.lastHarvestFinishedAt', harvest);
    else if (payload.state) localStorage.removeItem('shoucai.lastHarvestFinishedAt');
    if (sell) localStorage.setItem('shoucai.lastSellFinishedAt', sell);
  } catch {
    // 云端暂不可用时仍可用当前浏览器保存的时间。
  }
}

async function saveRemoteState(path, at, button) {
  if (!state.apiBase || !state.adminKey) return;
  const pending = JSON.stringify({ path, at });
  localStorage.setItem('shoucai.pendingRemote', pending);
  return queueRemote(async () => {
  button.disabled = true;
  const original = button.textContent;
  button.textContent = '正在保存…';
  try {
    const response = await fetch(state.apiBase + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.adminKey },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ at })
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    if (localStorage.getItem('shoucai.pendingRemote') === pending) localStorage.removeItem('shoucai.pendingRemote');
  } catch (error) {
    const record = pendingUndo(localStorage);
    showToast('云端保存失败，本机已保留。可稍后重新修改时间同步。', record ? '撤销' : '', record ? undoHarvest : null,
      record ? record.expiresAt - Date.now() : 6000);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
  });
}

function showToast(message, actionLabel = '', action = null, duration = action ? 10_000 : 3600) {
  const toast = document.querySelector('#toast');
  setText('#toastMessage', message); const button = document.querySelector('#toastAction');
  button.hidden = !action; button.textContent = actionLabel; button.onclick = action ? () => { action(); button.hidden = true; } : null;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; button.hidden = true; }, duration);
}

function toLocalInputValue(date) {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function setText(selector, value) { document.querySelector(selector).textContent = value; }
function setValue(selector, value) { document.querySelector(selector).value = value; }
function loadJson(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
function numberOrNull(value) { return value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value); }
function positiveNumber(value, fallback) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : fallback; }
function nonNegativeNumber(value, fallback) { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : fallback; }
function wholeNumber(value, fallback) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : fallback; }
function nonNegativeInteger(value, fallback) { const n = Number(value); return Number.isInteger(n) && n >= 0 ? n : fallback; }
function moneyWan(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '--';
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  if (abs >= 100_000_000) return sign + (abs / 100_000_000).toFixed(2) + '亿';
  if (abs >= 10_000) return sign + (abs / 10_000).toFixed(abs >= 1_000_000 ? 0 : 1) + '万';
  return sign + nf.format(abs);
}
function relativeAge(ms) { const m = Math.max(0, Math.round(ms / 60_000)); return m < 1 ? '刚刚' : m < 60 ? m + '分钟前' : (m / 60).toFixed(1) + '小时前'; }
function formatDuration(ms) { const m = Math.ceil(ms / 60_000); return Math.floor(m / 60) + '小时' + (m % 60) + '分钟'; }
function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date);
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
