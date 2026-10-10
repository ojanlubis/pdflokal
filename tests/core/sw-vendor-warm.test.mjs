/*
 * THE EXPORT PATH'S VENDOR FILES ARE ON THE DEVICE BEFORE THE FIRST UNDUH.
 * ============================================================================
 * pdf-lib, fontkit and fflate are fetched only when someone taps Unduh (or
 * Unduh as JPG): js/core/vendor.js loads them at intent. /js/vendor/ is
 * stale-while-revalidate (sw.js), which serves only what an earlier use already
 * cached. So a first-time user whose signal drops after opening a PDF was told
 * "semuanya jalan di HP-mu" and then could not download until the network came
 * back (found 2026-10-11, hunt r1 rank 20).
 *
 * The worker now fetches them itself once a page has booted (or been adopted),
 * after the page is usable, so nothing waits on them. The list lives in sw.js
 * (PRECACHE_VENDOR); this file derives the expected files from vendor.js, so a
 * new export-path vendor file that is not added to the list turns it red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadWorker, dispatch, message, navigate, moduleReq, network, text, COMPLETE,
} from './sw-harness.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const APP = '/js/v2/app.js';

// What ensurePdfLib() and ensureFflate() will ask the network for, read off the
// real loader rather than retyped here.
function exportPathVendor() {
  const src = fs.readFileSync(path.join(ROOT, 'js/core/vendor.js'), 'utf8');
  const out = [];
  for (const fn of ['ensurePdfLib', 'ensureFflate']) {
    const start = src.indexOf(`export async function ${fn}(`);
    assert.ok(start >= 0, `vendor.js no longer defines ${fn}`);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    out.push(...[...body.matchAll(/loadScript\('(\/js\/vendor\/[^']+)'\)/g)].map((m) => m[1]));
  }
  return out;
}
const VENDOR = exportPathVendor();

test('the vendor list is not vacuous: pdf-lib, fontkit and fflate', () => {
  assert.deepEqual([...VENDOR].sort(), [
    '/js/vendor/fflate.min.js', '/js/vendor/fontkit.umd.min.js', '/js/vendor/pdf-lib.min.js',
  ]);
});

function setup({ failVendor = false } = {}) {
  let online = true;
  const routes = { '/': 'html A', [APP]: 'app A', '/api/rev': 'sha-A' };
  for (const v of VENDOR) routes[v] = failVendor ? null : `vendor ${v}`;
  const net = network(routes);
  let fetched = [];
  const worker = loadWorker((req) => {
    fetched.push(new URL(typeof req === 'string' ? req : req.url, 'https://www.pdflokal.id').pathname);
    return online ? net(req) : Promise.reject(new TypeError('offline'));
  });
  return { worker, offline: () => { online = false; }, fetched: () => fetched, resetFetched: () => { fetched = []; } };
}

async function offlineVendor(worker, id) {
  const out = {};
  for (const v of VENDOR) {
    const r = await dispatch(worker, moduleReq(v), { clientId: id });
    out[v] = r && r.type !== 'error' ? await text(r) : null;
  }
  return out;
}

test('1. after a page boots online, Unduh\'s vendor files are served with the network gone', async () => {
  const s = setup();
  s.worker.open('tab', '/');
  await dispatch(s.worker, navigate('/'), { resultingClientId: 'tab' });
  await dispatch(s.worker, moduleReq(APP), { clientId: 'tab' });
  await message(s.worker, { type: 'pdflokal:booted' }, 'tab');
  s.offline();
  const got = await offlineVendor(s.worker, 'tab');
  for (const v of VENDOR) assert.equal(got[v], `vendor ${v}`, `${v} was never fetched: Unduh in a first session fails once the signal drops`);
});

test('2. the first visit (adopted, no controller at load) warms them too', async () => {
  const s = setup();
  s.worker.open('first', '/');
  await message(s.worker, { type: 'pdflokal:adopt', urls: ['https://www.pdflokal.id' + APP] }, 'first');
  s.offline();
  const got = await offlineVendor(s.worker, 'first');
  for (const v of VENDOR) assert.equal(got[v], `vendor ${v}`, `${v} not warmed after adoption`);
});

test('3. a file already on the device is not downloaded again', async () => {
  const s = setup();
  s.worker.open('tab', '/');
  await dispatch(s.worker, navigate('/'), { resultingClientId: 'tab' });
  await message(s.worker, { type: 'pdflokal:booted' }, 'tab');
  assert.ok(s.fetched().some((u) => VENDOR.includes(u)), 'vacuity: the first boot fetched no vendor file at all');
  s.resetFetched();
  await message(s.worker, { type: 'pdflokal:booted' }, 'tab');
  assert.deepEqual(s.fetched().filter((u) => VENDOR.includes(u)), [], 'a second boot re-downloaded ~1 MB of vendor code');
});

test('4. a vendor file that will not download never breaks the commit', async () => {
  const s = setup({ failVendor: true });
  s.worker.open('tab', '/');
  await dispatch(s.worker, navigate('/'), { resultingClientId: 'tab' });
  await message(s.worker, { type: 'pdflokal:booted' }, 'tab');
  assert.ok(s.fetched().some((u) => VENDOR.includes(u)), 'vacuity: the warm-up never tried the network, so it cannot have failed');
  const gen = s.worker.gens()[0];
  assert.ok(gen && await s.worker.read(COMPLETE, gen), 'the generation was not committed because the warm-up failed');
});
