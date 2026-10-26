const CACHE_NAME = "agentic-design-system-v0.3.34-draft-c104152";
const CORE_FILES = [
  "./", "./app.js?v=c104152", "./catalog.json", "./catalog.schema.json",
  "./vendor/agentic-base-browser-data-view.js?v=c104152", "./vendor/agentic-base-browser-data-view.css?v=c104152",
];
const REVIEW_INVENTORY = "./review-inventory.json";
const CACHEABLE_FILES = [...CORE_FILES, REVIEW_INVENTORY];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then(async (cache) => {
    await cache.addAll(CORE_FILES);
    try {
      const response = await fetch(REVIEW_INVENTORY, { cache: "no-store" });
      if (response.ok) await cache.put(REVIEW_INVENTORY, response);
    } catch {
      // The review inventory is optional in a release artifact.
    }
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
