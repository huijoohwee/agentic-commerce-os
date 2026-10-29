const CACHE_PREFIX = 'agentic-commerce-local-first-';
const RELEASE = '__RELEASE__';
const CACHE = CACHE_PREFIX + RELEASE;
const SCOPE = new URL(self.registration.scope);
const FILES = ['', 'favicon.svg', 'workspace.js', 'workspace-navigation.js', 'workspace-singleton.js', 'shopper-demo-detail.js', 'workspace-tour.js', 'workspace-capabilities.js', 'workspace-tools.js', 'workspace-graph.js', 'agentic-base-data-view.js', 'agentic-base-data-view.css', 'graph-data-view.js', 'graph-data-view.css', 'graph-ui-tokens.css', 'commerce-theme.css', 'workspace-shell.css', 'services/workspace/service.json', 'services/sme-business-pack/service.json', 'sme-business-pack.js', 'sme-business-pack.css', 'sme-business-pack-core.js', 'sme-pack-sg.js', 'sme-pack-my.js', 'app.js', 'drafts.js', 'launch.js', 'checkout.js', 'workflow.js', 'style.css'];
const assetUrl = file => new URL(file.startsWith('services/') || file === 'favicon.svg' ? file : file ? `assets/${RELEASE}/${file}` : '', SCOPE);
const PATHS = new Set(FILES.map(file => assetUrl(file).pathname));
self.addEventListener('install', event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  // A failed asset refuses this installation and keeps the previous offline shell.
  for (const file of FILES) {
    const url = assetUrl(file);
    const response = await fetch(new Request(url, { cache: 'reload', credentials: 'omit', signal: AbortSignal.timeout(15000) }));
    if (!response.ok) throw Error('offline_asset_unavailable');
    if (file === 'services/sme-business-pack/service.json') {
      const value = await response.clone().json();
      if (value.schema !== 'sme-business-pack-service/v1' || value.sourceRevision !== RELEASE || value.persistence !== 'none') {
        throw Error('offline_service_source_mismatch');
      }
    } else if (file.endsWith('service.json')) {
      const value = await response.clone().json();
      if (value.schema !== 'commerce.workspace-service/v1' || value.sourceRevision !== RELEASE) throw Error('offline_service_source_mismatch');
    }
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
      try {
        const response = await fetch(event.request);
        if (response.ok) {
          if (RELEASE === 'local-unreleased') await cache.put(key, response.clone());
          return response;
        }
        if (response.status < 500 && !(response.status === 403 && self.navigator.onLine === false)) return response;
      } catch { /* use the verified shell */ }
    }
    if (RELEASE === 'local-unreleased' && event.request.mode !== 'navigate') {
      try {
        const response = await fetch(event.request);
        if (response.ok) { await cache.put(key, response.clone()); return response; }
        if (response.status < 500 && !(response.status === 403 && self.navigator.onLine === false)) return response;
      } catch { /* fall back to the last verified local asset */ }
    }
    return await cache.match(key) || fetch(event.request);
  })());
});
