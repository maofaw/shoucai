export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), env);
    if (request.method === 'GET' && url.pathname === '/health') {
      return cors(json({
        status: 'ok',
        database: Boolean(env.DB),
        feishuConfigured: Boolean(env.FEISHU_APP_ID && env.FEISHU_APP_SECRET && env.FEISHU_RECEIVE_ID)
      }), env);
    }
    if (request.method === 'GET' && url.pathname === '/state') {
      const rows = await env.DB.prepare('SELECT key, value, updated_at FROM app_state').all();
      const state = Object.fromEntries((rows.results ?? []).map(row => [row.key, { value: JSON.parse(row.value), updatedAt: row.updated_at }]));
      return cors(json({ status: 'ok', state }), env);
    }
    if (request.method === 'POST' && ['/state/harvest-finished', '/state/sell-finished'].includes(url.pathname)) {
      if (!authorized(request, env, 'ADMIN_KEY')) return cors(json({ status: 'error', message: 'Unauthorized' }, 401), env);
      const key = url.pathname.endsWith('harvest-finished') ? 'lastHarvestFinishedAt' : 'lastSellFinishedAt';
      const body = await request.json().catch(() => ({}));
      if (Object.hasOwn(body, 'at') && body.at === null) {
        await env.DB.prepare('DELETE FROM app_state WHERE key = ?').bind(key).run();
        return cors(json({ status: 'ok', key, value: null }), env);
      }
      const value = body.at ?? new Date().toISOString();
      await env.DB.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .bind(key, JSON.stringify(value), new Date().toISOString()).run();
      return cors(json({ status: 'ok', key, value }), env);
    }
    if (request.method === 'POST' && url.pathname === '/notify/buy') {
      if (!authorized(request, env, 'NOTIFY_PUSH_KEY')) return cors(json({ status: 'error', message: 'Unauthorized' }, 401), env);
      try {
        return cors(await handleBuyNotification(request, env), env);
      } catch {
        return cors(json({ status: 'error', message: 'Notification delivery failed' }, 502), env);
      }
    }
    if (request.method === 'POST' && url.pathname === '/notify/test') {
      if (!authorized(request, env, 'NOTIFY_PUSH_KEY')) return cors(json({ status: 'error', message: 'Unauthorized' }, 401), env);
      try {
        await sendFeishuText(env, '【三角洲收菜助手】\n低价买料通知已经连接成功。');
        return cors(json({ status: 'ok', sent: 1 }), env);
      } catch {
        return cors(json({ status: 'error', message: 'Notification delivery failed' }, 502), env);
      }
    }
    return cors(json({ status: 'error', message: 'Not found' }, 404), env);
  }
};

async function handleBuyNotification(request, env) {
  if (!env.DB) return json({ status: 'error', message: 'Database is not configured' }, 503);
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET || !env.FEISHU_RECEIVE_ID) {
    return json({ status: 'error', message: 'Feishu is not configured' }, 503);
  }
  const body = await request.json().catch(() => null);
  const payload = validateBuyPayload(body);
  if (!payload) return json({ status: 'error', message: 'Invalid payload' }, 400);
  const cooldownRows = await env.DB.prepare(
    'SELECT material_key, tier_days, notified_at FROM notification_cooldowns'
  ).all();
  const now = new Date();
  const due = selectDueNotifications(payload.materials, cooldownRows.results ?? [], now,
    Number(env.NOTIFICATION_COOLDOWN_HOURS ?? 24));
  if (!due.length) {
    return json({ status: 'ok', sent: 0, cooldown: payload.materials.length });
  }

  await sendFeishuText(env, formatBuyAlert({ ...payload, materials: due }));
  const notifiedAt = now.toISOString();
  await env.DB.batch(due.map(material => env.DB.prepare(`INSERT INTO notification_cooldowns
      (material_key, tier_days, notified_at) VALUES (?, ?, ?)
      ON CONFLICT(material_key) DO UPDATE SET tier_days = excluded.tier_days, notified_at = excluded.notified_at`)
    .bind(material.key, material.tierDays, notifiedAt)));
  return json({ status: 'ok', sent: due.length, cooldown: payload.materials.length - due.length });
}

export function selectDueNotifications(materials, cooldownRows, now = new Date(), cooldownHours = 24) {
  const cooldowns = new Map((cooldownRows ?? []).map(row => [String(row.material_key), row]));
  const cooldownMs = Math.max(1, Number(cooldownHours)) * 3_600_000;
  return (materials ?? []).filter(material => {
    if (!material?.key || Number(material.tierDays) < 7) return false;
    const previous = cooldowns.get(String(material.key));
    if (!previous) return true;
    if (Number(material.tierDays) > Number(previous.tier_days)) return true;
    const previousAt = new Date(previous.notified_at).getTime();
    return !Number.isFinite(previousAt) || now.getTime() - previousAt >= cooldownMs;
  });
}

