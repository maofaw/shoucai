import { materialCostForDays, suggestedDaysForBudget } from './budget.js';
import { migrateSettings, calculatePlan, rankCandidates, sortMaterials as orderMaterials, normalize as normalizeText,
  ADOPTION_KEY, STOCK_KEY, validAdoption, validStockedMaterials, saveStockedMaterial, removeStockedMaterial,
  adoptProposal, adoptRecipe, adoptPlanSummary } from './planner.js';
import { recordHarvest, revertHarvest, pendingUndo, serialQueue } from './harvest.js';
import { createMarketRefresher, MARKET_CHECK_MS } from './market-refresh.js';
import { procurement } from './scenarios.js';

const state = {
  data: null,
  settings: loadJson('shoucai.settings', null),
  selectedDays: 'auto',
  adoption: validAdoption(loadJson(ADOPTION_KEY, null)),
  stocked: validStockedMaterials(loadJson(STOCK_KEY, null)),
  proposal: null,
  refresher: null,
  admin: location.hash.startsWith('#manage='),
  adminKey: location.hash.startsWith('#manage=') ? decodeURIComponent(location.hash.slice('#manage='.length)) : '',
  apiBase: String(window.SHOUCAI_CONFIG?.apiBase ?? '').replace(/\/$/, ''),
  countdownTimer: null,
  undoTimer: null,
  recipePicker: null,
  planPreview: null,
  stockEditor: null,
  showAllOpportunities: false,
  selectedPlanType: 'current',
  profitPeriod: loadJson('shoucai.uiPreferences', null)?.profitPeriod ?? 'month',
  lazy: validLazyState(loadJson('shoucai.lazyMode', null)),
  lastStablePlan: loadJson('shoucai.lastStablePlan', null)
};
const queueRemote = serialQueue();

const nf = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const VALID_VIEWS = new Set(['home', 'plans', 'buy', 'sell', 'settings']);

function validLazyState(value) {
  return { version: 1, enabled: value?.version === 1 && value.enabled === true,
    backupAdoption: validAdoption(value?.backupAdoption), advanced: value?.advanced === true };
}

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
  await loadRemoteState();
  state.refresher = createMarketRefresher({ load: async () => {
    if (state.data) {
      try {
        const check = await fetch('./data/version.json?v=' + Date.now(), {cache:'no-store',signal:AbortSignal.timeout(10_000)});
        if (check.ok && check.headers.get('x-shoucai-offline') !== '1') {
          const version = await check.json();
          if (version.builtAt === state.data.builtAt && version.generatedAt === state.data.generatedAt) return {data:state.data,offline:false};
        }
      } catch { /* The full snapshot path also supports old deployments and offline cache. */ }
    }
    const response = await fetch('./data/latest.json?v=' + Date.now(), { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return { data: await response.json(), offline: response.headers.get('x-shoucai-offline') === '1' };
  }, onData: data => {
    const first = !state.data;
    const settings = first ? migrateSettings(state.settings, data.defaults || {}) : state.settings;
    const result = calculatePlan(data, settings, state.adoption, state.lazy.enabled ? { version: 1, items: [] } : state.stocked);
    state.data = data;
    if (first) {
      state.settings = settings;
      buildStationSettings(); showSettings();
      document.querySelector('#scenarioDays').value = state.settings.scenarioDays;
    }
    renderAll(result);
  }, onStatus: renderRefreshStatus });
  await state.refresher.check(true);
  document.querySelector('#finishSell').hidden = !state.admin;
  restoreUndoNotice();
  setInterval(() => { if (state.data) renderFreshness(); }, 60_000);
  setInterval(() => { if (!document.hidden) state.refresher.check(); }, MARKET_CHECK_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) state.refresher.check(); });
  window.addEventListener('online', () => state.refresher.check(true));
  const initialView = new URLSearchParams(location.search).get('view');
  if (VALID_VIEWS.has(initialView) && initialView !== 'home') openView(initialView, { updateUrl: false, focus: false });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}

function renderAll(result = null) {
  recomputeLocalPlan(result);
  renderFreshness();
  renderMode();
  renderCompactRecipes();
  renderRecipes();
  renderBuyShortcut();
  renderProfit();
  renderPlans();
  renderBuys();
  renderOpportunities();
  renderStockedMaterials();
  renderSell();
  renderHarvest();
  renderProposal();
  document.querySelector('#sourceTime').textContent = '行情时间：' + formatDateTime(state.data.generatedAt);
  if (state.data.source?.url?.startsWith('https://moligod.com/')) document.querySelector('#sourceLink').href = state.data.source.url;
}

function recomputeLocalPlan(result = null) {
  if (!state.data.candidatePools) return;
  if (state.lazy.enabled) result = null;
  result ??= calculatePlan(state.data, state.settings, state.adoption, state.lazy.enabled ? { version: 1, items: [] } : state.stocked);
  state.data.plan = result.plan;
  if (result.plan.marketRegime?.status === 'normal' && result.plan.stablePlan?.canAdopt) {
    state.lastStablePlan = result.plan.stablePlan;
    localStorage.setItem('shoucai.lastStablePlan', JSON.stringify(state.lastStablePlan));
  } else if (result.plan.marketRegime?.status === 'suspicious' && state.lastStablePlan?.canAdopt) {
    state.data.plan.stablePlan = { ...state.lastStablePlan, readOnly: true };
    state.data.plan.comparisons.stablePlan = state.data.plan.stablePlan;
  }
  state.data.buyPlan = result.buyPlan;
  state.data.sell = result.sell;
  state.proposal = result.proposal;
}

function renderRefreshStatus(status) {
  document.querySelector('#refreshMarket').disabled = status.checking;
  document.querySelector('#refreshMarket').textContent = status.checking ? '正在检查…' : '刷新行情';
  setText('#marketStatus', status.error ? `刷新失败：${status.error}。${state.data ? '已保留最后可用数据。' : '请点击刷新重试。'}`
    : status.checking ? '正在检查网站行情，不额外采集 Moligod' : '最后成功检查：' + formatDateTime(status.lastSuccess));
  if (!state.data && status.error) {
    setText('#freshness','行情读取失败');
    document.querySelector('#recipeList').innerHTML = '<p class="empty-state">行情读取失败，可使用顶部“刷新行情”重试。</p>';
  }
}

function renderProposal() {
  const { proposal, data } = state;
  const pending = proposal.needsConfirmation;
  setText('#activePlanLabel', data.plan.preview ? '待确认方案预览 · 尚未记录采用' : '当前已采用方案');
  setText('#recipes-title', data.plan.preview ? '待确认的四台方案' : '当前采用的四台方案');
  const button = document.querySelector('#adoptPlan');
  button.hidden = !pending; button.disabled = !proposal.canAdopt;
  setText('#proposalTitle', data.plan.preview ? '先确认下一轮造什么' : pending ? '下一轮有新建议，确认后才换' : '继续当前方案');
  const rows = (data.plan.preview ? proposal.recipes : proposal.changes).map(row => '<li><strong>' + escapeHtml(row.label) + '</strong>：' + escapeHtml(row.main || '暂缺可用方案') + '</li>').join('');
  const difference = proposal.weeklyDifference;
  const comparison = difference == null ? '情景数据齐全后显示收益差额。' : '采用后单号保守周利润预计变化：' + (difference >= 0 ? '+' : '') + moneyWan(difference) + '。';
  document.querySelector('#proposalDetails').innerHTML = (rows ? '<ul>' + rows + '</ul>' : '<p>其他方案未超过你设置的换配方门槛，无需操作。</p>') +
    (pending ? '<p>' + comparison + '</p><p>新增材料：' + escapeHtml(proposal.addedMaterials.join('、') || '无') + '；不再需要：' + escapeHtml(proposal.removedMaterials.join('、') || '无') + '。相同材料的数量可能变化，采用后会重算清单。</p>' : '') +
    data.plan.issues.map(issue=>'<p class="form-error">'+escapeHtml(issue)+'</p>').join('');
  setText('#buyPlanScope', data.plan.preview ? '待确认方案的备料预览，尚未视为正在生产。' : '按当前已采用方案备料；待确认的新建议不会改变这份清单。');
  setText('#sellPlanScope', data.plan.preview ? '待确认方案的清仓时段参考' : '当前已采用方案的清仓时段参考');
  const times = data.plan.recipes.map(row=>Date.parse(row.historyReadAt)).filter(Number.isFinite);
  setText('#historyStatus', times.length ? '所示配方原生历史读取：' + formatDateTime(Math.min(...times)) + (Math.max(...times)>Math.min(...times) ? ' ～ '+formatDateTime(Math.max(...times)) : '') + '（历史缓存最长约12小时）' : '原生历史读取时间暂不可用');
}

