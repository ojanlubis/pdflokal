/*
 * LAZY OWN MODULES vs THE SERVICE WORKER'S GENERATION.
 * ============================================================================
 * sw.js serves an offline page load from ONE complete generation: the set of
 * /js/ modules that load fetched from the network (sw.js, GENERATIONS). A module
 * the page only `import()`s on a tap (Kompres, Unduh as JPG) is not fetched
 * during load, so it is in no generation: offline, and after a connection drop
 * mid-session, the worker answers it with Response.error() and the tap fails
 * while the app says "semuanya jalan di HP-mu" (found 2026-10-11, hunt r1 rank 10).
 *
 * The rule, one home: every own module the editor can ask for is in the STATIC
 * import graph of js/v2/app.js. This file pins it twice: against the real
 * source (no `import('./own-file.js')` points outside the static graph) and
 * against the real worker (a graph derived from that same source, loaded online
 * once, is enough to run Kompres and JPG offline).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadWorker, dispatch, message, navigate, moduleReq, network, text,
} from './sw-harness.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = '/js/v2/app.js';
const read = (url) => fs.readFileSync(path.join(ROOT, url), 'utf8');

// Block and line comments are stripped first: several comments in this repo
// quote an `import ... from` line, and a quote is not an edge.
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const resolve = (from, spec) => path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
const STATIC = /^\s*(?:import|export)\s[^'";]*?from\s*['"](\.[^'"]+)['"]|^\s*import\s*['"](\.[^'"]+)['"]/gm;
const DYNAMIC = /\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g;

// The static module graph reachable from the entry, as the browser links it.
function staticGraph(entry) {
  const seen = new Set();
  const walk = (url) => {
    if (seen.has(url)) return;
    seen.add(url);
    for (const m of code(read(url)).matchAll(STATIC)) walk(resolve(url, m[1] || m[2]));
  };
  walk(entry);
  return [...seen];
}

const graph = staticGraph(ENTRY);

test('the graph walk is not vacuous: it finds the entry, its known static imports, and the dynamic calls', () => {
  assert.ok(graph.includes(ENTRY));
  assert.ok(graph.includes('/js/v2/download-sheet.js'), 'download-sheet.js is not in the static graph — the walker is broken');
  assert.ok(graph.includes('/js/v2/pdf-builder.js'), 'pdf-builder.js is statically imported by download-sheet.js');
  const dynamic = graph.flatMap((u) => [...code(read(u)).matchAll(DYNAMIC)]);
  assert.ok(dynamic.length > 0, 'no dynamic import() found anywhere — the DYNAMIC pattern is broken');
});

test('1. every own module the editor imports lazily is also in the static graph, so a generation holds it', () => {
  const stranded = [];
  for (const url of graph) {
    for (const m of code(read(url)).matchAll(DYNAMIC)) {
      const target = resolve(url, m[1]);
      if (!graph.includes(target)) stranded.push(`${url} import('${m[1]}')`);
    }
  }
  assert.deepEqual(stranded, [],
    'these modules are fetched only on a tap, so no service-worker generation contains them and they fail offline '
    + '(Kompres, Unduh as JPG). Import them statically instead:\n  ' + stranded.join('\n  '));
});

test('2. Kompres and JPG modules are in the load\'s generation, so an offline relaunch can run them', async () => {
  const LAZY = ['/js/core/compress.js', '/js/core/export-images.js'];
  // Each lazy module is named by the file that imports it, so renaming one
  // cannot turn this test into a check of nothing.
  for (const m of LAZY) assert.ok(fs.existsSync(path.join(ROOT, m)), `${m} no longer exists — update this test`);

  let online = true;
  const routes = { '/': 'html A' };
  for (const u of [...graph, ...LAZY]) routes[u] = `module ${u}`;
  const net = network(routes);
  const worker = loadWorker((req) => (online ? net(req) : Promise.reject(new TypeError('offline'))));

  // An online page load fetches its STATIC graph (only), then boots.
  worker.open('tab-a', '/');
  await dispatch(worker, navigate('/'), { resultingClientId: 'tab-a' });
  for (const u of graph) await dispatch(worker, moduleReq(u), { clientId: 'tab-a' });
  await message(worker, { type: 'pdflokal:booted' }, 'tab-a');

  // A tab that is already open links its static graph once, at load, and the
  // browser never asks the network for it again: a connection drop later cannot
  // reach a module that load fetched. That is the whole fix for "after a drop",
  // so what must hold is that the load's own generation CONTAINS the modules.
  const gen = worker.gens()[0];
  assert.ok(gen, 'the online load wrote no generation');
  for (const m of LAZY) {
    assert.equal(await worker.read(m, gen), `module ${m}`, `${m} is not in the generation the online load wrote`);
  }
  online = false;
  worker.close('tab-a');

  // Cold launch with no network at all, from the home screen.
  worker.open('tab-off', '/?utm_source=pwa');
  const nav = await dispatch(worker, navigate('/?utm_source=pwa'), { resultingClientId: 'tab-off' });
  assert.equal(await text(nav), 'html A');
  for (const m of LAZY) {
    const r = await dispatch(worker, moduleReq(m), { clientId: 'tab-off' });
    assert.notEqual(r.type, 'error', `${m} failed on an offline relaunch`);
    assert.equal(await text(r), `module ${m}`);
  }
});
