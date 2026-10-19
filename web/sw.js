const PREFIX = 'shoucai:' + encodeURIComponent(new URL(self.registration.scope).pathname) + ':';
const CACHE = PREFIX + 'v28';
const SHELL = ['./', './index.html', './styles.css?v=28', './app.js?v=28', './app-state.js', './planner.js', './planner-worker.js', './planner-client.js', './computed-cache.js', './refresh-schedule.js', './scenarios.js', './snapshot-loader.js', './snapshot-cache.js', './market-refresh.js', './harvest.js', './engine/buy-window.mjs', './engine/market-history.mjs', './engine/recommend.mjs', './engine/weekend-prices.mjs', './budget.js', './manifest.webmanifest', './runtime-config.js', './favicon.svg'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  // Other projects can share this origin. Never remove their offline storage.
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE)
    .map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin
    || !url.href.startsWith(self.registration.scope)) return;
  const relative = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  if (/^data\/(latest\.json(?:\.gz)?|version\.json|bootstrap\.json)$/.test(relative)) {
    const key = new URL('./' + relative, self.registration.scope).href;
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(event.request);
        if (!response.ok) throw new Error('行情请求失败');
        await cache.put(key, response.clone());
        return response;
      } catch {
        const cached = await cache.match(key);
        if (!cached) return new Response('', { status: 503 });
        const headers = new Headers(cached.headers); headers.set('x-shoucai-offline', '1');
        return new Response(cached.body, { status: 200, headers });
      }
    })());
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const key = event.request.mode === 'navigate' ? new URL('./index.html', self.registration.scope).href : event.request;
    const cached = await cache.match(key);
    if (cached) return cached;
    try {
      const response = await fetch(event.request);
      // Keep the installed release's modules together until a new SW activates.
      if (response.ok && !/\.(?:m?js|css)$/.test(url.pathname)) await cache.put(key, response.clone());
      return response;
    } catch { return new Response('暂时无法连接，请联网后重试', { status: 503 }); }
  })());
});
