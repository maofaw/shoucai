const state = {
  data: null,
  settings: loadJson('shoucai.settings', {}),
  selectedDays: 'auto',
  admin: location.hash.startsWith('#manage='),
  adminKey: location.hash.startsWith('#manage=') ? decodeURIComponent(location.hash.slice('#manage='.length)) : '',
  apiBase: String(window.SHOUCAI_CONFIG?.apiBase ?? '').replace(/\/$/, ''),
  countdownTimer: null
};

const nf = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });

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
  const response = await fetch('./data/latest.json?v=' + Date.now(), { cache: 'no-store' });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  state.data = await response.json();
  await loadRemoteState();
  const defaults = state.data.defaults || {};
  state.settings = {
    accounts: wholeNumber(state.settings.accounts, defaults.accounts || 28),
    sharedAccounts: nonNegativeInteger(state.settings.sharedAccounts, Math.min(defaults.sharedAccounts ?? 10, defaults.accounts || 28)),
    userShare: nonNegativeNumber(state.settings.userShare, defaults.ownerSharePercent ?? 80),
    rate: positiveNumber(state.settings.rate, defaults.haffPerCnyWan || 52),
    budgetWan: nonNegativeNumber(state.settings.budgetWan, (defaults.buyBudgetPerAccount ?? 10_000_000) / 10_000)
  };
  state.settings.sharedAccounts = Math.min(state.settings.sharedAccounts, state.settings.accounts);
  showSettings();
  document.querySelector('#finishSell').hidden = !state.admin;
  renderAll();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

function renderAll() {
  renderFreshness();
  renderRecipes();
  renderBuyShortcut();
  renderProfit();
  renderBuys();
  renderSell();
  renderHarvest();
  document.querySelector('#sourceTime').textContent = '行情时间：' + formatDateTime(state.data.generatedAt);
  if (state.data.source?.url) document.querySelector('#sourceLink').href = state.data.source.url;
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
    const perRun = numberOrNull(item.perRunConservativeProfit);
    const weekly = numberOrNull(item.weeklyConservativeProfit);
    const backup = item.backup ? '备选：' + escapeHtml(item.backup) : '暂无备选配方';
    const delta = numberOrNull(item.backupDeltaPercent);
    const deltaText = delta == null ? '' : '（与主选相比 ' + (delta > 0 ? '+' : '') + delta.toFixed(1) + '%）';
    const detail = [
      detailRow('周末保守卖价', item.revenueConservative),
      detailRow('当前材料成本', item.currentCost),
      detailRow('交易费用', item.fee),
      detailRow('单轮保守净利润', perRun),
      detailRow('连续7天预计净利润', weekly)
    ].filter(Boolean).join('');
    return '<article class="recipe-card">' +
      '<div class="recipe-card__top"><span class="recipe-label">' + escapeHtml(item.label || item.place) + '</span><span class="duration">' + (item.hours ?? '--') + '小时/轮</span></div>' +
      '<h3 class="recipe-main">' + escapeHtml(item.main || '暂无建议') + '</h3>' +
      '<div class="recipe-profit"><span>单号每轮保守净赚</span><strong>' + (perRun == null ? '待更新' : moneyWan(perRun)) + '</strong></div>' +
      '<p class="reason">' + escapeHtml(item.reason || '按当前行情选择') + '</p>' +
      '<div class="backup-row">' + backup + escapeHtml(deltaText) + '</div>' +
      '<details class="recipe-details"><summary>查看售价和成本明细</summary><div class="detail-list">' + (detail || '<p>明细正在更新，稍后再看。</p>') + '</div><p class="detail-note">材料按当前市场价；售出价按周末历史价估算，实际成交可能不同。</p></details>' +
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
  const dailyLow = numberOrNull(profit.conservativeDailyPerAccount ?? profit.noStockDailyPerAccount) ?? (weeklyLow == null ? null : weeklyLow / 7);
  const dailyHigh = numberOrNull(profit.highDailyPerAccount) ?? (weeklyHigh == null ? null : weeklyHigh / 7);
  setText('#conservativeWeekly', weeklyLow == null ? '待更新' : moneyWan(weeklyLow * factor));
  setText('#highWeekly', weeklyHigh == null ? '待更新' : moneyWan(weeklyHigh * factor));
  setText('#conservativeCny', weeklyLow == null ? '人民币待更新' : '约 ' + nf.format(weeklyLow * factor / (state.settings.rate * 10_000)) + ' 元');
  setText('#highCny', weeklyHigh == null ? '人民币待更新' : '约 ' + nf.format(weeklyHigh * factor / (state.settings.rate * 10_000)) + ' 元');
  setText('#dailyRange', dailyLow == null ? '待更新' : moneyWan(dailyLow * factor) + (dailyHigh == null ? '' : ' ～ ' + moneyWan(dailyHigh * factor)));
  const basis = profit.basis || state.data.plan?.basis || '按当前材料价和历史周末卖价估算';
  setText('#profitBasis', basis + '；已按 ' + state.settings.accounts + ' 个号、其中 ' + state.settings.sharedAccounts + ' 个分成号（你拿 ' + state.settings.userShare + '%）计算。');
}