function renderFreshness() {
  const ageMs = Date.now() - new Date(state.data.generatedAt).getTime();
  const stale = !Number.isFinite(ageMs) || ageMs > (state.data.staleAfterHours || 4) * 3_600_000;
  const pill = document.querySelector('#freshness');
  pill.textContent = stale ? '数据已过期' : relativeAge(ageMs) + '更新';
  pill.classList.toggle('is-fresh', !stale);
  pill.classList.toggle('is-stale', stale);
  document.querySelector('#staleBanner').hidden = !stale;
  document.querySelector('#planState').textContent = state.data.plan?.preview ? '待确认' : '已采用';
}

function renderMode() {
  document.body.classList.toggle('is-lazy-mode', state.lazy.enabled);
  document.querySelector('#lazyModeToggle').checked = state.lazy.enabled;
  document.querySelector('#lazyModeSetting').checked = state.lazy.enabled;
  document.querySelector('#lazyAdvanced').hidden = !state.lazy.enabled;
  setText('#homeModeNote', state.lazy.enabled ? '懒人模式 · 材料按现价购买 · 周末卖出' : '本网站估算 · 已扣分成，不代表保证到手');
  document.querySelectorAll('.nav-advanced').forEach(node => { node.hidden = state.lazy.enabled; });
  const nav = document.querySelector('.bottom-nav');
  nav.classList.toggle('bottom-nav--simple', state.lazy.enabled);
  const material = document.querySelector('#lazyMaterialSummary');
  const switchCard = document.querySelector('#lazySwitchCard');
  material.hidden = !state.lazy.enabled;
  switchCard.hidden = !state.lazy.enabled;
  if (!state.lazy.enabled) return;
  const demand = new Map();
  for (const row of state.data.plan?.recipes ?? []) {
    const candidate = rankCandidates(state.data, state.settings, row.place, state.settings.techMode, true).find(item => item.id === row.id);
    const purchase = candidate ? procurement({ ...candidate, runsPerWeek: 1 }, 7) : null;
    for (const item of purchase?.materials ?? []) {
      const key = normalizeText(item.name), old = demand.get(key) ?? { name: item.name, count: 0, cost: 0 };
      old.count += item.count; old.cost += item.cost; demand.set(key, old);
    }
  }
  const multiplier = state.settings.accounts > 0 ? state.settings.accounts : 1;
  const scope = state.settings.accounts > 0 ? `全部${state.settings.accounts}个号` : '每个账号';
  const rows = [...demand.values()];
  material.innerHTML = '<div class="lazy-summary__head"><div><span>本轮现买材料</span><strong>' + scope + '</strong></div><b>' + moneyWan(rows.reduce((sum, row) => sum + row.cost, 0) * multiplier) + '</b></div>' +
    (rows.length ? '<details><summary>查看' + rows.length + '种材料数量</summary><ul>' + rows.map(row => '<li><span>' + escapeHtml(row.name) + '</span><strong>' + nf.format(Math.ceil(row.count * multiplier)) + '个</strong></li>').join('') + '</ul></details>' : '<p>材料数据待更新。</p>');
  const lazy = state.data.plan?.lazyPlan;
  if (lazy?.suggestions?.length) {
    switchCard.innerHTML = '<div class="lazy-summary__head"><div><span>下一轮建议更换</span><strong>' + lazy.suggestions.length + '台达到换产条件</strong></div></div><ul>' + lazy.suggestions.map(item => '<li><span>' + escapeHtml(item.from || '当前配方') + ' → ' + escapeHtml(item.to) + '</span><small>' + escapeHtml(item.reason) + '</small></li>').join('') + '</ul><button id="adoptLazyNext" class="primary-button" type="button">下一轮一键采用</button>';
  } else switchCard.innerHTML = '<div class="lazy-summary__head"><div><span>下一轮是否换产</span><strong>继续当前方案</strong></div></div><p>暂无稳定方案超过' + state.settings.lazySwitchThreshold + '%门槛。</p>';
}

function renderCompactRecipes() {
  const rows = state.data.plan?.recipes ?? [];
  const target = document.querySelector('#compactRecipeList');
  if (!rows.length) { target.innerHTML = '<p class="empty-state">暂时没有完整的四台制造方案。</p>'; return; }
  target.innerHTML = rows.map(row => '<article><div><span>' + escapeHtml(row.label || row.place) + '</span><strong>' + escapeHtml(row.main || '数据待更新') + '</strong></div><b>' + (row.hours ?? '--') + '小时</b></article>').join('');
}

function renderRecipes() {
  const recipes = state.data.plan?.recipes || [];
  if (!recipes.length) {
    document.querySelector('#recipeList').innerHTML = '<p class="empty-state">暂时没有可用的制造建议。</p>';
    return;
  }
  document.querySelector('#recipeList').innerHTML = recipes.map(item => {
    if (item.unavailable) return '<article class="recipe-card"><span class="recipe-label">' + escapeHtml(item.label) + '</span><h3>本台数据待确认</h3><p class="reason">' + escapeHtml(item.reason || '暂无可用方案或缺少情景数据，请检查设置并等待行情更新。') + '；合计利润暂不输出。</p><button class="recipe-change-button" type="button" data-change-recipe="' + item.place + '">重新选择本台配方</button></article>';
    const perRun = numberOrNull(item.perRunConservativeProfit);
    const weekly = numberOrNull(item.weeklyConservativeProfit);
    const backup = item.backup ? '备选：' + escapeHtml(item.backup) : '暂无备选配方';
    const delta = numberOrNull(item.backupDeltaPercent);
    const deltaText = delta == null ? '' : '（与主选相比 ' + (delta > 0 ? '+' : '') + delta.toFixed(1) + '%）';
    const detail = [
      detailRow('Moligod当前净利润', item.currentProfit),
      detailRow('今日最高（仅参考）', item.todayMaxProfit),
      detailRow('7日最高（仅参考）', item.sevenDayMaxProfit),
      detailRow('原生历史保守净利润（参考）', item.nativeConservativeProfit),
      detailRow('本网站估算：每轮保守均值', perRun),
      detailRow('本网站估算：连续7天净利润', weekly)
    ].filter(Boolean).join('');
    const evidence = item.evidence ? `${item.evidence.source || 'Moligod'} · 最近${state.settings.historyDays}天 · ${item.evidence.sampleCount || 0}条样本${item.evidence.weekendOnly ? ' · 周末数据' : ' · 全时段'} · 每周${item.weeklyRuns}轮` : '历史样本不足';
    const otherMode = item.otherMode ? '<div class="alternate-mode"><span>' + escapeHtml(item.otherMode.mode) + '最佳</span><strong>' + escapeHtml(item.otherMode.name) + ' · ' + item.otherMode.hours + '小时</strong><small>单号周保守 ' + moneyWan(item.otherMode.weeklyProfit) + '</small></div>' : '';
    const suggestion = item.suggestion ? '<div class="recipe-suggestion"><div><span>网站发现更高收益方案</span><strong>' + escapeHtml(item.suggestion.name) + ' · ' + item.suggestion.hours + '小时</strong><small>单号保守周利润预计增加 ' + moneyWan(item.suggestion.weeklyDifference) + (item.suggestion.increasePercent == null ? '' : '（+' + item.suggestion.increasePercent.toFixed(1) + '%）') + '</small></div><button type="button" data-change-recipe="' + item.place + '" data-recipe-id="' + item.suggestion.id + '">查看并采用</button></div>' : '';
    return '<article class="recipe-card' + (perRun != null && perRun < 0 ? ' is-negative' : '') + '">' +
      '<div class="recipe-card__top"><span class="recipe-label">' + escapeHtml(item.label || item.place) + '</span><span class="duration">' + (item.hours ?? '--') + '小时/轮</span></div>' +
      '<h3 class="recipe-main">' + escapeHtml(item.main || '暂无建议') + '</h3>' +
      '<div class="recipe-profit"><span>现价买料 · 每轮保守均值</span><strong>' + (perRun == null ? '情景待更新' : moneyWan(perRun)) + '</strong></div>' +
      '<p class="reason">' + escapeHtml(item.reason || '按当前行情选择') + '</p>' +
      '<div class="backup-row">' + backup + escapeHtml(deltaText) + '</div>' + suggestion +
      '<button class="recipe-change-button" type="button" data-change-recipe="' + item.place + '">更换本台配方</button>' +
      otherMode + '<details class="recipe-details"><summary>查看利润依据</summary><div class="detail-list">' + (detail || '<p>明细正在更新，稍后再看。</p>') + '</div><p class="detail-note">原生参考：' + escapeHtml(evidence) + '。情景配对样本：' + item.scenarioSampleCount + '条；' + (item.provisional ? '情景数据待更新。' : '情景为本网站估算，不是原生利润或保证收益。') + '</p></details>' +
      '</article>';
  }).join('');
}

