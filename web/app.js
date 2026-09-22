const state = {
  data: null,
  settings: loadJson('shoucai.settings', null),
  admin: location.hash.startsWith('#manage='),
  adminKey: location.hash.startsWith('#manage=') ? decodeURIComponent(location.hash.slice('#manage='.length)) : '',
  apiBase: String(window.SHOUCAI_CONFIG?.apiBase ?? '').replace(/\/$/, ''),
  countdownTimer: null
};

const nf = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const moneyWan = value => {
  const amount = Number(value || 0);
  if (amount >= 100_000_000) return `${(amount / 100_000_000).toFixed(2)}亿`;
  return `${(amount / 10_000).toFixed(amount >= 1_000_000 ? 0 : 1)}万`;
};

init().catch(error => {
  showToast(`加载失败：${error.message}`);
  document.querySelector('#freshness').textContent = '行情读取失败';
  document.querySelector('#freshness').classList.add('is-stale');
});

async function init() {
  bindNavigation();
  bindActions();
  const response = await fetch(`./data/latest.json?v=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  state.data = await response.json();
  await loadRemoteState();
  if (!state.settings) {
    state.settings = {
      accounts: state.data.defaults.accounts,
      rate: state.data.defaults.haffPerCnyWan
    };
  }
  document.querySelector('#accounts').value = state.settings.accounts;
  document.querySelector('#rate').value = state.settings.rate;
  document.querySelectorAll('.admin-only').forEach(element => { element.hidden = !state.admin; });
  renderAll();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

function renderAll() {
  renderFreshness();
  renderProfit();
  renderRecipes();
  renderBuys();
  renderSell();
  renderHarvest();
  document.querySelector('#sourceTime').textContent = `行情时间：${formatDateTime(state.data.generatedAt)}`;
  document.querySelector('#sourceLink').href = state.data.source.url;
}

function renderFreshness() {
  const ageMs = Date.now() - new Date(state.data.generatedAt).getTime();
  const stale = ageMs > state.data.staleAfterHours * 3_600_000;
  const pill = document.querySelector('#freshness');
  pill.textContent = stale ? '数据已过期' : `${relativeAge(ageMs)}更新`;
  pill.classList.toggle('is-fresh', !stale);
  pill.classList.toggle('is-stale', stale);
  document.querySelector('#staleBanner').hidden = !stale;
  document.querySelector('#planState').textContent = state.data.plan.locked ? '本周已锁定' : '本周临时方案';
}

function renderProfit() {
  const profit = state.data.plan.profit;
  const accounts = positiveNumber(state.settings.accounts, state.data.defaults.accounts);
  const rateWan = positiveNumber(state.settings.rate, state.data.defaults.haffPerCnyWan);
  renderProfitScenario({
    prefix: 'cash',
    weeklyPerAccount: profit.noStockWeeklyPerAccount,
    dailyPerAccount: profit.noStockDailyPerAccount,
    accounts,
    rateWan
  });
  renderProfitScenario({
    prefix: 'stocked',
    weeklyPerAccount: profit.stockedWeeklyPerAccount,
    dailyPerAccount: profit.stockedDailyPerAccount,
    accounts,
    rateWan
  });
  document.querySelector('#stockedHint').textContent = profit.stockedStatus;
}

function renderProfitScenario({ prefix, weeklyPerAccount, dailyPerAccount, accounts, rateWan }) {
  const available = Number.isFinite(Number(weeklyPerAccount));
  const weekly = available ? Number(weeklyPerAccount) : null;
  const daily = available
    ? Number.isFinite(Number(dailyPerAccount)) ? Number(dailyPerAccount) : weekly / 7
    : null;
  const accountLabel = `${nf.format(accounts)}号`;
  document.querySelector(`#${prefix}AllDailyLabel`).textContent = `${accountLabel}日均`;
  document.querySelector(`#${prefix}AllWeeklyLabel`).textContent = `${accountLabel}一周`;
  document.querySelector(`#${prefix}DailyPerAccount`).textContent = available ? moneyWan(daily) : '--';
  document.querySelector(`#${prefix}WeeklyPerAccount`).textContent = available ? moneyWan(weekly) : '--';
  document.querySelector(`#${prefix}DailyAll`).textContent = available ? moneyWan(daily * accounts) : '--';
  document.querySelector(`#${prefix}WeeklyAll`).textContent = available ? moneyWan(weekly * accounts) : '--';
  document.querySelector(`#${prefix}Cny`).textContent = available
    ? `日约 ${nf.format(daily * accounts / (rateWan * 10_000))} 元 · 周约 ${nf.format(weekly * accounts / (rateWan * 10_000))} 元`
    : '等待首次低价买入信号';
}

function renderRecipes() {
  const root = document.querySelector('#recipeList');
  root.innerHTML = state.data.plan.recipes.map(item => `
    <article class="recipe-card">
      <div class="recipe-top">
        <div><span class="recipe-label">${escapeHtml(item.label)}</span><strong class="recipe-main">${escapeHtml(item.main ?? '暂无建议')}</strong></div>
        <span class="duration">${item.hours ?? '--'}小时 · ${item.weeklyRuns ?? '--'}轮/周</span>
      </div>
      <div class="backup-row"><span>备选：${escapeHtml(item.backup ?? '暂无')}</span><span class="delta">${formatDelta(item.backupDeltaPercent)}</span></div>
      <p class="reason">${escapeHtml(item.reason ?? '')}</p>
    </article>`).join('');
}

function renderBuys() {
  const accounts = positiveNumber(state.settings.accounts, state.data.defaults.accounts);
  document.querySelector('#buyList').innerHTML = state.data.buys.map(item => {
    const buying = item.action === 'buy';
    const materials = item.perAccountMaterials.map(material => `
      <li><span>${escapeHtml(material.name)}</span><strong>单号 ${nf.format(material.count)} / ${accounts}号 ${nf.format(material.count * accounts)}</strong></li>`).join('');
    return `<article class="buy-card">
      <div class="buy-head"><div><span>${escapeHtml(item.label)} · ${escapeHtml(item.recipe)}</span><strong>${item.days ? `建议囤${item.days}天` : escapeHtml(item.actionLabel)}</strong></div><b class="buy-action ${buying ? 'is-buy' : ''}">${buying ? escapeHtml(item.tier || '可以买入') : '继续等待'}</b></div>
      <p class="buy-reason">${escapeHtml(item.reason)}</p>
      <div class="buy-numbers"><div><span>当前整套成本</span><strong>${moneyWan(item.currentCost)}</strong></div><div><span>近30天位置</span><strong>${item.currentPercentile == null ? '--' : `${item.currentPercentile}%`}</strong></div></div>
      ${item.perAccountBudget ? `<div class="buy-numbers"><div><span>单号预算</span><strong>${moneyWan(item.perAccountBudget)}</strong></div><div><span>${accounts}号预算</span><strong>${moneyWan(item.perAccountBudget * accounts)}</strong></div></div>` : ''}
      ${materials ? `<ul class="material-list">${materials}</ul>` : ''}
    </article>`;
  }).join('');
}

function renderSell() {
  document.querySelector('#sellWindow').textContent = `${state.data.sell.preferredWeekday} ${state.data.sell.preferredStartTime}`;
  document.querySelector('#sellBasis').textContent = state.data.sell.basis;
  document.querySelector('#sellRule').textContent = `比最低价低${state.data.sell.undercutLevels}个价位`;
}

function renderHarvest() {
  clearInterval(state.countdownTimer);
  const finishedAt = localStorage.getItem('shoucai.lastHarvestFinishedAt');
  const next = finishedAt ? new Date(new Date(finishedAt).getTime() + state.data.harvest.cycleHours * 3_600_000) : null;
  const time = document.querySelector('#nextHarvest');
  const countdown = document.querySelector('#harvestCountdown');
  if (!next || Number.isNaN(next.getTime())) {
    time.textContent = '尚未记录';
    countdown.textContent = state.admin ? '完成本轮后点击按钮' : '使用专用管理链接记录完成时间';
    return;
  }
  time.textContent = formatDateTime(next);
  const update = () => {
    const remaining = next.getTime() - Date.now();
    countdown.textContent = remaining <= 0 ? '已经可以收菜' : `还有 ${formatDuration(remaining)}`;
  };
  update();
  state.countdownTimer = setInterval(update, 30_000);
}

function bindNavigation() {
  document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => {
    const target = button.dataset.target;
    document.querySelectorAll('.nav-item').forEach(item => {
      item.classList.toggle('is-active', item === button);
      item.toggleAttribute('aria-current', item === button);
    });
    document.querySelectorAll('.view').forEach(view => {
      const active = view.dataset.view === target;
      view.hidden = !active;
      view.classList.toggle('is-active', active);
    });
    document.querySelector(`[data-view="${target}"] h2`)?.focus?.();
    window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }));
}