function renderBuyShortcut() {
  const plan = state.data.buyPlan;
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
  if (!plan) {
    now.innerHTML = '<strong>当前是否该买：暂时无法判断</strong><p>价格明细仍在更新，请暂时参考制造建议。</p>';
  } else {
    const action = plan.nowAction;
    const heading = action === 'buy' ? '现在适合买料' : action === 'budget-shortfall' ? '预算暂时不够' : action === 'wait' ? '现在先等一等' : '当前买料信号不足';
    now.classList.toggle('is-buy', action === 'buy');
    now.innerHTML = '<span class="card-kicker">现在买，还是等？</span><strong>' + heading + '</strong><p>' + escapeHtml(plan.nowReason || '暂无判断依据') + '</p>';
  }
  const suggested = [7, 14, 30].includes(Number(plan?.suggestedDays)) ? Number(plan.suggestedDays) : 7;
  const days = state.selectedDays === 'auto' ? suggested : Number(state.selectedDays);
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
  const materials = allMaterials.filter(material => !material.ignored);
  const ignoredMaterials = allMaterials.filter(material => material.ignored);
  const unit = days === 30 ? 'perAccount30Days' : days === 14 ? 'perAccount14Days' : 'perAccount7Days';
  const knownCosts = allMaterials.filter(m => numberOrNull(m.currentPrice) != null && numberOrNull(m[unit]) != null);
  const cost = allMaterials.length && knownCosts.length === allMaterials.length
    ? allMaterials.reduce((sum, m) => sum + Number(m.currentPrice) * Number(m[unit]), 0)
    : null;
  const explanation = state.selectedDays === 'auto' ? '自动建议买' + suggested + '天；可手动改' : '按你选的' + days + '天计算';
  setText('#buyBudget', explanation + '。单号预计花费 ' + (cost == null ? '待更新' : moneyWan(cost)) +
    '，你的单号预算 ' + moneyWan(budget) +
    (cost != null && cost > budget ? '，还差 ' + moneyWan(cost - budget) : '') + '。');
  if (!allMaterials.length) {
    document.querySelector('#buyList').innerHTML = '<div class="empty-state">材料单价和数量暂未拿到可靠数据，先不列出不准确的采购清单。</div>';
    return;
  }
  const ignoredNote = ignoredMaterials.length
    ? '<div class="ignored-material-note"><strong>已省略 ' + ignoredMaterials.length + ' 种便宜稳定材料</strong><p>' +
      escapeHtml(ignoredMaterials.map(material => material.name).join('、')) + '仍计入制造成本和总预算，但不再占用重点买料清单。</p></div>'
    : '';
  const cards = materials.map(material => {
    const count = numberOrNull(material[unit]);
    const price = numberOrNull(material.currentPrice);
    const target = numberOrNull(material.targetPrice);
    const buy = material.action === 'buy';
    return '<article class="material-card">' +
      '<div class="material-head"><strong>' + escapeHtml(material.name || '未知材料') + '</strong><span class="material-action ' + (buy ? 'is-buy' : '') + '">' + (buy ? '值得先买' : material.action === 'wait' ? '再等等' : '暂无信号') + '</span></div>' +
      '<p class="material-reason">' + escapeHtml(material.reason || '按本周制造方案计算') + '</p>' +
      '<div class="material-metrics"><div><span>当前单价</span><strong>' + (price == null ? '--' : nf.format(price)) + '</strong></div><div><span>建议最高买价</span><strong>' + (target == null ? '--' : nf.format(target)) + '</strong></div><div><span>单号买' + days + '天</span><strong>' + (count == null ? '--' : nf.format(count) + '个') + '</strong></div></div>' +
      '</article>';
  }).join('');
  document.querySelector('#buyList').innerHTML = ignoredNote + (cards || '<div class="empty-state">当前材料都属于便宜稳定项，无需专门盯价。</div>');
}

