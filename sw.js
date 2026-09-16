// Ecole Systems / Nazareth Academy Finance Portal — service worker
//
// Bump CACHE_VERSION any time you deploy a meaningfully new build. This is
// deliberately NETWORK-FIRST, not cache-first: it always tries the network
// for a fresh copy first, and only falls back to whatever's cached if the
// network request fails (e.g. genuinely offline). This is the opposite of
// an aggressive "serve from cache always" worker — that pattern is exactly
// what caused a device to keep showing a stale year/UI indefinitely even on
// a fresh page load, because an old cache-first worker never re-checks the
// network once it has something cached.
//
// skipWaiting() + clients.claim() below mean a newly deployed worker takes
// over immediately (no waiting for all tabs to close first), so future
// deploys propagate to open devices as fast as the network-first fetch
// strategy allows, rather than silently getting stuck on old code.

const CACHE_VERSION = 'v1';
const CACHE_NAME = `ecole-systems-${CACHE_VERSION}`;

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  // Only handle simple GET requests; let everything else (POST to Cloud
  // Functions, Firebase's own websocket/long-polling traffic, etc.) pass
  // through untouched.
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then(networkResponse => {
        // Got a fresh copy — cache it for offline fallback and return it.
        const responseClone = networkResponse.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, responseClone);
        });
        return networkResponse;
      })
      .catch(() => {
        // Network failed (offline) — fall back to whatever we have cached.
        return caches.match(event.request).then(cached => {
          return cached || Response.error();
        });
      })
  );
});
