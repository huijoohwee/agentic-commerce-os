const CACHE_PREFIX = 'agentic-commerce-local-first-';
const CACHE = CACHE_PREFIX + '__RELEASE__';
const SCOPE = new URL(self.registration.scope);
const FILES = ['', 'app.js', 'drafts.js', 'style.css'];
const PATHS = new Set(FILES.map(file => new URL(file, SCOPE).pathname));
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  // A failed asset refuses this installation and keeps the previous offline shell.
  for (const file of FILES) {
    const url = new URL(file, SCOPE);
    const response = await fetch(new Request(url, { cache: 'reload', credentials: 'omit', signal: AbortSignal.timeout(15000) }));
    if (!response.ok) throw Error('offline_asset_unavailable');
    await cache.put(url.href, response);
  }
  await self.skipWaiting();
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith(CACHE_PREFIX) && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== SCOPE.origin || !PATHS.has(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE), key = new URL(url.pathname, SCOPE.origin).href;
    if (event.request.mode === 'navigate') {
      try { const response = await fetch(event.request); if (response.ok) return response; } catch { /* use the verified shell */ }
    }
    return await cache.match(key) || fetch(event.request);
  })());
});
