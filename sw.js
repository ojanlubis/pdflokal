/*
 * PDFLokal service worker — makes the app installable + openable offline.
 * WHY offline matters here: it makes the moat literally true ("filemu diproses di
 * HP-mu") from a cold launch, and installability is what lets us offer the
 * home-screen install nudge (see js/v2/celebrate.js).
 *
 * Freshness-first by design — this repo deploys on every push, so a SW that
 * pinned old assets would be a foot-gun:
 *   - Navigations (HTML): NETWORK-FIRST → cache fallback. Online users always
 *     get the latest app; offline users get the last COMPLETE generation.
 *   - Our own modules (/js/, not vendor): never chosen per file. A page load
 *     takes ALL of them from the network or ALL of them from one complete
 *     generation — see "GENERATIONS" below. This is the v8 rule.
 *   - Other same-origin static assets: STALE-WHILE-REVALIDATE.
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
//
// Bumped v5 -> v6 on 2026-10-01 for the English editor (/en). A worker that does
// not know /en would serve it the Indonesian `/` shell as the offline fallback,
// and a v5 cache holds no /en entry to evict. The bump makes every returning
// device reinstall, which is when /en is precached (see PRECACHE_LANG below).
//
// Bumped v6 -> v7 on 2026-10-02 for the English support page (/en/support). Same
// reason as v6: a worker that did not know the page has no entry to evict and
// never precached it; the bump makes returning devices reinstall, which is when
// /en/support is precached (PRECACHE_LANG below). Offline, a navigation to it
// that has no entry falls back to /en (homeFor), never to the Indonesian `/`.
//
// Bumped v7 -> v8 on 2026-10-02, and THIS ONE CHANGES THE MECHANISM, not only
// the name. Sentry JAVASCRIPT-18 (Chrome Mobile 154, 12:59Z): a fresh app.js
// beside a pre-#165 js/core/import.js with no `pdfLibLoadError`. Reproduced in
// Chromium (tests/sw-generation.spec.js): warm the worker on deploy A, deploy B,
// drop import.js twice on the phone's link, and the per-file fallback below
// served A's import.js beside B's app.js — the skew, made by this file. Five
// bumps evicted five poisoned caches and none of them touched that fallback,
// which is why the class kept coming back. v8 removes it: see GENERATIONS. The
// bump itself only evicts v7's per-file cache, which is mixed by construction.
const CACHE = 'pdflokal-shell-v8';
// GENERATIONS. A generation is the set of responses ONE page load fetched from
// the network: its HTML and every /js/ module it imported. It is written to
// its own cache, `pdflokal-gen-v8-<id>`, and becomes COMPLETE only when that
// page tells us its module graph linked and ran (js/v2/app.js posts
// 'pdflokal:booted' from its last line). Only a complete generation is ever
// served from cache, and a page served from one gets nothing from any other.
//
// WHY the page is the witness and not a version number: there is no build
// step, so no file knows the deploy it belongs to, and a hand-bumped constant
// is what v1..v7 were. A link failure is invisible to a service worker — only
// the page sees it — so "this set booted" is the one completeness signal that
// is both observable and true.
const GEN_PREFIX = 'pdflokal-gen-v8-';
const COMPLETE = '/__sw/complete';
const LOAD_PREFIX = '/__sw/load/';
const RECOVERED = '/__sw/recovered';
// The two language homes. Each is the last-resort shell for its own subtree: an
// offline navigation under /en must land on /en, never on the Indonesian `/`.
const HOME = '/';
const HOME_EN = '/en';
const SUPPORT_EN = '/en/support';
const homeFor = (pathname) => (pathname === HOME_EN || pathname.startsWith(HOME_EN + '/') ? HOME_EN : HOME);
const PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/images/icon-192.png',
  '/images/icon-512.png',
  '/images/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE)
        // PRECACHE_LANG: the English shell and its support page are added on
        // their own, and a failure to fetch either is swallowed. addAll is
        // all-or-nothing, so putting /en in PRECACHE would let a bad /en response
        // abort the install of the whole worker and take the Indonesian offline
        // shell with it.
        .then(() => Promise.all([HOME_EN, SUPPORT_EN].map((u) => c.add(u).catch(() => {})))))
      .then(() => self.skipWaiting()),
  );
});

// Evict every cache this worker does not own: older shell names AND older
// generation prefixes. A generation of THIS prefix survives activation — it is
// the offline copy, and a reinstall (the boot guard unregisters, the page
// registers again) must not cost the user their last complete set.
const ours = (k) => k === CACHE || k.startsWith(GEN_PREFIX);
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !ours(k)).map((k) => caches.delete(k))))
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
// fallback stays as quick as it was. A second failure is real: a navigation
// then goes to its complete generation; a module does NOT (see GENERATIONS).
const RETRY_MS = 300;
function fetchWithOneRetry(request) {
  return fetch(request).catch(() => {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    return new Promise((resolve) => setTimeout(resolve, offline ? 0 : RETRY_MS))
      .then(() => fetch(request));
  });
}

// ---- per-load state ----------------------------------------------------------
// Which source a page load is bound to, keyed by its client id:
//   { mode: 'network', gen, committed }  its navigation came from the network;
//                                        every module comes from the network too
//                                        and is written into `gen`.
//   { mode: 'cache', gen }               its navigation came from complete
//                                        generation `gen` (or, with gen null,
//                                        from the install-day precache); every
//                                        module comes from that same `gen`.
// Kept in memory AND persisted under LOAD_PREFIX in CACHE, because the browser
// stops an idle worker after ~30s and a tab that imports a module minutes later
// (Kompres, Unduh as JPG) must still be answered from its own generation.
// A client with no record (its navigation was never seen by this worker: the
// first visit, a browser with no resultingClientId) gets network-or-nothing for
// modules and writes nowhere — never a cached copy chosen file by file.
const loads = new Map();
const loadKey = (id) => LOAD_PREFIX + encodeURIComponent(id);

async function loadFor(clientId) {
  if (!clientId) return null;
  if (loads.has(clientId)) return loads.get(clientId);
  try {
    const hit = await caches.match(loadKey(clientId), { cacheName: CACHE });
    if (!hit) return null;
    const st = await hit.json();
    loads.set(clientId, st);
    return st;
  } catch {
    return null;
  }
}

function setLoad(clientId, st) {
  if (!clientId) return Promise.resolve();
  loads.set(clientId, st);
  return caches.open(CACHE)
    .then((c) => c.put(loadKey(clientId), new Response(JSON.stringify(st), { headers: { 'content-type': 'application/json' } })))
    .catch(() => {});
}

// Writes into one generation are chained, so a commit can wait for every write
// the load started before it declares the generation complete.
const pending = new Map();
function writeTo(gen, request, response) {
  const prev = pending.get(gen) || Promise.resolve();
  const next = prev.then(() => caches.open(gen)).then((c) => c.put(request, response)).catch(() => {});
  pending.set(gen, next);
  return next;
}

const newGen = () => GEN_PREFIX + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

// Complete generations, newest first.
async function completeGens() {
  const out = [];
  for (const name of (await caches.keys()).filter((k) => k.startsWith(GEN_PREFIX))) {
    const mark = await caches.match(COMPLETE, { cacheName: name });
    if (!mark) continue;
    let at = 0;
    try { at = (await mark.json()).at || 0; } catch { /* a marker without a time sorts last */ }
    out.push({ name, at });
  }
  return out.sort((a, b) => b.at - a.at);
}

