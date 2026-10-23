/*
 * THE FIRST VISIT BECOMES AN OFFLINE GENERATION TOO.
 * ============================================================================
 * A first visit has no controller: sw.js never sees its navigation or its
 * modules, so no generation exists, and an install made on that visit launched
 * offline into the install-day shell with every module refused (a dead editor
 * with live-looking buttons). Once the worker takes control, js/v2/app.js posts
 * 'pdflokal:adopt' with the module URLs it ran; the worker refetches them and
 * the page into one generation, committed only if /api/rev did not move.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWorker, dispatch, message, navigate, moduleReq, network, text, ORIGIN, COMPLETE } from './sw-harness.mjs';

const APP = '/js/v2/app.js';
const IMPORT = '/js/core/import.js';
const VENDOR = '/js/vendor/pdf.min.js';

function firstVisit(routes) {
  let online = true;
  const net = network(routes);
  const worker = loadWorker((req) => (online ? net(req) : Promise.reject(new TypeError('offline'))));
  worker.open('first', '/?buat=gabung'); // a tab the worker never saw navigate
  return { worker, offline: () => { online = false; } };
}
const adoptMsg = (urls) => ({ type: 'pdflokal:adopt', urls });

test('1. adopted first visit: an offline launch opens the shell AND its modules', async () => {
  const routes = { '/': 'html A', [APP]: 'app A', [IMPORT]: 'import A', '/api/rev': '{"rev":"aaaaaaa"}' };
  const { worker, offline } = firstVisit(routes);
  // Known-positive for the bug: before adoption there is nothing to launch into.
  assert.equal(worker.gens().length, 0);
  await message(worker, adoptMsg([ORIGIN + APP, ORIGIN + IMPORT, ORIGIN + VENDOR, 'https://evil.example/x.js']), 'first');
  const [gen] = worker.gens();
  assert.ok(gen, 'no generation was adopted');
  assert.ok(await worker.read(COMPLETE, gen), 'the adopted generation is not complete');
  assert.equal(await worker.read(VENDOR, gen), null, 'vendor is not part of a generation');
  assert.equal(await worker.read('https://evil.example/x.js', gen), null);

  worker.close('first');
  offline();
  worker.open('pwa', '/?utm_source=pwa');
  const nav = await dispatch(worker, navigate('/?utm_source=pwa'), { resultingClientId: 'pwa' });
  assert.equal(await text(nav), 'html A', 'the offline launch did not find the adopted home');
  const app = await dispatch(worker, moduleReq(APP), { clientId: 'pwa' });
  assert.equal(await text(app), 'app A', 'the offline launch got a shell with no modules: the dead editor');
});

test('2. a deploy landing mid-pass keeps NOTHING (two deploys in one generation is the skew)', async () => {
  let n = 0;
  const routes = { '/': 'html A', [APP]: 'app A', [IMPORT]: 'import A' };
  const net = network(routes);
  const worker = loadWorker((req) => {
    const p = new URL(typeof req === 'string' ? req : req.url, ORIGIN).pathname;
    if (p === '/api/rev') { n += 1; return Promise.resolve(new Response(n === 1 ? 'A' : 'B', { status: 200 })); }
    return net(req);
  });
  worker.open('first', '/');
  await message(worker, adoptMsg([ORIGIN + APP, ORIGIN + IMPORT]), 'first');
  assert.equal(n, 2, 'known-positive: the pass must read /api/rev before and after');
  assert.equal(worker.gens().length, 0, 'a generation spanning two deploys was kept');
});

test('3. never for a tab the worker saw navigate, and never once a complete generation exists', async () => {
  const routes = { '/': 'html A', [APP]: 'app A', '/api/rev': 'A' };
  const worker = loadWorker(network(routes));
  worker.open('seen', '/');
  await dispatch(worker, navigate('/'), { resultingClientId: 'seen' });
  await dispatch(worker, moduleReq(APP), { clientId: 'seen' });
  await message(worker, { type: 'pdflokal:booted' }, 'seen');
  const before = worker.gens();
  assert.equal(before.length, 1, 'known-positive: the normal path committed its own generation');
  await message(worker, adoptMsg([ORIGIN + APP]), 'seen');
  worker.open('other', '/');
  await message(worker, adoptMsg([ORIGIN + APP]), 'other');
  assert.deepEqual(worker.gens(), before, 'adoption added a generation beside a real one');
});
