/*
 * SW GENERATIONS: a page load gets its modules from ONE source, never per file.
 * ============================================================================
 * Sentry JAVASCRIPT-18 (2026-10-02): a fresh js/v2/app.js beside a pre-#165
 * js/core/import.js. tests/sw-generation.spec.js reproduces it in Chromium —
 * the worker's per-file offline fallback handed a module that failed twice the
 * cached copy of the previous deploy. This file pins the v8 rule (sw.js,
 * GENERATIONS) at the handler level, where every branch can be driven:
 *
 *   - a load whose navigation came from the network gets its modules from the
 *     network or not at all, and they are written to that load's generation;
 *   - a load served from cache gets every module from that same COMPLETE
 *     generation, and never from the network, whose bytes may be a later deploy;
 *   - a generation becomes complete only when the page that made it says it
 *     booted ('pdflokal:booted', the last line of js/v2/app.js).
 *
 * Every test names what it would look like if the rule were broken, because a
 * "Response.error" is also what a broken harness returns: the vacuity checks
 * below make sure the same worker DOES serve when it should.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CACHE, COMPLETE, loadWorker, dispatch, message, activate, navigate, moduleReq, network, text,
} from './sw-harness.mjs';

const IMPORT = '/js/core/import.js';
const APP = '/js/v2/app.js';

// One full online page load: navigation, its modules, then (optionally) the
// page's own "I booted" message. Returns the generation it wrote.
async function onlineLoad(worker, id, url, modules, { boot = true } = {}) {
  worker.open(id, url);
  const before = new Set(worker.gens());
  const nav = await dispatch(worker, navigate(url), { resultingClientId: id });
  const gen = worker.gens().find((g) => !before.has(g));
  const served = {};
  for (const m of modules) served[m] = await dispatch(worker, moduleReq(m), { clientId: id });
  if (boot) await message(worker, { type: 'pdflokal:booted' }, id);
  return { nav, gen, served };
}
const isComplete = async (worker, gen) => (await worker.read(COMPLETE, gen)) !== null;

test('1. JAVASCRIPT-18: a module that fails twice in a network load is refused, not filled from the last deploy', async () => {
  let routes = { '/': 'html A', [APP]: 'app A', [IMPORT]: 'import A' };
  const worker = loadWorker((req) => network(routes)(req));
  const a = await onlineLoad(worker, 'tab-a', '/', [APP, IMPORT]);
  assert.ok(await isComplete(worker, a.gen), 'VACUITY: deploy A never became a complete generation');
  assert.equal(await worker.read(IMPORT, a.gen), 'import A', 'VACUITY: the cached copy the old fallback would have served is not there');
  worker.close('tab-a');

  // Deploy B, and the link drops import.js on both attempts.
  routes = { '/': 'html B', [APP]: 'app B', [IMPORT]: null };
  const b = await onlineLoad(worker, 'tab-b', '/', [APP, IMPORT], { boot: false });

  assert.equal(await text(b.served[APP]), 'app B');
  assert.equal(b.served[IMPORT].type, 'error',
    'import.js was answered from the cache beside app.js from deploy B — a module from one deploy beside its '
    + 'sibling from another is "does not provide an export named …" (Sentry JAVASCRIPT-18)');
  // The refusal is not left to sit: the tab is reloaded once, before it booted.
  assert.deepEqual(worker.navigations.map((x) => x.id), ['tab-b'], 'a network load that lost a module was not given its one recovery reload');
});

test('2. the recovery reload happens at most once a minute — a link that stays down cannot loop the tab', async () => {
  const worker = loadWorker(network({ '/': 'html', [APP]: 'app' }));
  await onlineLoad(worker, 'tab-1', '/', [APP, IMPORT], { boot: false });
  await onlineLoad(worker, 'tab-2', '/', [APP, IMPORT], { boot: false });
  assert.equal(worker.navigations.length, 1, `${worker.navigations.length} recovery reloads in a row — a reload loop is worse than a dead page`);
});

test('3. after the page booted, a lazy module that fails is refused WITHOUT a reload — the open document survives', async () => {
  const worker = loadWorker(network({ '/': 'html', [APP]: 'app' }));
  await onlineLoad(worker, 'tab', '/', [APP]);
  // No shipped module is lazy any more (tests/core/sw-lazy-modules.test.mjs), so
  // this names a path no page imports: what matters is the worker's answer to a
  // module request that fails after boot, whatever asks for it.
  const res = await dispatch(worker, moduleReq('/js/core/not-yet-imported.js'), { clientId: 'tab' });
  assert.equal(res.type, 'error');
  assert.deepEqual(worker.navigations, [], 'a lazy import that failed mid-session reloaded the tab and threw away the user\'s document');
});

test('4. an offline load is served WHOLE from one complete generation, and never from the network', async () => {
  let online = true;
  const routes = { '/': 'html A', [APP]: 'app A', [IMPORT]: 'import A' };
  const net = network(routes);
  const worker = loadWorker((req) => (online ? net(req) : Promise.reject(new TypeError('offline'))));
  const a = await onlineLoad(worker, 'tab-a', '/', [APP, IMPORT]);
  worker.close('tab-a');

  online = false;
  worker.open('tab-off', '/?utm_source=pwa');
  const nav = await dispatch(worker, navigate('/?utm_source=pwa'), { resultingClientId: 'tab-off' });
  assert.equal(await text(nav), 'html A', 'the offline launch did not open the complete generation');

  // The radio wakes up while the page is still importing, and deploy B is live.
  online = true;
  routes[IMPORT] = 'import B';
  const imp = await dispatch(worker, moduleReq(IMPORT), { clientId: 'tab-off' });
  assert.equal(await text(imp), 'import A',
    'a page whose shell came from generation A was handed a module from the network — deploy B beside deploy A, '
    + 'the cold-launch skew of Sentry JAVASCRIPT-10/13 in module form');
  assert.ok(a.gen);
});

test('5. a generation that never booted is never served — offline opens the last one that did', async () => {
  let routes = { '/': 'html A', [APP]: 'app A', [IMPORT]: 'import A' };
  let online = true;
  const worker = loadWorker((req) => (online ? network(routes)(req) : Promise.reject(new TypeError('offline'))));
  await onlineLoad(worker, 'tab-a', '/', [APP, IMPORT]);
  worker.close('tab-a');

  // Deploy B: every module arrives except import.js, so the page never boots.
  routes = { '/': 'html B', [APP]: 'app B', [IMPORT]: null };
  const b = await onlineLoad(worker, 'tab-b', '/', [APP, IMPORT], { boot: false });
  assert.equal(await worker.read(APP, b.gen), 'app B', 'VACUITY: the broken load wrote nothing, so this test proves nothing');
  assert.equal(await isComplete(worker, b.gen), false);
  worker.close('tab-b');

  online = false;
  worker.open('tab-off', '/');
  const nav = await dispatch(worker, navigate('/'), { resultingClientId: 'tab-off' });
  const app = await dispatch(worker, moduleReq(APP), { clientId: 'tab-off' });
  const imp = await dispatch(worker, moduleReq(IMPORT), { clientId: 'tab-off' });
  assert.deepEqual([await text(nav), await text(app), await text(imp)], ['html A', 'app A', 'import A'],
    'offline served something other than deploy A whole — a load that never booted leaked into the offline copy');
});

test('6. only the page that made a generation can complete it, and only with the boot message', async () => {
  const worker = loadWorker(network({ '/': 'html', [APP]: 'app' }));
  const { gen } = await onlineLoad(worker, 'tab', '/', [APP], { boot: false });
  await message(worker, { type: 'something-else' }, 'tab');
  await message(worker, { type: 'pdflokal:booted' }, 'a-stranger');
  assert.equal(await isComplete(worker, gen), false, 'a generation became servable without its own page vouching for it');
  await message(worker, { type: 'pdflokal:booted' }, 'tab');
  assert.equal(await isComplete(worker, gen), true, 'VACUITY: the real boot message did not complete the generation');
});

test('7. a shell from the install-day precache gets NO modules — it is not a generation', async () => {
  const worker = loadWorker(async () => { throw new TypeError('offline'); }, { online: false });
  worker.seed('/', 'install-day shell');
  worker.seed(IMPORT, 'some module from some visit');
  worker.open('tab', '/');
  const nav = await dispatch(worker, navigate('/'), { resultingClientId: 'tab' });
  assert.equal(await text(nav), 'install-day shell');
  const imp = await dispatch(worker, moduleReq(IMPORT), { clientId: 'tab' });
  assert.equal(imp.type, 'error', 'an install-day shell was paired with a module cached on some other visit');
});

test('8. activation evicts every foreign cache and keeps this worker\'s generations — the offline copy survives a reinstall', async () => {
  const worker = loadWorker(network({ '/': 'html', [APP]: 'app' }));
  const { gen } = await onlineLoad(worker, 'tab', '/', [APP]);
  worker.seed('/x', 'old', 'pdflokal-shell-v7');
  worker.seed('/x', 'old gen', 'pdflokal-gen-v7-abc');
  await activate(worker);
  const names = [...worker.named.keys()].sort();
  assert.deepEqual(names, [CACHE, gen].sort(), `after activation the caches are ${names.join(', ')}`);
});

test('9. pruning keeps the two newest complete generations and the newest per language home, and drops dead loads', async () => {
  let n = 0;
  const worker = loadWorker((req) => network({ '/': `html ${n}`, '/en': `en ${n}`, '/kompres-pdf': `k ${n}`, [APP]: `app ${n}` })(req));
  const gens = [];
  const visit = async (url, boot = true) => {
    n += 1;
    const id = `tab-${n}`;
    const { gen } = await onlineLoad(worker, id, url, [APP], { boot });
    worker.close(id);
    gens.push(gen);
    // Distinct commit times: the marker's clock is Date.now().
    await new Promise((r) => setTimeout(r, 3));
    return gen;
  };
  const en = await visit('/en');
  const home = await visit('/');
  const dead = await visit('/kompres-pdf', false);
  const k1 = await visit('/kompres-pdf');
  const k2 = await visit('/kompres-pdf');
  const left = worker.gens().sort();
  assert.deepEqual(left, [en, home, k1, k2].sort(),
    `kept ${left.length} generations; expected the newest two (${k1}, ${k2}), the newest with "/" (${home}) and with "/en" (${en}), and not the dead load ${dead}`);
});