// An offline navigation is answered from the NEWEST complete generation that
// can answer it — its own URL, else its language home — and the load is bound
// to that generation for every module it asks for. Only when no generation can
// answer does the install-day precache serve the shell, and then the load is
// bound to nothing: a precached shell beside modules from some later visit is
// exactly the JAVASCRIPT-10/13 skew, so it gets no modules at all.
async function offlineShell(request, url) {
  const home = homeFor(url.pathname);
  for (const g of await completeGens()) {
    const hit = (await caches.match(request, { cacheName: g.name })) || (await caches.match(home, { cacheName: g.name }));
    if (hit) return { res: hit, gen: g.name };
  }
  const pre = (await caches.match(request, { cacheName: CACHE })) || (await caches.match(home, { cacheName: CACHE }));
  return pre ? { res: pre, gen: null } : null;
}

// THE COMMIT. js/v2/app.js posts 'pdflokal:booted' as its last statement, so
// this runs only for a load whose whole static module graph linked and
// evaluated. That load's generation becomes servable offline.
async function commit(clientId) {
  const st = await loadFor(clientId);
  if (!st || st.mode !== 'network' || !st.gen || st.committed) return;
  await pending.get(st.gen);
  if (!(await caches.has(st.gen))) return;
  await (await caches.open(st.gen)).put(COMPLETE, new Response(JSON.stringify({ at: Date.now() }), { headers: { 'content-type': 'application/json' } }));
  await setLoad(clientId, { ...st, committed: true });
  await prune();
}

// Keep the two newest complete generations, plus the newest one that holds each
// language home (so an offline launch of `/` survives a run of /kompres-pdf
// visits), plus any generation a live tab is bound to. Everything else under
// the prefix goes, including the incomplete generations of loads that died.
async function prune() {
  const live = new Set((await self.clients.matchAll({ type: 'window' })).map((c) => c.id));
  const shell = await caches.open(CACHE);
  const inUse = new Set();
  for (const req of await shell.keys()) {
    const p = new URL(req.url).pathname;
    if (!p.startsWith(LOAD_PREFIX)) continue;
    const id = decodeURIComponent(p.slice(LOAD_PREFIX.length));
    if (!live.has(id)) { loads.delete(id); await shell.delete(req); continue; }
    const st = await loadFor(id);
    if (st && st.gen) inUse.add(st.gen);
  }
  const gens = await completeGens();
  const keep = new Set(gens.slice(0, 2).map((g) => g.name));
  for (const home of [HOME, HOME_EN]) {
    for (const g of gens) {
      if (await caches.match(home, { cacheName: g.name })) { keep.add(g.name); break; }
    }
  }
  for (const name of (await caches.keys()).filter((k) => k.startsWith(GEN_PREFIX))) {
    if (!keep.has(name) && !inUse.has(name)) await caches.delete(name);
  }
}