function openRecipePicker(place, requestedId = null) {
  const candidates = rankCandidates(state.data, state.settings, place);
  if (!candidates.length) {
    showToast('当前允许时长内没有可选配方，请先调整设置。');
    return;
  }
  const current = state.data.plan.recipes.find(row => row.place === place);
  const selectedId = Number(requestedId) || current?.id;
  const select = document.querySelector('#recipePickerSelect');
  select.innerHTML = candidates.map(item => '<option value="' + item.id + '"' + (item.id === selectedId ? ' selected' : '') + '>' +
    escapeHtml(item.name) + ' · ' + item.hours + '小时 · 周保守' + moneyWan(item.selectionWeeklyProfit) + '</option>').join('');
  if (![...select.options].some(option => option.selected)) select.selectedIndex = 0;
  const label = state.data.defaults?.placeRules?.[place]?.label ?? place;
  setText('#recipePickerTitle', '更换' + label + '配方');
  document.querySelector('#recipePickerError').hidden = true;
  state.recipePicker = { place, candidates, record: null, result: null };
  updateRecipePickerPreview();
  const dialog = document.querySelector('#recipePicker');
  if (!dialog.open) dialog.showModal();
  select.focus();
}

function updateRecipePickerPreview() {
  const picker = state.recipePicker;
  if (!picker) return;
  const id = Number(document.querySelector('#recipePickerSelect').value);
  const candidate = picker.candidates.find(row => row.id === id);
  const preview = document.querySelector('#recipePickerPreview');
  const error = document.querySelector('#recipePickerError');
  try {
    const record = adoptRecipe(state.adoption, state.proposal, picker.place, candidate);
    const result = calculatePlan(state.data, state.settings, record, state.stocked);
    picker.record = record; picker.result = result;
    const factor = state.settings.accounts - state.settings.sharedAccounts + state.settings.sharedAccounts * state.settings.userShare / 100;
    const oldWeekly = numberOrNull(state.data.plan?.profit?.conservativeWeeklyPerAccount);
    const newWeekly = numberOrNull(result.plan?.profit?.conservativeWeeklyPerAccount);
    const delta = oldWeekly == null || newWeekly == null ? null : (newWeekly - oldWeekly) * factor;
    const oldMaterials = new Set((state.data.buyPlan?.materials ?? []).filter(row => !row.watchOnly).map(row => row.name));
    const newMaterials = new Set((result.buyPlan?.materials ?? []).filter(row => !row.watchOnly).map(row => row.name));
    const added = [...newMaterials].filter(name => !oldMaterials.has(name));
    const removed = [...oldMaterials].filter(name => !newMaterials.has(name));
    preview.innerHTML = '<div class="recipe-picker__selected"><span>选择后本台制造</span><strong>' + escapeHtml(candidate.name) + '</strong><small>' + candidate.hours + '小时/轮 · 每周按' + candidate.runsPerWeek + '轮计算</small></div>' +
      '<div class="recipe-picker__metrics"><div><span>单号周保守</span><strong>' + moneyWan(candidate.selectionWeeklyProfit) + '</strong></div><div><span>全部账号到手变化</span><strong class="' + (delta != null && delta < 0 ? 'is-down' : '') + '">' + (delta == null ? '待更新' : (delta >= 0 ? '+' : '') + moneyWan(delta)) + '</strong></div></div>' +
      '<p>' + (delta == null ? '情景数据齐全后才能显示人民币变化。' : '折合每周约 ' + (delta >= 0 ? '+' : '') + nf.format(delta / (state.settings.rate * 10_000)) + ' 元。') + '</p>' +
      '<p>新增材料：' + escapeHtml(added.join('、') || '无') + '；不再需要：' + escapeHtml(removed.join('、') || '无') + '。确认后会重新计算相同材料的数量。</p>';
    error.hidden = true;
    document.querySelector('#confirmRecipePicker').disabled = false;
  } catch (failure) {
    picker.record = null; picker.result = null;
    preview.innerHTML = '';
    error.textContent = failure.message; error.hidden = false;
    document.querySelector('#confirmRecipePicker').disabled = true;
  }
}

function closeRecipePicker() {
  const dialog = document.querySelector('#recipePicker');
  if (dialog.open) dialog.close();
  state.recipePicker = null;
}

function openPlanPreview(summary, title) {
  if (!summary?.canAdopt) return showToast('这套方案数据还不完整，暂时不能采用');
  const labels = state.data.defaults?.placeRules ?? {};
  const current = state.data.plan?.comparisons?.current;
  const delta = numberOrNull(summary.conservativeWeekly) != null && numberOrNull(current?.conservativeWeekly) != null
    ? summary.conservativeWeekly - current.conservativeWeekly : null;
  const added = summary.materials.filter(name => !(current?.materials ?? []).some(old => normalizeText(old) === normalizeText(name)));
  const removed = (current?.materials ?? []).filter(name => !summary.materials.some(next => normalizeText(next) === normalizeText(name)));
  setText('#planPreviewTitle', title);
  document.querySelector('#planPreviewBody').innerHTML = '<ul class="plan-preview-list">' + summary.recipes.map(row => '<li><strong>' + escapeHtml(labels[row.place]?.label ?? row.place) + '</strong>：' + escapeHtml(row.name) + ' · ' + row.hours + '小时</li>').join('') + '</ul>' +
    '<div class="recipe-picker__metrics"><div><span>保守周利润</span><strong>' + profitDisplay(summary.conservativeWeekly) + '</strong></div><div><span>较高30天</span><strong>' + profitDisplay(summary.highMonthly) + '</strong></div></div>' +
    '<p>相比当前方案，单号保守周利润 ' + (delta == null ? '待更新' : (delta >= 0 ? '+' : '') + moneyWan(delta)) + '。</p><p>新增材料：' + escapeHtml(added.join('、') || '无') + '；不再需要：' + escapeHtml(removed.join('、') || '无') + '。</p>';
  state.planPreview = summary;
  document.querySelector('#planPreviewDialog').showModal();
}

