const CACHE_PREFIX = 'commerce-storage-management-';
const RELEASE = '__RELEASE__';
const CACHE = CACHE_PREFIX + RELEASE;
const SCOPE = new URL(self.registration.scope);
const FILES = ['', 'style.css', 'guide.js', 'sources.json', 'sw.js'];

self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  for (const file of FILES) {
    const url = new URL(file, SCOPE);
    const response = await fetch(new Request(url, {
      cache: 'reload', credentials: 'omit', signal: AbortSignal.timeout(15000),
    }));
    if (!response.ok || response.type === 'opaque') throw Error('storage_management_asset_unavailable');
    await cache.put(url.href, response);
  }
  await self.skipWaiting();
})()));

self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) {
    if (key.startsWith(CACHE_PREFIX) && key !== CACHE) await caches.delete(key);
  }
  await self.clients.claim();
})()));

self.addEventListener('fetch', event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== SCOPE.origin || !FILES.some(file =>
    url.pathname === new URL(file, SCOPE).pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE), key = new URL(url.pathname, SCOPE.origin).href;
    try {
      const response = await fetch(request);
      if (response.ok) {
        await cache.put(key, response.clone());
        return response;
      }
      if (response.status < 500) return response;
    } catch { /* use the verified local copy */ }
    return await cache.match(key) || Response.error();
  })());
});