function renderSell() {
  const sell = state.data.sell || {};
  setText('#sellWindow', [sell.preferredWeekday, sell.preferredStartTime].filter(Boolean).join(' ') || '待更新');
  setText('#sellBasis', sell.basis || '历史卖价样本不足，暂时无法进一步判断。');
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
    return;
  }
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

function openView(target) {
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
  document.querySelector('[data-view="' + target + '"] h2')?.focus();
  window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

function bindActions() {
  document.querySelector('#buyShortcut').addEventListener('click', () => openView('buy'));
  document.querySelectorAll('.days-option').forEach(button => button.addEventListener('click', () => {
    state.selectedDays = button.dataset.days;
    renderBuys();
  }));
  document.querySelector('#settingsForm').addEventListener('submit', event => {
    event.preventDefault();
    const accounts = wholeNumber(document.querySelector('#accounts').value, 28);
    const sharedAccounts = nonNegativeInteger(document.querySelector('#sharedAccounts').value, 10);
    const userShare = nonNegativeNumber(document.querySelector('#userShare').value, 80);
    const error = document.querySelector('#settingsError');
    if (sharedAccounts > accounts || userShare > 100) {
      error.textContent = sharedAccounts > accounts ? '分成号不能多于总账号数。' : '分成比例不能超过100%。';
      error.hidden = false;
      return;
    }
    error.hidden = true;
    state.settings = {
      accounts,
      sharedAccounts,
      userShare,
      rate: positiveNumber(document.querySelector('#rate').value, 52),
      budgetWan: nonNegativeNumber(document.querySelector('#budget').value, 1000)
    };
    localStorage.setItem('shoucai.settings', JSON.stringify(state.settings));
    renderProfit();
    renderBuys();
    showToast('设置已保存在当前设备');
  });
  document.querySelector('#finishHarvest').addEventListener('click', async event => {
    const at = new Date().toISOString();
    localStorage.setItem('shoucai.lastHarvestFinishedAt', at);
    renderHarvest();
    showToast('已记录。下次收菜时间已更新');
    if (state.admin) await saveRemoteState('/state/harvest-finished', at, event.currentTarget);
  });
  document.querySelector('#finishSell').addEventListener('click', async event => {
    const at = new Date().toISOString();
    localStorage.setItem('shoucai.lastSellFinishedAt', at);
    showToast('已记录清仓完成');
    await saveRemoteState('/state/sell-finished', at, event.currentTarget);
  });
}

function showSettings() {
  setValue('#accounts', state.settings.accounts);
  setValue('#sharedAccounts', state.settings.sharedAccounts);
  setValue('#userShare', state.settings.userShare);
  setValue('#rate', state.settings.rate);
  setValue('#budget', state.settings.budgetWan);
}

async function loadRemoteState() {
  if (!state.apiBase || !state.admin) return;
  try {
    const response = await fetch(state.apiBase + '/state', { cache: 'no-store' });
    if (!response.ok) return;
    const payload = await response.json();
    const harvest = payload.state?.lastHarvestFinishedAt?.value;
    const sell = payload.state?.lastSellFinishedAt?.value;
    if (harvest) localStorage.setItem('shoucai.lastHarvestFinishedAt', harvest);
    if (sell) localStorage.setItem('shoucai.lastSellFinishedAt', sell);
  } catch {
    // 云端暂不可用时仍可用当前浏览器保存的时间。
  }
}

async function saveRemoteState(path, at, button) {
  if (!state.apiBase || !state.adminKey) return;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = '正在保存…';
  try {
    const response = await fetch(state.apiBase + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + state.adminKey },
      body: JSON.stringify({ at })
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
  } catch (error) {
    showToast('云端保存失败，本机已记录：' + error.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function showToast(message) {
  const toast = document.querySelector('#toast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 3600);
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
function relativeAge(ms) { const m = Math.max(0, Math.round(ms / 60_000)); return m < 60 ? m + '分钟前' : (m / 60).toFixed(1) + '小时前'; }
function formatDuration(ms) { const m = Math.ceil(ms / 60_000); return Math.floor(m / 60) + '小时' + (m % 60) + '分钟'; }
function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间未知' : new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date);
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
