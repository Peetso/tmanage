/*
 * TManage app-shell service worker (slice 01 — installable shell for modules 22/23).
 *
 * Deliberately minimal: an app-shell precache, a network-first navigation strategy with an
 * offline fallback document, and cache-first for static assets. There is no background sync
 * and no push — push is explicitly skipped in the module map, so this worker never asks for
 * a push subscription.
 *
 * Served from `/sw.js`, so its scope is the whole origin and it controls every navigation.
 */

const CACHE = 'tmanage-shell-v1';
const OFFLINE_URL = '/offline';

// The shell that must survive a cold, offline launch: the fallback document and the brand
// mark the installed window renders.
const PRECACHE = [OFFLINE_URL, '/brand/tmanage-icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  // Drop superseded shell caches so an updated worker does not serve a stale document.
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only same-origin GETs are the shell's business; everything else falls through to the
  // network untouched (API calls, cross-origin fonts/analytics, non-GET mutations).
  if (request.method !== 'GET') {
    return;
  }
  if (new URL(request.url).origin !== self.location.origin) {
    return;
  }

  // Navigations: try the network, fall back to the cached offline document when it fails.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(CACHE);
        const offline = await cache.match(OFFLINE_URL);
        return offline ?? Response.error();
      }),
    );
    return;
  }

  // Static assets (styles, scripts, images, fonts): serve from cache first, then fill the
  // cache from the network so the next cold launch has them.
  if (['style', 'script', 'image', 'font'].includes(request.destination)) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) {
          return cached;
        }
        const response = await fetch(request);
        if (response.ok) {
          cache.put(request, response.clone());
        }
        return response;
      }),
    );
  }
});