function closePlanPreview() {
  const dialog = document.querySelector('#planPreviewDialog');
  if (dialog.open) dialog.close();
  state.planPreview = null;
}

function openStockDialog(name, price, days) {
  const existing = state.stocked.items.find(row => normalizeText(row.name) === normalizeText(name));
  setText('#stockDialogTitle', existing ? '修改已囤材料' : '记录已囤材料');
  setValue('#stockMaterialName', name);
  setValue('#stockUnitPrice', existing?.unitPrice ?? price ?? '');
  setValue('#stockCoverageDays', existing?.coverageDays ?? days ?? state.settings.scenarioDays);
  document.querySelector('#stockError').hidden = true;
  state.stockEditor = { name };
  updateStockPreview();
  document.querySelector('#stockDialog').showModal();
}

function updateStockPreview() {
  const name = document.querySelector('#stockMaterialName').value;
  const days = Number(document.querySelector('#stockCoverageDays').value);
  const price = Number(document.querySelector('#stockUnitPrice').value);
  const opportunity = (state.data.plan?.materialOpportunities ?? []).find(row => normalizeText(row.name) === normalizeText(name));
  const material = (state.data.buyPlan?.materials ?? []).find(row => normalizeText(row.name) === normalizeText(name));
  const unit = days === 30 ? 'perAccount30Days' : days === 14 ? 'perAccount14Days' : 'perAccount7Days';
  const count = numberOrNull(opportunity?.coverageDays === days ? opportunity.requiredPerAccount : material?.[unit]);
  const totalCount = count == null ? null : count * state.settings.accounts;
  document.querySelector('#stockPreview').innerHTML = '<p><strong>' + escapeHtml(name) + '</strong>的建议价已预填，你可以改成真实成交价。</p><div class="recipe-picker__metrics"><div><span>单号预计数量</span><strong>' + (count == null ? '待更新' : nf.format(Math.ceil(count)) + '个') + '</strong></div><div><span>全部账号数量</span><strong>' + (state.settings.accounts > 0 && totalCount != null ? nf.format(Math.ceil(totalCount)) + '个' : '设置账号数后计算') + '</strong></div><div><span>单号预计花费</span><strong>' + (count == null || !Number.isFinite(price) ? '待更新' : moneyWan(count * price)) + '</strong></div></div><p>这里只记录成本，不会自动改制造配方，也不会自动扣减库存。</p>';
}

function closeStockDialog() {
  const dialog = document.querySelector('#stockDialog');
  if (dialog.open) dialog.close();
  state.stockEditor = null;
}

function detailRow(label, rawValue) {
  const value = numberOrNull(rawValue);
  return value == null ? '' : '<div><span>' + label + '</span><strong>' + moneyWan(value) + '</strong></div>';
}

function renderProfit() {
  const profit = state.data.plan?.profit || {};
  const factor = state.settings.accounts - state.settings.sharedAccounts + state.settings.sharedAccounts * state.settings.userShare / 100;
  const configured = state.settings.accounts > 0;
  const weeklyLow = numberOrNull(profit.conservativeWeeklyPerAccount ?? profit.noStockWeeklyPerAccount);
  const weeklyHigh = numberOrNull(profit.highWeeklyPerAccount);
  const monthlyLow = numberOrNull(profit.conservativeMonthlyPerAccount) ?? (weeklyLow == null ? null : weeklyLow * 30 / 7);
  const dailyLow = numberOrNull(profit.conservativeDailyPerAccount ?? profit.noStockDailyPerAccount) ?? (weeklyLow == null ? null : weeklyLow / 7);
  const dailyHigh = numberOrNull(profit.highDailyPerAccount) ?? (weeklyHigh == null ? null : weeklyHigh / 7);
  const monthlyHigh = numberOrNull(profit.highMonthlyPerAccount) ?? (weeklyHigh == null ? null : weeklyHigh / 7 * 30);
  const total = value => value == null ? '待更新' : configured ? moneyWan(value * factor) : '请先设置账号数';
  const cny = value => value == null ? '人民币待更新' : configured ? '约 ' + nf.format(value * factor / (state.settings.rate * 10_000)) + ' 元' : '仍可查看单号利润';
  const periods = {
    day: { label: '日', low: dailyLow, high: dailyHigh, hint: '按对应周利润除以7折算' },
    week: { label: '周', low: weeklyLow, high: weeklyHigh, hint: '按设置的每周实际轮数估算' },
    month: { label: '月', low: monthlyLow, high: monthlyHigh, hint: '按日均折算30天' }
  };
  const selected = periods[state.profitPeriod] ?? periods.month;
  document.querySelectorAll('[data-profit-period]').forEach(button => {
    const active = button.dataset.profitPeriod === state.profitPeriod;
    button.classList.toggle('is-active', active); button.setAttribute('aria-pressed', String(active));
  });
  setText('#profitLowLabel', selected.label + '保守预计' + (state.profitPeriod === 'month' ? ' · 30天' : ''));
  setText('#profitHighLabel', selected.label + '较高预计' + (state.profitPeriod === 'month' ? ' · 30天' : ''));
  setText('#profitLow', total(selected.low)); setText('#profitHigh', total(selected.high));
  setText('#profitLowCny', cny(selected.low)); setText('#profitHighCny', cny(selected.high));
  setText('#profitLowHint', selected.hint); setText('#profitHighHint', '历史较高情景，不代表保证收益');
  document.querySelector('#accountSetupBanner').hidden = configured;
  document.querySelector('#profitLowCard').classList.toggle('is-negative', selected.low != null && selected.low < 0);
  document.querySelector('#profitHighCard').classList.toggle('is-negative', selected.high != null && selected.high < 0);
  document.querySelector('#profitBreakdown').innerHTML = [detailRow('单号日均保守', dailyLow), detailRow('单号周保守', weeklyLow),
    detailRow('单号30天保守', monthlyLow), configured ? detailRow('所有账号周利润（未分成）', weeklyLow == null ? null : weeklyLow * state.settings.accounts) : '',
    configured ? detailRow('每周朋友分成', weeklyLow == null ? null : weeklyLow * (state.settings.accounts - factor)) : ''].join('') || '<p>情景数据待更新，不输出不完整的合计。</p>';
  const basis = profit.basis || state.data.plan?.basis || '按当前材料价和历史周末卖价估算';
  setText('#profitBasis', basis + (configured
    ? '；已按 ' + state.settings.accounts + ' 个号、其中 ' + state.settings.sharedAccounts + ' 个分成号（你拿 ' + state.settings.userShare + '%）计算。'
    : '；当前未设置账号数，页面保留单号参考，暂不输出总收入。'));
}

function profitDisplay(value) {
  const amount = numberOrNull(value);
  if (amount == null) return '数据不足';
  if (state.settings.accounts <= 0) return '单号 ' + moneyWan(amount);
  const factor = state.settings.accounts - state.settings.sharedAccounts + state.settings.sharedAccounts * state.settings.userShare / 100;
  return moneyWan(amount * factor);
}