function bindActions() {
  document.querySelector('#settingsForm').addEventListener('submit', event => {
    event.preventDefault();
    state.settings = {
      accounts: positiveNumber(document.querySelector('#accounts').value, 28),
      rate: positiveNumber(document.querySelector('#rate').value, 52)
    };
    localStorage.setItem('shoucai.settings', JSON.stringify(state.settings));
    renderProfit();
    renderBuys();
    showToast('设置已保存在当前浏览器');
  });
  document.querySelector('#finishHarvest').addEventListener('click', async event => {
    const at = new Date().toISOString();
    await saveRemoteState('/state/harvest-finished', at, event.currentTarget);
    localStorage.setItem('shoucai.lastHarvestFinishedAt', at);
    renderHarvest();
    showToast('已记录，本页已计算下次收菜时间');
  });
  document.querySelector('#finishSell').addEventListener('click', async event => {
    const at = new Date().toISOString();
    await saveRemoteState('/state/sell-finished', at, event.currentTarget);
    localStorage.setItem('shoucai.lastSellFinishedAt', at);
    document.querySelector('#planState').textContent = '等待云端生成下周方案';
    showToast('已记录清仓完成');
  });
}

async function loadRemoteState() {
  if (!state.apiBase) return;
  try {
    const response = await fetch(`${state.apiBase}/state`, { cache: 'no-store' });
    if (!response.ok) return;
    const payload = await response.json();
    const harvest = payload.state?.lastHarvestFinishedAt?.value;
    const sell = payload.state?.lastSellFinishedAt?.value;
    if (harvest) localStorage.setItem('shoucai.lastHarvestFinishedAt', harvest);
    if (sell) localStorage.setItem('shoucai.lastSellFinishedAt', sell);
  } catch {
    // 网络失败时继续使用本机保存的时间。
  }
}

async function saveRemoteState(path, at, button) {
  if (!state.apiBase || !state.adminKey) return;
  button.disabled = true;
  const original = button.textContent;
  button.textContent = '正在保存…';
  try {
    const response = await fetch(`${state.apiBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${state.adminKey}` },
      body: JSON.stringify({ at })
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    showToast(`云端保存失败，已保存在本机：${error.message}`);
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

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function formatDelta(value) {
  if (value == null) return '--';
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function relativeAge(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}分钟前`;
  return `${(minutes / 60).toFixed(1)}小时前`;
}

function formatDuration(ms) {
  const totalMinutes = Math.ceil(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}小时${minutes}分钟`;
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);
}
