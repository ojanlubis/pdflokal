/*
 * THE SERVICE WORKER'S FETCH HANDLER, DRIVEN: what it hands a page when the
 * network is flaky, measured on the two paths that produced a cross-deploy skew.
 * ============================================================================
 * Sentry JAVASCRIPT-10/13 (63 events) was a shell older than the module it
 * loaded. The shell can only come from sw.js's own cache, and two things
 * about that cache were wrong in the same direction:
 *
 *   1. `/` is written ONCE, at install (PRECACHE), and only a navigation to
 *      exactly `/` ever rewrote it. A PWA launches at `/?utm_source=pwa`, an
 *      intent card at `/?buat=…` — those successful navigations refreshed
 *      their own key and left `/` at install-day bytes. `/` is also the LAST
 *      RESORT for every failed navigation, so the staler it got, the more it
 *      was served.
 *   2. Every network failure went straight to the cache. A cold PWA launch on
 *      a phone whose radio is still waking fails its first request and passes
 *      its second; the shell came from cache, the modules from the network.
 *      One retry before the fallback closes exactly that gap.
 *
 * tests/core/sw-cache-generation.test.mjs proves eviction; this file proves
 * the handler's BEHAVIOUR, by loading sw.js against a stub of the worker
 * global and dispatching fetch events at it. The stub is deliberately thin —
 * a Map of URL → Response — so that a change to what the handler stores or
 * serves shows up here as a changed body, not as a passing ritual.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SW_SRC = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
const ORIGIN = 'https://www.pdflokal.id';

// A 200 same-origin response the handler will agree to cache. Node's Response
// reports type 'default'; the worker's `cacheable()` asks for 'basic', which
// is what a same-origin fetch reports in a browser.
function basic(body) {
  const res = new Response(body, { status: 200 });
  Object.defineProperty(res, 'type', { value: 'basic' });
  return res;
}
const key = (req) => new URL(typeof req === 'string' ? req : req.url, ORIGIN).href;
const text = async (res) => (res ? res.text() : null);

// Load sw.js into a fresh worker-shaped global. `fetchImpl` is the network.
function loadWorker(fetchImpl, { online = true } = {}) {
  const listeners = {};
  const store = new Map();
  const cache = {
    put: async (req, res) => { store.set(key(req), res); },
    match: async (req) => store.get(key(req)),
    addAll: async (urls) => { for (const u of urls) store.set(key(u), basic(`precached ${u}`)); },
  };
  const caches = {
    open: async () => cache,
    match: (req) => cache.match(req),
    keys: async () => [],
    delete: async () => true,
  };
  const self = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    location: new URL(ORIGIN + '/sw.js'),
    navigator: { onLine: online },
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
  };
  const ctx = vm.createContext({ self, caches, fetch: fetchImpl, Response, URL, console, setTimeout, navigator: self.navigator });
  vm.runInContext(SW_SRC, ctx, { filename: 'sw.js' });
  assert.equal(typeof listeners.fetch, 'function', 'sw.js registered no fetch listener — the harness is not seeing the handler');
  return { listeners, store, seed: (url, body) => store.set(key(url), basic(body)) };
}

// Dispatch one fetch event and return what respondWith() was handed. The
// handler's cache writes are fire-and-forget promise chains, so the result is
// awaited and then the microtask queue drained before anything is asserted.
async function dispatch(worker, request) {
  let responded = null;
  worker.listeners.fetch({ request, respondWith: (p) => { responded = p; }, waitUntil: () => {} });
  const res = responded ? await responded : null;
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return res;
}
const navigate = (url) => ({ url: ORIGIN + url, method: 'GET', mode: 'navigate' });
const moduleReq = (url) => ({ url: ORIGIN + url, method: 'GET', mode: 'cors' });

// A network that fails the first `failures` calls, then serves `body`.
function flaky(failures, body) {
  let calls = 0;
  const impl = async () => {
    calls += 1;
    if (calls <= failures) throw new TypeError('Failed to fetch');
    return basic(body);
  };
  impl.calls = () => calls;
  return impl;
}

test('1. a successful navigation with a query string refreshes the last-resort "/" shell too', async () => {
  const worker = loadWorker(async () => basic('shell of today'));
  worker.seed('/', 'shell from install day');

  const res = await dispatch(worker, navigate('/?utm_source=pwa'));
  assert.equal(await text(res), 'shell of today', 'the online navigation did not get the network response');

  assert.equal(await text(worker.store.get(key('/'))), 'shell of today',
    'the "/" entry still holds install-day bytes after a successful navigation to "/?utm_source=pwa". '
    + 'A PWA user never navigates to bare "/", so this entry is only ever refreshed by the fix under test — '
    + 'and it is the fallback every failed launch is served (Sentry JAVASCRIPT-10/13).');
  assert.equal(await text(worker.store.get(key('/?utm_source=pwa'))), 'shell of today',
    'the navigation\'s own key was not stored — the refresh must be IN ADDITION to the existing write');
});

test('2. CONTROL: a navigation to a different page does not overwrite the "/" shell', async () => {
  const worker = loadWorker(async () => basic('kompres page'));
  worker.seed('/', 'landing');
  await dispatch(worker, navigate('/kompres-pdf'));
  assert.equal(await text(worker.store.get(key('/'))), 'landing',
    'a navigation to /kompres-pdf replaced the "/" shell — the refresh is for the ROOT path only, or every '
    + 'failed launch would land on whichever tool page was visited last');
});

test('3. a module fetch that fails ONCE and then succeeds is served fresh, never from the cache', async () => {
  const net = flaky(1, 'export function feedback() {}');
  const worker = loadWorker(net);
  worker.seed('/js/v2/telemetry.js', '/* stale: no feedback export */');

  const res = await dispatch(worker, moduleReq('/js/v2/telemetry.js'));
  assert.equal(net.calls(), 2, `the handler tried the network ${net.calls()} time(s) — one transient failure must be retried before the cache is consulted`);
  assert.equal(await text(res), 'export function feedback() {}',
    'one transient network failure handed the page a STALE module beside fresh siblings — the skew that killed '
    + 'js/v2/edit-feedback.js at import (Sentry JAVASCRIPT-Q)');
});

test('4. CONTROL: a module fetch that keeps failing still falls back to the cache — offline must keep working', async () => {
  const net = flaky(Infinity, 'never');
  const worker = loadWorker(net, { online: false });
  worker.seed('/js/v2/telemetry.js', 'cached copy');
  const res = await dispatch(worker, moduleReq('/js/v2/telemetry.js'));
  assert.equal(await text(res), 'cached copy', 'the offline fallback is gone — a retry must never replace it');
});

test('5. a navigation that fails ONCE and then succeeds gets today\'s shell, not the cached one', async () => {
  const net = flaky(1, 'shell of today');
  const worker = loadWorker(net);
  worker.seed('/', 'shell from install day');
  const res = await dispatch(worker, navigate('/?utm_source=pwa'));
  assert.equal(await text(res), 'shell of today',
    'a single failed navigation request served the install-day shell to a user whose modules were about to '
    + 'arrive fresh — the cold-launch skew (Sentry JAVASCRIPT-10/13)');
});

test('6. VACUITY GUARD: the harness can see a real failure — a body the handler never wrote reads back null', async () => {
  const worker = loadWorker(async () => basic('x'));
  assert.equal(await text(worker.store.get(key('/never'))), null);
  const res = await dispatch(worker, navigate('/?buat=kompres'));
  assert.equal(await text(res), 'x');
});