export function formatBuyAlert(payload) {
  const materials = payload.materials ?? [];
  const accounts = Number(payload.accounts ?? 1);
  const lines = [
    '【三角洲低价买料】',
    `${materials.length}项材料已达到至少7天囤货线（按${accounts}个号）`
  ];
  materials.slice(0, 20).forEach((material, index) => {
    const use = material.exchangeFor ? `，用于兑换${material.exchangeFor}` : material.watchOnly ? '，稳定方案备料' : '';
    lines.push(
      `${index + 1}. ${material.name}｜${material.tierDays}天档${use}`,
      `现价${formatNumber(material.currentPrice)}；单号${formatCount(material.perAccountCount)}个，全部账号${formatCount(material.totalCount)}个；约${formatWan(material.totalCost)}`
    );
  });
  if (materials.length > 20) lines.push(`另有${materials.length - 20}项，请打开网页查看。`);
  if (payload.dashboardUrl) lines.push(`查看采购页：${payload.dashboardUrl}`);
  return lines.join('\n');
}

async function sendFeishuText(env, text) {
  const httpFetch = env.__fetch ?? fetch;
  const tokenResponse = await httpFetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET })
  });
  const tokenResult = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || tokenResult.code !== 0 || !tokenResult.tenant_access_token) {
    throw new Error('Unable to obtain Feishu access token');
  }
  const receiveType = env.FEISHU_RECEIVE_ID_TYPE || 'open_id';
  const messageResponse = await httpFetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${encodeURIComponent(receiveType)}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${tokenResult.tenant_access_token}`,
      'content-type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({
      receive_id: env.FEISHU_RECEIVE_ID,
      msg_type: 'text',
      content: JSON.stringify({ text })
    })
  });
  const messageResult = await messageResponse.json().catch(() => ({}));
  if (!messageResponse.ok || messageResult.code !== 0) throw new Error('Unable to send Feishu message');
}

function validateBuyPayload(body) {
  const accounts = Math.floor(Number(body?.accounts));
  if (!Number.isFinite(accounts) || accounts < 1 || accounts > 999 || !Array.isArray(body?.materials)) return null;
  const materials = body.materials.slice(0, 100).map(material => ({
    key: String(material?.key ?? '').slice(0, 120),
    name: String(material?.name ?? '').slice(0, 120),
    tierDays: [7, 14, 30].includes(Number(material?.tierDays)) ? Number(material.tierDays) : 0,
    currentPrice: positiveNumber(material?.currentPrice),
    thresholdPrice: positiveNumber(material?.thresholdPrice),
    perAccountCount: positiveNumber(material?.perAccountCount),
    totalCount: positiveNumber(material?.totalCount),
    totalCost: positiveNumber(material?.totalCost),
    watchOnly: Boolean(material?.watchOnly),
    exchangeFor: material?.exchangeFor ? String(material.exchangeFor).slice(0, 120) : null
  })).filter(material => material.key && material.name && material.tierDays >= 7 && material.currentPrice !== null
    && material.perAccountCount !== null && material.totalCount !== null && material.totalCost !== null);
  return {
    accounts,
    generatedAt: String(body.generatedAt ?? ''),
    dashboardUrl: isSafeDashboardUrl(body.dashboardUrl) ? String(body.dashboardUrl) : '',
    materials
  };
}

function isSafeDashboardUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && url.hostname === 'maofaw.github.io';
  } catch {
    return false;
  }
}

function positiveNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function authorized(request, env, keyName) {
  const header = request.headers.get('authorization') ?? '';
  const key = env[keyName] || env.ADMIN_KEY;
  return Boolean(key) && timingSafeEqual(header, `Bearer ${key}`);
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

function formatNumber(value) {
  return Math.round(Number(value)).toLocaleString('zh-CN');
}

function formatCount(value) {
  const number = Number(value);
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function formatWan(value) {
  const wan = Number(value) / 10_000;
  return `${wan >= 100 ? Math.round(wan) : wan.toFixed(1)}万哈夫币`;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function cors(response, env) {
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', env.ALLOWED_ORIGIN || '*');
  headers.set('access-control-allow-headers', 'authorization, content-type');
  headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
  return new Response(response.body, { status: response.status, headers });
}
