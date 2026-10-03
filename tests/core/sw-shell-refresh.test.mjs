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
 * named Maps of URL → Response, shared with sw-generations.test.mjs through
 * sw-harness.mjs — so that a change to what the handler stores or serves shows
 * up here as a changed body, not as a passing ritual. Since sw.js v8 an online
 * navigation writes into its own GENERATION, so these read that generation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CACHE, basic, key, text, loadWorker, dispatch, install, navigate, moduleReq, flaky,
} from './sw-harness.mjs';

// Since sw.js v8 a navigation writes into a GENERATION of its own, not into the
// shared shell cache: the bytes a page loaded live together. These read the
// one generation a navigation created.
async function navOnline(worker, url, id = 'tab') {
  worker.open(id, url);
  const res = await dispatch(worker, navigate(url), { resultingClientId: id });
  const gens = worker.gens();
  assert.equal(gens.length, 1, `expected the navigation to open exactly one generation, found ${gens.length}`);
  return { res, gen: gens[0] };
}

test('1. a successful navigation with a query string refreshes the last-resort "/" shell too', async () => {
  const worker = loadWorker(async () => basic('shell of today'));
  worker.seed('/', 'shell from install day');

  const { res, gen } = await navOnline(worker, '/?utm_source=pwa');
  assert.equal(await text(res), 'shell of today', 'the online navigation did not get the network response');

  assert.equal(await worker.read('/', gen), 'shell of today',
    'the "/" entry still holds install-day bytes after a successful navigation to "/?utm_source=pwa". '
    + 'A PWA user never navigates to bare "/", so this entry is only ever refreshed by the fix under test — '
    + 'and it is the fallback every failed launch is served (Sentry JAVASCRIPT-10/13).');
  assert.equal(await worker.read('/?utm_source=pwa', gen), 'shell of today',
    'the navigation\'s own key was not stored — the refresh must be IN ADDITION to the existing write');
});

test('2. CONTROL: a navigation to a different page does not overwrite the "/" shell', async () => {
  const worker = loadWorker(async () => basic('kompres page'));
  worker.seed('/', 'landing');
  const { gen } = await navOnline(worker, '/kompres-pdf');
  assert.equal(await worker.read('/kompres-pdf', gen), 'kompres page', 'the navigation did not store its own page');
  assert.equal(await worker.read('/', gen), null,
    'a navigation to /kompres-pdf replaced the "/" shell — the refresh is for the ROOT path only, or every '
    + 'failed launch would land on whichever tool page was visited last');
});

test('3. a module fetch that fails ONCE and then succeeds is served fresh, never from the cache', async () => {
  const net = flaky(1, 'export function feedback() {}');
  const worker = loadWorker(net);
  worker.seed('/js/v2/telemetry.js', '/* stale: no feedback export */');

  const res = await dispatch(worker, moduleReq('/js/v2/telemetry.js'), { clientId: 'tab' });
  assert.equal(net.calls(), 2, `the handler tried the network ${net.calls()} time(s) — one transient failure must be retried before the cache is consulted`);
  assert.equal(await text(res), 'export function feedback() {}',
    'one transient network failure handed the page a STALE module beside fresh siblings — the skew that killed '
    + 'js/v2/edit-feedback.js at import (Sentry JAVASCRIPT-Q)');
});

// Test 4 used to pin the PER-FILE offline fallback ("a module that keeps
// failing still gets the cached copy"). That fallback is what produced Sentry
// JAVASCRIPT-18, and sw.js v8 removed it on purpose: offline modules now come
// whole from one complete generation. tests/core/sw-generations.test.mjs pins
// both halves — the refusal, and offline still opening.
test('4. a module fetch that keeps failing is NOT answered with a cached copy chosen file by file', async () => {
  const net = flaky(Infinity, 'never');
  const worker = loadWorker(net, { online: false });
  worker.seed('/js/v2/telemetry.js', 'cached copy');
  const res = await dispatch(worker, moduleReq('/js/v2/telemetry.js'), { clientId: 'tab' });
  assert.notEqual(await text(res).catch(() => null), 'cached copy',
    'a module request from a page the worker cannot place in a generation was answered with a cached copy — '
    + 'the per-file fallback is back, and with it the cross-deploy skew (Sentry JAVASCRIPT-18)');
  assert.equal(res.type, 'error');
});

