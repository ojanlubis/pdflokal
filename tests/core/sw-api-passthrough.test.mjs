/*
 * THE SERVICE WORKER NEVER ANSWERS /api/ FROM CACHE.
 * ============================================================================
 * /api/rev exists so a page load can pin the build it is running (api/rev.js:
 * "a browser cache would happily outlive the deployment and report a stale
 * SHA"). sw.js's catch-all stale-while-revalidate branch used to cache every
 * same-origin GET except /api/visitors, so on the first load after a deploy the
 * worker served LAST visit's SHA and the whole session's telemetry and 👎
 * reports were attributed to the previous build. `cache: 'no-store'` on the
 * page's fetch does not reach `caches.match` inside the worker.
 *
 * The property is "API GETs pass through untouched": respondWith is never
 * called, so the browser goes to the network and an offline fetch fails
 * honestly (telemetry then reports 'dev', never a guess).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadWorker, dispatch, basic, ORIGIN, CACHE } from './sw-harness.mjs';

const get = (p) => ({ url: ORIGIN + p, method: 'GET', mode: 'cors' });

test('1. a cached /api/rev from a previous deploy is never served', async () => {
  const w = loadWorker(async () => basic(JSON.stringify({ rev: 'bbbbbbb' })));
  w.seed('/api/rev', JSON.stringify({ rev: 'aaaaaaa' }));
  // Known-positive: the seed is really in the cache the SWR branch reads.
  assert.match(await w.read('/api/rev', CACHE), /aaaaaaa/, 'the seed did not land, so a pass below would be vacuous');
  const res = await dispatch(w, get('/api/rev'));
  assert.equal(res, null,
    `the worker answered /api/rev itself (${res && await res.text()}). A cached SHA outlives the deploy it names.`);
});

test('2. every /api/ GET passes through — votes and visitors included', async () => {
  const w = loadWorker(async () => basic('{}'));
  for (const p of ['/api/votes', '/api/visitors', '/api/rev']) {
    assert.equal(await dispatch(w, get(p)), null, `the worker intercepted ${p}`);
  }
  assert.equal(await w.read('/api/votes', CACHE), null, 'an /api/ response was written to the shell cache');
});

test('3. known-positive: an ordinary static asset is still served stale-while-revalidate', async () => {
  const w = loadWorker(async () => basic('fresh'));
  w.seed('/images/logo.svg', 'cached');
  const res = await dispatch(w, get('/images/logo.svg'));
  assert.ok(res, 'the SWR branch no longer responds at all, so tests 1-2 would pass for the wrong reason');
  assert.equal(await res.text(), 'cached');
});
