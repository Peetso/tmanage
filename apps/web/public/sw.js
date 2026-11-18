/*
 * TManage app-shell service worker (slice 01 — installable shell for modules 22/23).
 *
 * Deliberately minimal: an app-shell precache, a network-first navigation strategy with an
 * offline fallback document, and cache-first for static assets. There is no background sync
 * and no push — push is explicitly skipped in the module map, so this worker never asks for
 * a push subscription.
 *
 * Served from `/sw.js`, so its scope is the whole origin and it controls every navigation.
 *
 * A new build does **not** skip waiting on its own (slice 08, the updater intent): when a worker
 * is already in control, a freshly installed worker parks in the waiting state until a window
 * posts `SKIP_WAITING`, so the "update available" toast can offer the reload on the user's terms.
 * On the very first install there is no controller to wait behind, so the worker still activates
 * immediately and the shell is live at once.
 */

const CACHE = 'tmanage-shell-v1';
const OFFLINE_URL = '/offline';

/*
 * 53-16 Offline mode: the last-seen My Day, work list and task detail.
 *
 * A separate cache from the shell because it holds one person's workspace data. The page clears it
 * at every authentication boundary (sign-in, sign-out, session ended — `lib/offline/
 * offline-runtime.ts`), both directly and through the `CLEAR_DATA` message below, so another
 * person on this browser never reads it. Network first: online, the page always gets fresh data
 * and the cache is only refreshed; offline, the last good copy is served instead of an error.
 */
const DATA_CACHE = 'tmanage-data-v1';

// App pages (and their client-navigation payloads) that are readable offline.
const READABLE_PAGE = /^\/[^/]+\/(home|work)(\/[^/]+)?\/?$/;
// The API reads behind them: My Day, the work list, one item and its comments/checklist/time.
const READABLE_API =
  /^\/v1\/organizations\/[^/]+\/(home\/my-day|work-items(\/[^/]+(\/(comments|checklist|time-logs))?)?)$/;

function isReadable(url, sameOrigin) {
  if (READABLE_API.test(url.pathname)) return true;
  return sameOrigin && READABLE_PAGE.test(url.pathname);
}

async function networkFirst(request, fallback) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const response = await fetch(request);
    // Only a complete, readable answer is kept: never an error page, a redirect or an opaque body.
    if (response.ok && response.type !== 'opaque') {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (fallback) return fallback();
    throw error;
  }
}

// The shell that must survive a cold, offline launch: the fallback document and the brand
// mark the installed window renders.
const PRECACHE = [OFFLINE_URL, '/brand/tmanage-icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
});

// The window's opt-in to the new build: take over now, which fires `controllerchange` in the
// page so the update toast can reload into the new worker.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  // 53-16: the auth boundary — drop every cached workspace read.
  if (event.data && event.data.type === 'CLEAR_DATA') {
    event.waitUntil(caches.delete(DATA_CACHE));
  }
});

self.addEventListener('activate', (event) => {
  // Drop superseded shell caches so an updated worker does not serve a stale document.
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE && key !== DATA_CACHE)
            .map((key) => caches.delete(key)),
        ),
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
  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  // 53-16: last-seen reads (the API may be on its own origin, so this runs before the origin
  // check). A navigation with no cached copy still falls back to the offline document.
  if (isReadable(url, sameOrigin)) {
    event.respondWith(
      networkFirst(
        request,
        request.mode === 'navigate'
          ? async () => (await (await caches.open(CACHE)).match(OFFLINE_URL)) ?? Response.error()
          : undefined,
      ),
    );
    return;
  }

  if (!sameOrigin) {
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
  // The catalog parts (`/i18n/<lang>.<part>.json?v=<build>`) are versioned like the scripts.
  if (
    ['style', 'script', 'image', 'font'].includes(request.destination) ||
    url.pathname.startsWith('/i18n/')
  ) {
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
