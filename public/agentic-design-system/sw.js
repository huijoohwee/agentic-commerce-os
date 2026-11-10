const CACHE_NAME = "agentic-design-system-v0.5.0-draft-registry-r25";
const CORE_FILES = [
  "./", "./registry.css", "./floating-panel.css", "./toolbar.css", "./toolbar-icons.js", "./dashboard-columns.js", "./app.js?v=registry-semantic-cards-3", "./registry-query.js?v=c104158", "./catalog.json", "./catalog.schema.json",
  "./icons.json", "./tokens/commerce-profile.json", "./tokens/base-profile.json", "./tokens/graph-profile.json", "./tokens/shared-ui-profile.json",
  "./vendor/commerce-theme.css", "./vendor/base-profile.css", "./vendor/graph-profile.css", "./vendor/shared-ui-profile.css", "./THIRD-PARTY-NOTICES.txt", "./favicon.svg",
];
const CACHEABLE_FILES = CORE_FILES;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then(async (cache) => {
    await cache.addAll(CORE_FILES);
    await self.skipWaiting();
  }));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith("agentic-design-system-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  const path = new URL(request.url).pathname;
  const isCacheable = CACHEABLE_FILES.some((file) => new URL(file, self.registration.scope).pathname === path);
  if (!isCacheable) return;

  event.respondWith(
    fetch(request).then((response) => {
      if (!response.ok) return response;
      return caches.open(CACHE_NAME).then((cache) => cache.put(request, response.clone()).then(() => response));
    }).catch(async () => {
      const cached = await caches.match(request);
      const index = new URL("./", self.registration.scope).href;
      return cached || caches.match(index);
    }),
  );
});