test('5. a navigation that fails ONCE and then succeeds gets today\'s shell, not the cached one', async () => {
  const net = flaky(1, 'shell of today');
  const worker = loadWorker(net);
  worker.seed('/', 'shell from install day');
  const { res } = await navOnline(worker, '/?utm_source=pwa');
  assert.equal(await text(res), 'shell of today',
    'a single failed navigation request served the install-day shell to a user whose modules were about to '
    + 'arrive fresh — the cold-launch skew (Sentry JAVASCRIPT-10/13)');
});

test('6. VACUITY GUARD: the harness can see a real failure — a body the handler never wrote reads back null', async () => {
  const worker = loadWorker(async () => basic('x'));
  assert.equal(await worker.read('/never'), null);
  const { res } = await navOnline(worker, '/?buat=kompres');
  assert.equal(await text(res), 'x');
});

// ---- the English shell (/en) -------------------------------------------------
// The worker keeps one last-resort shell PER LANGUAGE. Without this, an offline
// navigation to /en/anything is served the Indonesian `/`, and the English
// editor is silently Indonesian the moment the network goes.

test('7. install precaches /en beside /', async () => {
  const worker = loadWorker(async () => basic('x'));
  await install(worker);
  assert.equal(await worker.read('/en'), 'precached /en', 'the English shell is not precached');
  assert.equal(await worker.read('/'), 'precached /', 'the Indonesian shell is not precached');
});

test('8. a /en that cannot be precached does not abort the install (the Indonesian shell must survive it)', async () => {
  const worker = loadWorker(async () => basic('x'), { failAdd: ['/en'] });
  await assert.doesNotReject(() => install(worker));
  assert.equal(await worker.read('/'), 'precached /', 'a bad /en took the root shell down with it');
});

test('9. an offline navigation under /en lands on /en, never on the Indonesian /', async () => {
  const worker = loadWorker(async () => { throw new TypeError('Failed to fetch'); }, { online: false });
  // A stored Response body can be read once, so each navigation reseeds the shells.
  const go = async (url) => {
    worker.seed('/', 'indonesian shell');
    worker.seed('/en', 'english shell');
    return text(await dispatch(worker, navigate(url)));
  };
  assert.equal(await go('/en'), 'english shell');
  assert.equal(await go('/en/merge-pdf'), 'english shell', 'a path under /en/ fell back to the Indonesian shell');
  // CONTROL: the prefix is /en/ or exactly /en, not any path that merely starts with the letters.
  assert.equal(await go('/english-notes'), 'indonesian shell', '/english-notes is not under /en/');
  assert.equal(await go('/gabung-pdf'), 'indonesian shell', 'the Indonesian fallback regressed');
});

test('10. a successful /en navigation with a query string refreshes /en, and leaves / alone', async () => {
  const worker = loadWorker(async () => basic('english of today'));
  worker.seed('/', 'indonesian from install day');
  worker.seed('/en', 'english from install day');
  const { gen } = await navOnline(worker, '/en?utm_source=pwa');
  assert.equal(await worker.read('/en', gen), 'english of today', 'the /en shell was not written with this load');
  assert.equal(await worker.read('/', gen), null, 'an /en navigation wrote the Indonesian shell');
  assert.equal(await worker.read('/'), 'indonesian from install day', 'an /en navigation overwrote the Indonesian shell');
});

// ---- the English support page (/en/support), v7 -------------------------------

test('11. install precaches /en/support too, and a bad one aborts neither the install nor /en', async () => {
  const ok = loadWorker(async () => basic('x'));
  await install(ok);
  assert.equal(await ok.read('/en/support'), 'precached /en/support', 'the English support page is not precached');
  const bad = loadWorker(async () => basic('x'), { failAdd: ['/en/support'] });
  await assert.doesNotReject(() => install(bad));
  assert.equal(await bad.read('/'), 'precached /', 'a bad /en/support took the root shell down with it');
  assert.equal(await bad.read('/en'), 'precached /en', 'a bad /en/support took /en down with it');
});

test('12. offline, /en/support is served from its own entry; with none it falls back to /en, never to /', async () => {
  const worker = loadWorker(async () => { throw new TypeError('Failed to fetch'); }, { online: false });
  worker.seed('/', 'indonesian shell');
  worker.seed('/en', 'english shell');
  worker.seed('/en/support', 'english support page');
  assert.equal(await text(await dispatch(worker, navigate('/en/support'))), 'english support page');
  worker.named.get(CACHE).delete(key('/en/support'));
  worker.seed('/en', 'english shell');
  assert.equal(await text(await dispatch(worker, navigate('/en/support'))), 'english shell');
});