function planCard(type, title, badge, summary, note, adoptable, blocked = false) {
  const labels = state.data.defaults?.placeRules ?? {};
  if (!summary?.recipes?.length) return '<article class="plan-option"><div class="plan-option__head"><h3>' + title + '</h3><span>数据不足</span></div><p class="plan-option__note">配方历史或材料价格不完整，暂不输出这套方案。</p></article>';
  const recipes = summary.recipes.map(row => '<li><strong>' + escapeHtml(labels[row.place]?.label ?? row.place) + '</strong>：' + escapeHtml(row.name) + ' · ' + row.hours + '小时</li>').join('');
  return '<article class="plan-option ' + (type === 'current' ? 'is-current' : type === 'lowBest' ? 'is-low' : '') + '">' +
    '<div class="plan-option__head"><h3>' + escapeHtml(title) + '</h3><span>' + escapeHtml(badge) + '</span></div>' +
    '<ul class="plan-option__recipes">' + recipes + '</ul><div class="plan-option__metrics">' +
    '<div><span>周保守</span><strong>' + profitDisplay(summary.conservativeWeekly) + '</strong></div><div><span>周较高</span><strong>' + profitDisplay(summary.highWeekly) + '</strong></div>' +
    '<div><span>30天保守</span><strong>' + profitDisplay(summary.conservativeMonthly) + '</strong></div><div><span>30天较高</span><strong>' + profitDisplay(summary.highMonthly) + '</strong></div></div>' +
    '<p class="plan-option__note">' + escapeHtml(note) + '</p>' + (adoptable && summary.canAdopt ? '<button class="secondary-button" type="button" data-preview-plan="' + type + '"' + (blocked ? ' disabled' : '') + '>' + (blocked ? '市场异常，暂停采用' : '预览并采用') + '</button>' : '') + '</article>';
}

function renderPlans() {
  const comparisons = state.data.plan?.comparisons ?? {};
  const regime = state.data.plan?.marketRegime;
  const suspicious = regime?.status === 'suspicious';
  document.querySelector('#marketRegime').innerHTML = '<strong>' + (suspicious ? '长期方案暂缓采用' : '长期行情状态正常') + '</strong><p>' + escapeHtml(regime?.reason || '稳定性证据正在计算') + '</p>';
  document.querySelector('#marketRegime').classList.toggle('is-warning', suspicious);
  document.querySelectorAll('[data-plan-type]').forEach(button => {
    const active = button.dataset.planType === state.selectedPlanType;
    button.classList.toggle('is-active', active); button.setAttribute('aria-selected', String(active));
  });
  const entries = {
    current: ['当前采用方案', state.data.plan.preview ? '待首次确认' : '实际执行', comparisons.current,
      state.lazy.enabled ? '懒人模式：全部材料按现价计算。' : state.stocked.items.length ? '已使用本机记录的真实囤货价，未囤材料按现价。' : '尚未记录囤货，材料按当前市场价计算。', false, false],
    currentBest: ['现价买料最优', '全部现买', comparisons.currentBest, '重新比较全部允许配方，所有材料按当前市场价。', true, false],
    lowBest: ['短期低价最优', '阶段低价', comparisons.lowBest, `高波动材料假设达到${state.settings.scenarioDays}天建议价，适合临时抓机会。`, true, false],
    stablePlan: ['长期稳屯', suspicious ? '上次稳定方案' : '30天验证', comparisons.stablePlan, suspicious ? '近72小时行情异常，暂时只读展示上一次通过验证的稳定方案。' : '只使用低价在至少3周重复出现、且前后两段成品利润稳定的候选。', true, suspicious]
  };
  const [title, badge, summary, note, adoptable, blocked] = entries[state.selectedPlanType] ?? entries.current;
  document.querySelector('#planDetail').innerHTML = planCard(state.selectedPlanType, title, badge, summary, note, adoptable, blocked);
  document.querySelector('#scenarioDaysRow').hidden = !['lowBest', 'stablePlan'].includes(state.selectedPlanType);
  document.querySelector('#currentRecipeDetails').hidden = state.selectedPlanType !== 'current';
  document.querySelector('#proposalCard').hidden = state.selectedPlanType !== 'current';
}

function renderOpportunities() {
  const rows = state.data.plan?.materialOpportunities ?? [];
  const visible = state.showAllOpportunities ? rows : rows.slice(0, 5);
  const factor = state.settings.accounts - state.settings.sharedAccounts + state.settings.sharedAccounts * state.settings.userShare / 100;
  const list = document.querySelector('#opportunityList');
  if (!rows.length) {
    list.innerHTML = '<div class="empty-state">暂时没有同时满足“至少14天历史、价格波动超过稳定线、方案利润数据完整”的材料。</div>';
  } else list.innerHTML = visible.map((item, index) => {
    const totalCount = state.settings.accounts > 0 ? nf.format(Math.ceil(item.requiredPerAccount * state.settings.accounts)) + '个' : '设置账号数后计算';
    const totalCost = state.settings.accounts > 0 ? moneyWan(item.estimatedCostPerAccount * state.settings.accounts) : '设置账号数后计算';
    return '<article class="opportunity-card"><div class="opportunity-card__head"><div><h3>' + (index + 1) + '. ' + escapeHtml(item.name) + '</h3><p class="opportunity-card__price">现价 ' + nf.format(item.currentPrice) + ' → 建议不高于 <b>' + nf.format(item.targetPrice) + '</b></p></div><span>波动 ' + numberOrNull(item.priceSpreadPercent)?.toFixed(1) + '%</span></div>' +
      '<div class="opportunity-card__metrics"><div><span>单号买' + item.coverageDays + '天</span><strong>' + nf.format(Math.ceil(item.requiredPerAccount)) + '个</strong></div><div><span>全部账号数量</span><strong>' + totalCount + '</strong></div>' +
      '<div><span>全部预计花费</span><strong>' + totalCost + '</strong></div><div><span>保守周利润</span><strong>' + profitDisplay(item.plan.conservativeWeekly) + '</strong></div>' +
      '<div><span>保守30天</span><strong>' + profitDisplay(item.plan.conservativeMonthly) + '</strong></div><div><span>较高30天</span><strong>' + profitDisplay(item.plan.highMonthly) + '</strong></div></div>' +
      '<p class="opportunity-card__note">用于方案：' + escapeHtml(item.recipes.join('、')) + '。相比全部现价买料，单号保守周利润 ' + (item.improvementWeekly >= 0 ? '+' : '') + moneyWan(item.improvementWeekly) + '。</p>' +
      '<button class="secondary-button" type="button" data-preview-opportunity="' + escapeHtml(item.key) + '">预览这套方案</button><button class="material-stock-button" type="button" data-stock-material="' + escapeHtml(item.name) + '" data-stock-price="' + item.targetPrice + '" data-stock-days="' + item.coverageDays + '">已囤到货</button></article>';
  }).join('');
  const toggle = document.querySelector('#toggleOpportunities');
  toggle.hidden = rows.length <= 5;
  toggle.textContent = state.showAllOpportunities ? '收起，只看前5名' : '查看全部' + rows.length + '种材料';

  const stable = state.data.plan?.stableMaterialOpportunities ?? [];
  const stableList = document.querySelector('#stableOpportunityList');
  if (!stable.length) stableList.innerHTML = '<div class="empty-state">目前没有同时通过“30天多周低价复现”和“成品利润稳定”验证的材料。宁可空缺，也不把一次暴跌当长期机会。</div>';
  else stableList.innerHTML = stable.slice(0, 3).map((item, index) => {
    const totalCount = state.settings.accounts > 0 ? nf.format(Math.ceil(item.requiredPerAccount * state.settings.accounts)) + '个' : '设置账号数后计算';
    return '<article class="opportunity-card opportunity-card--stable"><div class="opportunity-card__head"><div><h3>' + (index + 1) + '. ' + escapeHtml(item.name) + '</h3><p class="opportunity-card__price">长期建议不高于 <b>' + nf.format(item.targetPrice) + '</b>（现价 ' + nf.format(item.currentPrice) + '）</p></div><span>' + (item.stability?.repeatWeeks ?? 0) + '周复现</span></div>' +
      '<div class="opportunity-card__metrics"><div><span>单号买30天</span><strong>' + nf.format(Math.ceil(item.requiredPerAccount)) + '个</strong></div><div><span>全部账号数量</span><strong>' + totalCount + '</strong></div><div><span>保守月利润</span><strong>' + profitDisplay(item.plan.conservativeMonthly) + '</strong></div><div><span>较高月利润</span><strong>' + profitDisplay(item.plan.highMonthly) + '</strong></div></div>' +
      '<p class="opportunity-card__note">' + escapeHtml(item.stability?.reason || '多周低价验证通过') + '；各周低价差异 ' + (item.stability?.lowDeviationPercent?.toFixed(1) ?? '--') + '%。</p>' +
      '<button class="secondary-button" type="button" data-preview-opportunity="' + escapeHtml(item.key) + '" data-stable-opportunity="true">预览这套方案</button><button class="material-stock-button" type="button" data-stock-material="' + escapeHtml(item.name) + '" data-stock-price="' + item.targetPrice + '" data-stock-days="30">已囤到货</button></article>';
  }).join('');
}

