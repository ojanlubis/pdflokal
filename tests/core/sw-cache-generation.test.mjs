/*
 * THE SERVICE WORKER'S CACHE GENERATION IS A LIST, NOT A NUMBER.
 * ============================================================================
 * `caches.delete()` of the non-matching names happens in sw.js's activate
 * handler, so the ONLY thing that evicts a poisoned cache from a returning
 * visitor's device is the CACHE constant no longer naming it.
 *
 * WHY A NAMED LIST OF POISONED GENERATIONS rather than `version >= 3`:
 * a floor number says "newer than", which is a claim about ordering. What we
 * actually know is a fact about specific shipped generations — `v1` carried the
 * 2026-07-28 mixed module graph (Sentry JAVASCRIPT-P) and `v2` carried the
 * 2026-08-18 → 08-30 one (JAVASCRIPT-V/J/Y/Z: a stale HTML without
 * `id="fm-pages"` served beside a fresh app.js, and a stale
 * telemetry-schema.js served beside a sibling importing `ocrLinesBucket`).
 * Naming them means a future revert to either name goes red for the reason it
 * is wrong, not for being a smaller integer.
 *
 * ⚠️ THIS TEST PROVES EVICTION IS POSSIBLE, NOT THAT SKEW IS CLOSED. Bumping
 * the name cures the users stranded on a poisoned generation once. It does
 * nothing about the mechanism that poisons the NEXT one — sw.js's per-file
 * offline fallback, which can still hand an offline visitor one stale module
 * beside fresh siblings. See the boot guard (index.html) for the recovery, and
 * the residual noted with it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SW = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');

// Generations that were live while a documented cross-deploy skew incident was
// killing the module graph. A device still holding one of these has the broken
// set on it; only a different CACHE name purges it.
const POISONED = ['pdflokal-shell-v1', 'pdflokal-shell-v2'];

function cacheName() {
  const m = /^const CACHE = '([^']+)';$/m.exec(SW);
  assert.ok(m, "sw.js no longer declares `const CACHE = '…';` at the top level — this test cannot see the cache name any more, so every assertion below would pass vacuously");
  return m[1];
}

test('1. the cache name is not one of the generations a skew incident shipped on', () => {
  const name = cacheName();
  assert.equal(
    POISONED.includes(name), false,
    `sw.js's CACHE is back to "${name}", a generation that was live during a cross-deploy asset\n`
    + 'skew incident. Devices still holding it keep the mixed set: sw.js only evicts caches whose\n'
    + 'key differs from CACHE, so reusing the name re-adopts every poisoned entry on it.\n'
    + `  poisoned: ${POISONED.join(', ')}`,
  );
});

test('2. the activate handler still purges every non-matching cache — the bump only works because of this', () => {
  assert.match(
    SW, /caches\.keys\(\)[\s\S]{0,200}k !== CACHE[\s\S]{0,80}caches\.delete\(k\)/,
    'sw.js no longer deletes the caches whose key differs from CACHE on activate. Without that, '
    + 'bumping the name adds a cache instead of replacing one, and the stale entries survive '
    + 'forever — which makes test 1 above a ritual.',
  );
});

test('3. PRECACHE holds no /js/ entry — a precached module would be immune to the network-first path', () => {
  const m = /const PRECACHE = \[([\s\S]*?)\];/.exec(SW);
  assert.ok(m, 'sw.js no longer declares PRECACHE — the scan below cannot see it');
  const entries = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(entries.length >= 3, `PRECACHE parsed to ${entries.length} entries — the matcher is broken`);
  const js = entries.filter((e) => e.startsWith('/js/'));
  assert.deepEqual(
    js, [],
    `PRECACHE installs ${js.join(', ')} at install time. install runs ONCE per generation, so a `
    + 'module pinned there never takes the network-first path in the fetch handler and stays at '
    + "that generation's bytes while its siblings update — the skew, manufactured on purpose.",
  );
});