// RECOVERY, for the one case the generation rule makes worse than before: a
// load bound to the network whose module fails twice. v7 would have handed it
// a cached copy — fine when that copy happened to match, the skew when it did
// not. v8 refuses, so the page would sit dead. Instead the worker reloads the
// tab ONCE: if the network is back the reload is a clean network load; if it
// is gone, the navigation fails and the load is served whole from the last
// complete generation. Never after the load has committed — a lazy import
// failing mid-session must not throw away the user's open document — and at
// most once a minute, recorded in CACHE so a restarted worker cannot loop.
const RECOVERY_GAP_MS = 60000;
async function recover(clientId) {
  try {
    const last = await caches.match(RECOVERED, { cacheName: CACHE });
    const at = last ? (await last.json()).at : 0;
    if (Date.now() - at < RECOVERY_GAP_MS) return;
    const client = await self.clients.get(clientId);
    if (!client || typeof client.navigate !== 'function') return;
    await (await caches.open(CACHE)).put(RECOVERED, new Response(JSON.stringify({ at: Date.now() }), { headers: { 'content-type': 'application/json' } }));
    await client.navigate(client.url);
  } catch {
    // A recovery that cannot run leaves the page exactly as dead as v7's refusal would.
  }
}

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'pdflokal:booted' || !event.source || !event.source.id) return;
  event.waitUntil(commit(event.source.id).catch(() => {}));
});

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

  // OUR OWN ES MODULES: from the page's own source, never chosen per file.
  //
  // WHY (incident 2026-07-28, Sentry JAVASCRIPT-P; again 2026-10-02,
  // JAVASCRIPT-18): this repo has no build step, so no content hash forces a
  // matched set. A module graph is only coherent as a SET. Until v7 this branch
  // was network-first with a PER-FILE cache fallback: a module that failed twice
  // got whatever copy the cache held — from any earlier deploy — beside siblings
  // that arrived fresh. After a deploy that changed an export, that is
  // "does not provide an export named …" and the whole editor dies at link
  // time. MEASURED in Chromium, tests/sw-generation.spec.js.
  //
  // Now the source is decided ONCE per page load, by its navigation:
  //   network-bound: network (one retry) or nothing, written to the load's own
  //                  generation; a failure before the commit triggers recover().
  //   cache-bound:   that one complete generation or nothing — never the
  //                  network, whose bytes may be a later deploy.
  //
  // `/js/vendor/` is deliberately EXCLUDED and stays stale-while-revalidate:
  // it is 2.6MB, changes rarely, and imports none of our modules — so it
  // cannot participate in this skew, and making it network-first would cost
  // real load time for nothing.
  if (url.pathname.startsWith('/js/') && !url.pathname.startsWith('/js/vendor/')) {
    event.respondWith((async () => {
      const st = await loadFor(event.clientId);
      if (st && st.mode === 'cache') {
        const hit = st.gen && await caches.match(request, { cacheName: st.gen });
        return hit || Response.error();
      }
      try {
        const res = await fetchWithOneRetry(request);
        if (st && st.gen && cacheable(request, res)) event.waitUntil(writeTo(st.gen, request, res.clone()));
        return res;
      } catch {
        if (st && !st.committed) event.waitUntil(recover(event.clientId));
        return Response.error();
      }
    })());
    return;
  }

  // HTML navigations: network-first so a fresh deploy always wins online.
  if (request.mode === 'navigate') {
    const clientId = event.resultingClientId;
    event.respondWith((async () => {
      let res;
      try {
        res = await fetchWithOneRetry(request);
      } catch {
        const off = await offlineShell(request, url);
        event.waitUntil(setLoad(clientId, { mode: 'cache', gen: off ? off.gen : null }));
        return off ? off.res : Response.error();
      }
      // A new generation per network load. Its HTML is written beside the
      // modules this load is about to fetch, so the shell and the modules an
      // offline launch gets were proven together.
      //
      // THE LAST-RESORT SHELL IS WRITTEN TOO (Sentry JAVASCRIPT-10/13). A launch
      // from the home screen arrives at `/?utm_source=pwa`, an intent card at
      // `/?buat=…`; the bare key is what an offline launch falls back to, so a
      // root navigation stores it whatever its query string. Per language:
      // `/en?utm_source=pwa` stores `/en`.
      const gen = cacheable(request, res) ? newGen() : null;
      event.waitUntil(setLoad(clientId, { mode: 'network', gen, committed: false }));
      if (gen) {
        const home = homeFor(url.pathname);
        event.waitUntil(writeTo(gen, request, res.clone()));
        if (url.pathname === home && url.search) event.waitUntil(writeTo(gen, home, res.clone()));
      }
      return res;
    })());
    return;
  }

  // Static assets: stale-while-revalidate.
  event.respondWith(
    caches.match(request, { cacheName: CACHE }).then((cached) => {
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