function renderStockedMaterials() {
  const section = document.querySelector('#stockedSection');
  const items = state.data.plan?.stockedMaterials ?? [];
  section.hidden = !items.length;
  document.querySelector('#stockedList').innerHTML = items.map(item => '<article class="stocked-card"><div class="stocked-card__head"><div><strong>' + escapeHtml(item.name) + '</strong><small>实际买入 ' + nf.format(item.unitPrice) + '／个 · 预计够' + item.coverageDays + '天</small></div></div><div class="stocked-card__actions"><button class="secondary-button" type="button" data-stock-material="' + escapeHtml(item.name) + '" data-stock-price="' + item.unitPrice + '" data-stock-days="' + item.coverageDays + '">修改</button><button class="secondary-button is-danger" type="button" data-remove-stock="' + escapeHtml(item.name) + '">删除</button></div></article>').join('');
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
    const stocked = state.stocked.items.find(row => normalizeText(row.name) === normalizeText(material.name));
    const totalCount = count == null ? '--' : state.settings.accounts > 0 ? nf.format(Math.ceil(count * state.settings.accounts)) + '个' : '设置账号数后计算';
    return '<article class="material-card' + (material.watchOnly ? ' material-card--watch' : '') + '">' +
      '<div class="material-head"><strong>' + escapeHtml(material.name || '未知材料') + '</strong><span class="material-action ' + (buy ? 'is-buy' : '') + '">' + (buy ? '已到' + material.tierDays + '天好价' : material.action === 'wait' ? '再等等' : '暂无信号') + '</span></div>' +
      '<p class="material-reason">' + escapeHtml(material.reason || '按本周制造方案计算') + '</p>' +
      (buy && days > material.tierDays ? '<p class="material-reason">目前仅达到' + material.tierDays + '天好价；下方' + days + '天数量仅作备料参考，不建议一次买足。</p>' : '') +
      (material.exchangeFor ? '<p class="exchange-tag">用于兑换 ' + escapeHtml(material.exchangeFor) + '</p>' : material.acquisitionNote ? '<p class="acquisition-note">' + escapeHtml(material.acquisitionNote) + '</p>' : '') +
      '<div class="material-metrics"><div><span>当前单价</span><strong>' + (price == null ? '--' : nf.format(price)) + '</strong></div><div><span>建议最高买价</span><strong>' + (target == null ? '--' : nf.format(target)) + '</strong></div><div><span>单号' + (material.watchOnly ? '备料' : '买') + days + '天</span><strong>' + (count == null ? '--' : nf.format(count) + '个') + '</strong></div><div><span>全部账号数量</span><strong>' + totalCount + '</strong></div><div><span>单号预计花费</span><strong>' + (price == null || count == null ? '--' : moneyWan(price * count)) + '</strong></div></div><p class="material-recipes">用于：' + escapeHtml((material.recipes || []).join('、') || '当前制造方案') + '</p>' +
      (target == null ? '' : '<button class="material-stock-button" type="button" data-stock-material="' + escapeHtml(material.name) + '" data-stock-price="' + (stocked?.unitPrice ?? target) + '" data-stock-days="' + (stocked?.coverageDays ?? days) + '">' + (stocked ? '修改已囤价格' : '已囤到货') + '</button>') +
      '</article>';
  };
  const groups = [
    { key: 'buy', title: '现在可以买', open: true, rows: materials.filter(row => row.action === 'buy') },
    { key: 'close', title: '接近好价', open: true, rows: materials.filter(row => row.action !== 'buy' && numberOrNull(row.currentPrice) != null && numberOrNull(row.tierThresholds?.['days' + days] ?? row.targetPrice) != null && row.currentPrice <= (row.tierThresholds?.['days' + days] ?? row.targetPrice) * 1.10) },
    { key: 'wait', title: '继续等待', open: false, rows: materials.filter(row => row.action !== 'buy' && numberOrNull(row.currentPrice) != null && numberOrNull(row.tierThresholds?.['days' + days] ?? row.targetPrice) != null && row.currentPrice > (row.tierThresholds?.['days' + days] ?? row.targetPrice) * 1.10) },
    { key: 'unknown', title: '数据不足', open: false, rows: materials.filter(row => numberOrNull(row.currentPrice) == null || numberOrNull(row.tierThresholds?.['days' + days] ?? row.targetPrice) == null) }
  ];
  const cards = groups.filter(group => group.rows.length).map(group => '<details class="material-group"' + (group.open ? ' open' : '') + '><summary><span>' + group.title + '</span><b>' + group.rows.length + '种</b></summary><div class="material-group__list">' + group.rows.map(materialCard).join('') + '</div></details>').join('');
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

function saveLazyState() {
  localStorage.setItem('shoucai.lazyMode', JSON.stringify(state.lazy));
}

function setLazyMode(enabled) {
  if (enabled === state.lazy.enabled) { renderMode(); return; }
  if (enabled) {
    const lazyPlan = state.data?.plan?.lazyPlan;
    if (!lazyPlan?.canEnable) {
      const labels = state.data?.defaults?.placeRules ?? {};
      const missing = (lazyPlan?.missingPlaces ?? []).map(place => labels[place]?.label ?? place).join('、');
      showToast('暂时不能开启：' + (missing ? missing + '缺少稳定、非亏损的现买方案' : '四台稳定方案数据不完整'));
      renderMode(); return;
    }
    try {
      const record = adoptPlanSummary(lazyPlan.best);
      state.lazy = { version: 1, enabled: true, backupAdoption: state.adoption, advanced: false };
      state.adoption = record;
      localStorage.setItem(ADOPTION_KEY, JSON.stringify(record)); saveLazyState(); renderAll();
      showToast('懒人模式已开启：现买材料、稳定制造、周末卖出');
    } catch (error) { showToast(error.message); renderMode(); }
    return;
  }
  const backup = validAdoption(state.lazy.backupAdoption);
  state.lazy = { version: 1, enabled: false, backupAdoption: null, advanced: false };
  saveLazyState();
  if (backup) {
    state.adoption = backup; localStorage.setItem(ADOPTION_KEY, JSON.stringify(backup));
    showToast('已退出懒人模式，并恢复开启前的四台方案');
  } else showToast('已退出懒人模式；未找到完整备份，保留当前方案');
  renderAll();
}

