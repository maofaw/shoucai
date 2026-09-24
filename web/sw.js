const CACHE = 'shoucai-v16';
const DATA = './data/latest.json';
const SHELL = ['./', './index.html', './styles.css?v=16', './app.js?v=16', './planner.js', './harvest.js', './engine/buy-window.mjs', './engine/market-history.mjs', './engine/recommend.mjs', './engine/weekend-prices.mjs', './budget.js', './manifest.webmanifest', './runtime-config.js', './favicon.svg', DATA];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== 'GET' || requestUrl.origin !== self.location.origin) return;
  if (requestUrl.pathname.endsWith('/data/latest.json')) {
    event.respondWith(fetch(event.request)
      .then(response => {
        if (!response.ok) throw new Error('行情请求失败');
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(DATA, copy));
        return response;
      })
      .catch(() => caches.match(DATA).then(response => response || new Response('', { status: 503 }))));
    return;
  }
  event.respondWith(fetch(event.request)
    .then(response => {
      if (event.request.method === 'GET' && response.ok) {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, copy));
      }
      return response;
    })
    .catch(async () => (await caches.match(event.request)) || (event.request.mode === 'navigate' ? await caches.match('./index.html') : null) || new Response('暂时无法连接，请联网后重试', { status: 503 })));
});
