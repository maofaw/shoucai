export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), env);
    if (request.method === 'GET' && url.pathname === '/state') {
      const rows = await env.DB.prepare('SELECT key, value, updated_at FROM app_state').all();
      const state = Object.fromEntries((rows.results ?? []).map(row => [row.key, { value: JSON.parse(row.value), updatedAt: row.updated_at }]));
      return cors(json({ status: 'ok', state }), env);
    }
    if (request.method === 'POST' && ['/state/harvest-finished', '/state/sell-finished'].includes(url.pathname)) {
      if (!authorized(request, env)) return cors(json({ status: 'error', message: 'Unauthorized' }, 401), env);
      const key = url.pathname.endsWith('harvest-finished') ? 'lastHarvestFinishedAt' : 'lastSellFinishedAt';
      const body = await request.json().catch(() => ({}));
      const value = body.at ?? new Date().toISOString();
      await env.DB.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .bind(key, JSON.stringify(value), new Date().toISOString()).run();
      return cors(json({ status: 'ok', key, value }), env);
    }
    return cors(json({ status: 'error', message: 'Not found' }, 404), env);
  }
};

function authorized(request, env) {
  const header = request.headers.get('authorization') ?? '';
  return Boolean(env.ADMIN_KEY) && header === `Bearer ${env.ADMIN_KEY}`;
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
