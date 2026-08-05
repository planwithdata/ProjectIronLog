/**
 * service-worker.js — Offline support.
 *
 * Caching strategy
 * ----------------
 * The app shell (HTML, CSS, JS, program data, icons) is precached on install
 * and then served **cache-first**. That is the right trade for a gym app: the
 * phone is often on a bad signal or in airplane mode in a basement gym, and a
 * network-first shell would mean staring at a spinner between sets.
 *
 * Navigations use **network-first with a cache fallback**, so a deployed
 * update is picked up on the next online launch rather than being pinned to
 * whatever was installed first.
 *
 * User data is never cached here — it lives in Local Storage, which is
 * already local and needs no network.
 *
 * Versioning
 * ----------
 * CACHE_VERSION must be bumped on every deploy. The old cache is deleted in
 * `activate`, which is what stops a stale stylesheet outliving the markup it
 * was written for. It duplicates APP_VERSION in js/config.js because a
 * service worker runs outside the module graph and cannot import it.
 */

const CACHE_VERSION = 'v1.6.0';
const CACHE_NAME = `ironlog-${CACHE_VERSION}`;

/**
 * Content that is versioned by filename. Cached on first view and never
 * revalidated. Exercise artwork is deliberately absent from PRECACHE below:
 * 74 images would add ~1 MB to the first install for pictures the user may
 * never scroll to, and this handler caches each one as it is actually shown.
 */
const IMMUTABLE = /\/assets\/exercises\/.+\.webp$/;

/**
 * Paths are relative to the service worker's own scope, so the app works
 * unchanged from a GitHub Pages subdirectory or a domain root.
 */
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',

  './css/tokens.css',
  './css/base.css',
  './css/layout.css',
  './css/components.css',
  './css/workout.css',
  './css/charts.css',
  './css/reports.css',

  './js/app.js',
  './js/config.js',
  './js/core/dom.js',
  './js/core/format.js',
  './js/core/events.js',
  './js/core/router.js',
  './js/core/download.js',
  './js/engine/progression.js',
  './js/engine/one-rep-max.js',
  './js/engine/analytics.js',
  './js/engine/review.js',
  './js/services/storage-adapter.js',
  './js/services/db.js',
  './js/services/program-service.js',
  './js/services/settings-service.js',
  './js/services/body-service.js',
  './js/services/notes-service.js',
  './js/services/session-service.js',
  './js/services/pr-service.js',
  './js/services/rest-timer.js',
  './js/services/analytics-service.js',
  './js/services/logs-service.js',
  './js/services/photo-store.js',
  './js/services/review-service.js',
  './js/services/pwa-service.js',
  './js/pages/home.js',
  './js/pages/workout.js',
  './js/pages/history.js',
  './js/charts/chart-loader.js',
  './js/charts/chart-theme.js',
  './js/reports/pdf-loader.js',
  './js/reports/pdf-report.js',
  './js/reports/photo-embed.js',
  './js/reports/csv.js',
  './js/pages/progress.js',
  './js/pages/reports.js',
  './js/pages/notes.js',
  './js/pages/photos.js',
  './js/pages/logs.js',
  './js/pages/settings.js',

  './components/nav.js',
  './components/ring.js',
  './components/stat.js',
  './components/toast.js',
  './components/set-row.js',
  './components/rest-bar.js',
  './components/sheet.js',
  './components/chart-card.js',

  './assets/vendor/chart.umd.js',
  './assets/vendor/jspdf.umd.min.js',

  './data/workouts.json',

  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Added one at a time rather than with cache.addAll, which rejects the
      // whole batch if a single entry 404s. One missing icon should not cost
      // the app its offline support.
      await Promise.all(
        PRECACHE.map(async (path) => {
          try {
            await cache.add(new Request(path, { cache: 'reload' }));
          } catch (error) {
            console.warn('[sw] could not precache', path, error);
          }
        })
      );
      // Take over immediately — there is only ever one client, and waiting
      // for every tab to close before an update applies is pointless here.
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith('ironlog-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GETs are cacheable, and only same-origin requests are ours.
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

/** Serve from cache, revalidating in the background for next time. */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: false });

  if (cached) {
    // Exercise artwork never changes without its filename changing, so
    // revalidating it on every view is pure waste on a phone connection.
    // Everything else gets stale-while-revalidate: an instant response now,
    // a fresh copy for next time. Failures are ignored — being offline is the
    // expected case here, not an error.
    if (!IMMUTABLE.test(new URL(request.url).pathname)) refresh(cache, request);
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    // Nothing cached and no network: fall back to the shell so a deep link
    // still lands on a working app rather than a browser error page.
    const shell = await cache.match('./index.html');
    if (shell) return shell;
    throw error;
  }
}

/** Prefer the network so deploys are picked up, fall back to the cache. */
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch (error) {
    const cached = (await cache.match(request)) || (await cache.match('./index.html'));
    if (cached) return cached;
    throw error;
  }
}

function refresh(cache, request) {
  fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
    })
    .catch(() => { /* offline — the cached copy stands */ });
}

/** Lets the page trigger an immediate update after a deploy. */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
