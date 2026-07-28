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
// Bumped v1 -> v2 on 2026-07-28 to purge the mixed-version caches that the
// Edit-beta deploy left on returning visitors' devices (Sentry JAVASCRIPT-P —
// see the module-graph note in the fetch handler below). Bump this whenever a
// deploy could leave a stale entry that no longer matches its siblings.
const CACHE = 'pdflokal-shell-v2';
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

  // OUR OWN ES MODULES: network-first, cache only as the offline fallback.
  //
  // WHY this is not stale-while-revalidate like everything else (incident
  // 2026-07-28, Sentry JAVASCRIPT-P): SWR caches each file INDEPENDENTLY, and
  // this repo has no build step, so no content hashes force a matched set.
  // After a deploy that adds a module, a returning visitor gets a MIXTURE —
  // the already-cached old `telemetry-schema.js` served stale, alongside the
  // brand-new `page-surgery.js` fetched fresh because it was never cached.
  // The new module imports an export the old one doesn't have →
  // "does not provide an export named …" → the module graph dies and the
  // feature is broken for that user until a reload happens to refresh both.
  // Bumping CACHE fixes one deploy; this fixes the CLASS, because a module
  // graph is only ever coherent as a SET and must be fetched as one.
  //
  // `/js/vendor/` is deliberately EXCLUDED and stays stale-while-revalidate:
  // it is 2.6MB, changes rarely, and imports none of our modules — so it
  // cannot participate in this skew, and making it network-first would cost
  // real load time for nothing.
  if (url.pathname.startsWith('/js/') && !url.pathname.startsWith('/js/vendor/')) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (cacheable(request, res)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(async () => (await caches.match(request)) || Response.error()),
    );
    return;
  }

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
