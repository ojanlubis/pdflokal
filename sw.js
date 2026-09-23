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
//
// Bumped v2 -> v3 on 2026-09-07 for the SAME class, measured again: Sentry
// JAVASCRIPT-V/J (4+2 events, 2026-08-18 → 08-30) is a STALE HTML served beside
// a fresh app.js — `document.getElementById('fm-pages')` returns null and the
// module dies at top level, though every page on disk has carried that id since
// 2026-08-09. JAVASCRIPT-Y/Z (2+1 events) is the module half: a stale
// telemetry-schema.js beside a sibling importing `ocrLinesBucket`, which landed
// 2026-08-23. Both kill js/v2/app.js at module top level, so the editor, the
// toolbar AND the telemetry all go with it — the rail cannot report this by
// construction, because the reporting module is part of the dead graph.
//
// ⚠️ THE BUMP CURES THE STRANDED, NOT THE CLASS. It evicts the poisoned v2
// caches once (see the activate handler below). It does nothing about the
// mechanism that poisons v3: the offline fallback in the /js/ branch below is
// PER-FILE, so one module can still fall back to a stale cached copy while its
// siblings arrive fresh. The recovery for that is the boot guard in
// index.html's <head> — a matched-generation cache is the real fix and is not
// built. tests/core/sw-cache-generation.test.mjs names the poisoned generations.
//
// Bumped v3 -> v5 on 2026-09-21 for the SAME class, third measurement: Sentry
// JAVASCRIPT-10/13 (63 events, 2026-09-09 → 09-21) is the install-day `/`
// shell — precached when v3 installed and never refreshed by a launch that
// carries a query string — served as the fallback for a failed navigation,
// beside a fresh js/v2/download-sheet.js addressing `#ds-signed`, an element
// that shell never had. The bump evicts those shells once. The two changes in
// the fetch handler below (a refreshed `/` on every root navigation, and one
// retry before any cache fallback) are what stop this generation drifting the
// same way; tests/core/sw-shell-refresh.test.mjs drives both. `v4` is skipped
// on purpose: a seat session bumped to it on a local branch the same day, and
// a generation name is never reused, so the two fixes cannot collide on one.
const CACHE = 'pdflokal-shell-v5';
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

// ONE RETRY BEFORE THE CACHE, on the two network-first paths below.
//
// WHY (Sentry JAVASCRIPT-10/13, 63 events, 2026-09-09 → 09-21; JAVASCRIPT-Q):
// a network-first path that falls back to its cache on the FIRST failure
// turns a one-request blip into a cross-deploy skew. A PWA launched from the
// home screen on a phone whose radio is still waking fails its navigation and
// then fetches every module fresh a second later; a flaky cell link drops one
// module out of twelve. Either way the page runs a mixture. The blip is over
// within the second, so a single retry after a short pause serves the network
// response where the fallback used to serve stale bytes. Offline is not a
// blip: the pause is skipped so both attempts fail fast, and the offline
// fallback stays as quick as it was. A second failure is real and goes to the
// cache exactly as before.
const RETRY_MS = 300;
function fetchWithOneRetry(request) {
  return fetch(request).catch(() => {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    return new Promise((resolve) => setTimeout(resolve, offline ? 0 : RETRY_MS))
      .then(() => fetch(request));
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Same-origin only — let GA/gtag/DoubleClick/Sentry and Vercel insights pass straight through.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/_vercel/')) return;
  // A count of people is a claim about NOW: served from cache offline it would
  // show yesterday's number as today's. Network or nothing (api/visitors.js).
  if (url.pathname === '/api/visitors') return;

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
      fetchWithOneRetry(request)
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
      fetchWithOneRetry(request)
        .then((res) => {
          if (cacheable(request, res)) {
            const copy = res.clone();
            // THE LAST-RESORT SHELL IS REFRESHED TOO. `/` is written at install
            // (PRECACHE) and is what a failed navigation gets when its own URL
            // has no entry. A launch from the home screen arrives at
            // `/?utm_source=pwa`, an intent card at `/?buat=…`, so the bare
            // key was only ever rewritten by a visitor who typed the address,
            // and it drifted to install-day bytes while the modules moved on
            // (Sentry JAVASCRIPT-10/13: a shell without #ds-signed beside a
            // download-sheet.js that needs it). Any successful root
            // navigation now refreshes it, whatever its query string.
            const shell = url.pathname === '/' && url.search ? res.clone() : null;
            caches.open(CACHE).then((c) => Promise.all([
              c.put(request, copy),
              shell && c.put('/', shell),
            ]));
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
