/*
 * EKSTRAK MUST NOT RUN TWICE AT ONCE.
 * ============================================================================
 * onExtract awaits a lazy pdf-lib load plus a full export before it downloads.
 * page-manager calls it on every tap with no in-flight guard, so a user who sees
 * nothing happen (the toast used to paint under the sheet) taps again and gets
 * the same file twice. singleFlight drops a call made while the previous one is
 * still running, and forgets the flight when it settles, throw or not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { singleFlight } = await import('../../js/v2/single-flight.js');

test('a second call while the first is running is dropped', async () => {
  let runs = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const fn = singleFlight(async () => { runs++; await gate; });
  const first = fn();
  const second = fn();
  assert.equal(runs, 1);
  release();
  await first; await second;
  assert.equal(runs, 1);
});

test('after it settles the next call runs again', async () => {
  let runs = 0;
  const fn = singleFlight(async () => { runs++; });
  await fn(); await fn();
  assert.equal(runs, 2);
});

test('a throwing run does not wedge the guard', async () => {
  let runs = 0;
  const fn = singleFlight(async () => { runs++; if (runs === 1) throw new Error('boom'); });
  await assert.rejects(fn(), /boom/);
  await fn();
  assert.equal(runs, 2);
});

test('arguments reach the wrapped function', async () => {
  let seen;
  await singleFlight(async (a) => { seen = a; })(['p1']);
  assert.deepEqual(seen, ['p1']);
});

test('app.js wraps the Halaman onExtract in singleFlight', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js/v2/app.js'), 'utf8');
  assert.match(src, /onExtract: singleFlight\(async \(pages\) => \{/);
});

// ---- EXCLUDE 4: the rail event is "the tap", so it fires on EVERY tap ----------
test('onCall fires on every call, including one the guard drops', async () => {
  let taps = 0; let runs = 0; let release;
  const gate = new Promise((r) => { release = r; });
  const fn = singleFlight(async () => { runs++; await gate; }, { onCall: () => { taps++; } });
  const first = fn(); const second = fn();
  assert.equal(taps, 2, 'both taps are counted');
  assert.equal(runs, 1, 'only one export runs');
  release(); await first; await second;
});

test('onCall receives the arguments and a throwing onCall never blocks the run', async () => {
  let seen; let runs = 0;
  const fn = singleFlight(async () => { runs++; }, { onCall: (a) => { seen = a; throw new Error('tel'); } });
  await fn(['p1']);
  assert.deepEqual(seen, ['p1']);
  assert.equal(runs, 1);
});

test('app.js: tool_use/halaman/extract is the guard\'s onCall, not inside the guarded body', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js/v2/app.js'), 'utf8');
  const start = src.indexOf('onExtract: singleFlight(');
  const end = src.indexOf('\n  toast,\n});', start);
  const block = src.slice(start, end);
  assert.match(block, /onCall:\s*\(\)\s*=>\s*tel\('tool_use', \{ tool: 'halaman', action: 'extract' \}\)/);
  assert.equal(block.match(/action: 'extract'/g).length, 1, 'exactly one extract tap event');
  const body = block.slice(0, block.indexOf('onCall:'));
  assert.doesNotMatch(body, /action: 'extract'/, 'must not sit inside the guarded body');
});
