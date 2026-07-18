/*
 * PDFLokal service worker — makes the app installable + openable offline.
 * WHY offline matters here: it makes the moat literally true ("filemu diproses di
 * HP-mu") from a cold launch, and installability is what lets us offer the
 * home-screen install nudge (see js/v2/celebrate.js).
 *
 * Freshness-first by design — this repo deploys on every push, so a SW that
 * pinned old assets would be a foot-gun:
 *   - Navigations (HTML): NETWORK-FIRST → cache fallback. Online users always
 *     get the latest app; offline users get the last-seen shell.
 *   - Same-origin static assets: STALE-WHILE-REVALIDATE (fast, self-updating).
 *   - Cross-origin (GA, gtag, DoubleClick, Sentry, Vercel insights): NOT touched.
 * Bump CACHE to purge everything on a breaking change.
 */
const CACHE = 'pdflokal-shell-v1';
const PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/images/icon-192.png',
  '/images/icon-512.png',
  '/images/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Only cache same-origin, GET, successful, non-partial basic responses.
function cacheable(request, response) {
  return response
    && response.status === 200
    && response.type === 'basic'
    && request.method === 'GET';
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Same-origin only — let GA/gtag/DoubleClick/Sentry and Vercel insights pass straight through.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/_vercel/')) return;

  // HTML navigations: network-first so a fresh deploy always wins online.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (cacheable(request, res)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(async () => (await caches.match(request))
          || (await caches.match('/'))
          || Response.error()),
    );
    return;
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (cacheable(request, res)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