function bindActions() {
  document.querySelector('#refreshMarket').addEventListener('click', () => state.refresher?.check(true));
  document.querySelector('#openAccountSettings').addEventListener('click', () => {
    openView('settings');
    document.querySelector('#accounts').closest('details')?.setAttribute('open', '');
    document.querySelector('#accounts').focus();
  });
  document.querySelectorAll('[data-profit-period]').forEach(button => button.addEventListener('click', () => {
    state.profitPeriod = button.dataset.profitPeriod;
    localStorage.setItem('shoucai.uiPreferences', JSON.stringify({ version: 1, profitPeriod: state.profitPeriod }));
    renderProfit();
  }));
  document.querySelector('#openPlans').addEventListener('click', () => openView('plans'));
  document.querySelector('#lazyAdvanced').addEventListener('click', () => { state.lazy.advanced = true; saveLazyState(); openView('plans'); });
  document.querySelectorAll('#lazyModeToggle, #lazyModeSetting').forEach(input => input.addEventListener('change', event => {
    setLazyMode(event.target.checked);
  }));
  document.querySelector('#adoptPlan').addEventListener('click', () => {
    try {
      const record = adoptProposal(state.proposal);
      localStorage.setItem(ADOPTION_KEY, JSON.stringify(record));
      state.adoption = record; renderAll();
      showToast('已采用，利润和采购清单已切换；收菜时间未改变');
    } catch (error) { showToast(error.message); }
  });
  document.querySelector('#recipeList').addEventListener('click', event => {
    const button = event.target.closest('[data-change-recipe]');
    if (button) openRecipePicker(button.dataset.changeRecipe, button.dataset.recipeId);
  });
  document.querySelector('#recipePickerSelect').addEventListener('change', updateRecipePickerPreview);
  document.querySelector('#closeRecipePicker').addEventListener('click', closeRecipePicker);
  document.querySelector('#cancelRecipePicker').addEventListener('click', closeRecipePicker);
  document.querySelector('#recipePicker').addEventListener('cancel', event => { event.preventDefault(); closeRecipePicker(); });
  document.querySelector('#recipePickerForm').addEventListener('submit', event => {
    event.preventDefault();
    const record = state.recipePicker?.record;
    if (!record) return;
    try {
      localStorage.setItem(ADOPTION_KEY, JSON.stringify(record));
      state.adoption = record;
      closeRecipePicker();
      renderAll();
      showToast('本台配方已更换，利润和买料清单已重新计算');
    } catch (error) { showToast('保存失败：' + error.message); }
  });
  document.querySelector('#planDetail').addEventListener('click', event => {
    const button = event.target.closest('[data-preview-plan]');
    if (!button) return;
    const summary = state.data.plan?.comparisons?.[button.dataset.previewPlan];
    if (button.dataset.previewPlan === 'stablePlan' && state.data.plan?.marketRegime?.status === 'suspicious') return showToast('近72小时行情异常，长期稳屯方案暂缓采用');
    const titles = { lowBest: '短期低价最优方案', stablePlan: '长期稳屯方案', currentBest: '现价买料最优方案' };
    openPlanPreview(summary, titles[button.dataset.previewPlan] ?? '制造方案');
  });
  document.querySelectorAll('#opportunityList, #stableOpportunityList').forEach(list => list.addEventListener('click', event => {
    const preview = event.target.closest('[data-preview-opportunity]');
    if (preview) {
      const source = preview.dataset.stableOpportunity ? state.data.plan?.stableMaterialOpportunities : state.data.plan?.materialOpportunities;
      const item = (source ?? []).find(row => row.key === preview.dataset.previewOpportunity);
      if (item) openPlanPreview(item.plan, '囤“' + item.name + '”后的最佳方案');
      return;
    }
    const stock = event.target.closest('[data-stock-material]');
    if (stock) openStockDialog(stock.dataset.stockMaterial, Number(stock.dataset.stockPrice), Number(stock.dataset.stockDays));
  }));
  document.querySelector('#planTabs').addEventListener('click', event => {
    const button = event.target.closest('[data-plan-type]');
    if (!button) return;
    state.selectedPlanType = button.dataset.planType; renderPlans();
  });
  document.querySelector('#lazySwitchCard').addEventListener('click', event => {
    if (!event.target.closest('#adoptLazyNext')) return;
    try {
      const record = adoptPlanSummary(state.data.plan?.lazyPlan?.recommended);
      localStorage.setItem(ADOPTION_KEY, JSON.stringify(record)); state.adoption = record; renderAll();
      showToast('已采用下一轮稳定方案，当前收菜时间未改变');
    } catch (error) { showToast(error.message); }
  });
  document.querySelector('#buyList').addEventListener('click', event => {
    const stock = event.target.closest('[data-stock-material]');
    if (stock) openStockDialog(stock.dataset.stockMaterial, Number(stock.dataset.stockPrice), Number(stock.dataset.stockDays));
  });
  document.querySelector('#stockedList').addEventListener('click', event => {
    const edit = event.target.closest('[data-stock-material]');
    if (edit) return openStockDialog(edit.dataset.stockMaterial, Number(edit.dataset.stockPrice), Number(edit.dataset.stockDays));
    const remove = event.target.closest('[data-remove-stock]');
    if (!remove || !confirm('删除“' + remove.dataset.removeStock + '”的囤货记录吗？利润会恢复按现价计算。')) return;
    state.stocked = removeStockedMaterial(state.stocked, remove.dataset.removeStock);
    localStorage.setItem(STOCK_KEY, JSON.stringify(state.stocked));
    renderAll(); showToast('已删除囤货记录，利润已按现价重算');
  });
  document.querySelector('#toggleOpportunities').addEventListener('click', () => { state.showAllOpportunities = !state.showAllOpportunities; renderOpportunities(); });
  document.querySelector('#closePlanPreview').addEventListener('click', closePlanPreview);
  document.querySelector('#cancelPlanPreview').addEventListener('click', closePlanPreview);
  document.querySelector('#planPreviewDialog').addEventListener('cancel', event => { event.preventDefault(); closePlanPreview(); });
  document.querySelector('#planPreviewForm').addEventListener('submit', event => {
    event.preventDefault();
    try {
      const record = adoptPlanSummary(state.planPreview);
      localStorage.setItem(ADOPTION_KEY, JSON.stringify(record));
      state.adoption = record; closePlanPreview(); renderAll();
      showToast('已采用整套方案，利润和采购清单已重新计算');
    } catch (error) { showToast(error.message); }
  });
  document.querySelector('#closeStockDialog').addEventListener('click', closeStockDialog);
  document.querySelector('#cancelStockDialog').addEventListener('click', closeStockDialog);
  document.querySelector('#stockDialog').addEventListener('cancel', event => { event.preventDefault(); closeStockDialog(); });
  document.querySelector('#stockUnitPrice').addEventListener('input', updateStockPreview);
  document.querySelector('#stockCoverageDays').addEventListener('change', updateStockPreview);
  document.querySelector('#stockForm').addEventListener('submit', event => {
    event.preventDefault();
    const error = document.querySelector('#stockError');
    try {
      state.stocked = saveStockedMaterial(state.stocked, { name: document.querySelector('#stockMaterialName').value,
        unitPrice: Number(document.querySelector('#stockUnitPrice').value), coverageDays: Number(document.querySelector('#stockCoverageDays').value) });
      localStorage.setItem(STOCK_KEY, JSON.stringify(state.stocked));
      error.hidden = true; closeStockDialog(); renderAll();
      showToast('已记录真实囤货价，当前方案利润已重新计算');
    } catch (failure) { error.textContent = failure.message; error.hidden = false; }
  });
  document.querySelector('#scenarioDays').addEventListener('change', event => {
    if (!state.data) return;
    try {
      const next = { ...state.settings, scenarioDays: Number(event.target.value) };
      localStorage.setItem('shoucai.settings', JSON.stringify(next));
      state.settings = next; renderAll();
    } catch (error) { event.target.value = state.settings.scenarioDays; showToast('保存失败：' + error.message); }
  });
  document.querySelector('#settingsForm').addEventListener('input', event => {
    if (event.target.id === 'shortWeeklyRuns') updateShortRunsHint(event.target.value);
    setText('#settingsStatus', '有尚未保存的修改，点击“保存并立即重算”后生效。');
  });
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
  document.querySelectorAll('[data-reset-group]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.resetGroup === 'basic' && !confirm('确定把账号、分成和本人比例恢复为通用默认值0／0／100%吗？')) return;
    resetSettingsGroup(button.dataset.resetGroup);
  }));
  document.querySelector('#finishSell').addEventListener('click', async event => {
    const at = new Date().toISOString();
    localStorage.setItem('shoucai.lastSellFinishedAt', at);
    showToast('已记录清仓完成');
    await saveRemoteState('/state/sell-finished', at, event.currentTarget);
  });
}

function resetSettingsGroup(group) {
  const defaults = state.data.defaults || {};
  const fresh = migrateSettings(null, defaults);
  const draft = readSettingsForm(false);
  if (group === 'basic') Object.assign(state.settings, { accounts: fresh.accounts, sharedAccounts: fresh.sharedAccounts,
    userShare: fresh.userShare, rate: fresh.rate, budgetWan: fresh.budgetWan });
  if (group === 'short') state.settings.shortWeeklyRuns = fresh.shortWeeklyRuns;
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
  if (group === 'short') draft.shortWeeklyRuns = saved.shortWeeklyRuns;
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
    shortWeeklyRuns: 'shortWeeklyRuns',
    conservativePercentile: 'conservativePercentile', highPercentile: 'highPercentile', historyDays: 'historyDays',
    buy7: 'buy7', buy14: 'buy14', buy30: 'buy30', stableShare: 'stableShare', stableSpread: 'stableSpread',
    lazySwitchThreshold: 'lazySwitchThreshold' };
  for (const [key, id] of Object.entries(fields)) next[key] = Number(document.getElementById(id).value);
  next.techMode = document.querySelector('#techMode').value;
  document.querySelectorAll('[data-station]').forEach(group => {
    const setting = next.stations[group.dataset.station];
    setting.allowedHours = [...group.querySelectorAll('[data-hour]:checked')].map(input => Number(input.value));
    setting.preferred = group.querySelector('[data-preferred]').value;
    setting.threshold = Number(group.querySelector('[data-threshold]').value);
  });
  next.stations.tech.threshold = Number(document.querySelector('#techThreshold').value);
  document.querySelectorAll('[data-tech-mode]').forEach(group => {
    const mode = group.dataset.techMode;
    next.stations.tech[`${mode}Hours`] = [...group.querySelectorAll('[data-hour]:checked')].map(input => Number(input.value));
    next.stations.tech[`${mode}Preferred`] = group.querySelector('[data-preferred]').value;
    group.querySelectorAll('[data-tech-runs]').forEach(input => { next.stations.tech.runsByHours[input.dataset.techRuns] = Number(input.value); });
  });
  if (validate) {
    if (!Number.isInteger(next.accounts) || next.accounts < 0 || next.accounts > 999) throw new Error('账号总数需填写0到999之间的整数。');
    if (!Number.isInteger(next.sharedAccounts) || next.sharedAccounts < 0) throw new Error('分成号数量需填写非负整数。');
    if (next.sharedAccounts > next.accounts) throw new Error('分成号不能多于总账号数。');
    if (next.buy30 > next.buy14 || next.buy14 > next.buy7) throw new Error('囤货越久，买价要越低：30天分位 ≤ 14天分位 ≤ 7天分位。');
    for (const [place, rule] of Object.entries(next.stations)) {
      const hours = place === 'tech' ? rule[`${next.techMode}Hours`] : rule.allowedHours;
      if (!hours.length) throw new Error(`${state.data.defaults.placeRules[place].label}至少选择一种制造时长。`);
    }
    const shortHours = [...document.querySelectorAll('#settingsForm [data-hour]:checked')]
      .map(input => Number(input.value)).filter(hour => hour > 0 && hour <= 8);
    if (shortHours.length && next.shortWeeklyRuns > Math.min(...shortHours.map(hour => 168 / hour))) {
      throw new Error('短时统一轮数超过所选制造时长的最高产能，请降低轮数或取消较长时长。');
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
  setValue('#shortWeeklyRuns', state.settings.shortWeeklyRuns);
  updateShortRunsHint(state.settings.shortWeeklyRuns);
  setValue('#techMode', state.settings.techMode);
  setValue('#techThreshold', state.settings.stations.tech.threshold);
  setValue('#conservativePercentile', state.settings.conservativePercentile); setValue('#highPercentile', state.settings.highPercentile);
  setValue('#historyDays', state.settings.historyDays);
  setValue('#buy7', state.settings.buy7); setValue('#buy14', state.settings.buy14); setValue('#buy30', state.settings.buy30);
  setValue('#stableShare', state.settings.stableShare); setValue('#stableSpread', state.settings.stableSpread);
  setValue('#lazySwitchThreshold', state.settings.lazySwitchThreshold);
  document.querySelector('#lazyModeSetting').checked = state.lazy.enabled;
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
      '<small>8小时以内配方统一使用“短时制造节奏”的周轮数。</small></fieldset>';
  }).join('');
  const rule = state.settings.stations.tech;
  const pool = state.data.candidatePools.tech || [];
  document.querySelector('#techSettings').innerHTML = ['long', 'short'].map(mode => {
    const hours = mode === 'long' ? [16, 24] : [...new Set(pool.filter(item => item.category !== 'gun' && item.hours >= 4 && item.hours <= 8).map(item => item.hours))].sort((a,b) => a-b);
    const choices = pool.filter(item => hours.includes(item.hours) && (mode === 'long' ? item.category === 'gun' : item.category !== 'gun'));
    const runs = mode === 'long'
      ? hours.map(hour => '<label>' + hour + '小时每周实际收取轮数<input data-tech-runs="' + hour + '" type="number" min="0.5" step="0.5" max="' + Math.floor(168 / hour * 2) / 2 + '" value="' + (rule.runsByHours[hour] ?? 168 / hour) + '" required></label>').join('')
      : '<small data-short-runs-copy>所选4–8小时配方统一按每周' + state.settings.shortWeeklyRuns + '轮计算。</small>';
    return '<fieldset class="station-rule" data-tech-mode="' + mode + '"><legend>' + (mode === 'long' ? '长时枪械' : '短时配件') + '</legend><div class="hour-checks">' + hours.map(hour => '<label><input type="checkbox" data-hour value="' + hour + '"' + (rule[mode + 'Hours'].includes(hour) ? ' checked' : '') + '>' + hour + '小时</label>').join('') + '</div><label>常用配方<select data-preferred><option value="">自动选择，不保留常用配方</option>' + choices.map(item => '<option value="' + escapeHtml(item.name) + '"' + (normalizeText(rule[mode + 'Preferred']) === normalizeText(item.name) ? ' selected' : '') + '>' + escapeHtml(item.name) + '（' + item.hours + '小时）</option>').join('') + '</select></label>' + runs + '</fieldset>';
  }).join('');
  document.querySelectorAll('#settingsForm input[type="number"]').forEach(input => { input.required = true; });
}

function updateShortRunsHint(rawValue) {
  const runs = Number(rawValue);
  setText('#shortRunsHint', Number.isFinite(runs)
    ? `统一用于所有8小时以内配方；相当于日均 ${(runs / 7).toFixed(2)} 轮。16/24小时枪械仍单独计算。`
    : '统一用于工作台、制药台、防具台和技术中心短时配件。');
  document.querySelectorAll('[data-short-runs-copy]').forEach(node => {
    node.textContent = Number.isFinite(runs) ? `所选4–8小时配方统一按每周${runs}轮计算。` : '短时配件使用统一轮数。';
  });
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
  if (value == null || value === '') return '待更新';
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
