/*
 * THE BOOT GUARD — one inline snippet, thirteen pages, and it must not loop.
 * ============================================================================
 * A cross-deploy asset skew kills js/v2/app.js at MODULE TOP LEVEL: a stale
 * HTML without `id="fm-pages"` beside a fresh app.js, or a stale
 * telemetry-schema.js beside a sibling importing `ocrLinesBucket`. When that
 * happens there is no editor, no toolbar, and NO TELEMETRY — the rail cannot
 * report it, because the reporting module is in the dead graph. Nothing
 * recovers and nothing tells the user.
 *
 * The guard is an inline <head> script that, on a module-load-class error,
 * empties every cache, unregisters the service worker, and reloads ONCE.
 *
 * ⚠️ WHAT THIS FILE PROVES AND WHAT IT DOES NOT.
 *   PROVES — the guard's LOGIC, by running the actual snippet lifted out of
 *            index.html against a stubbed window and synthetic ErrorEvents.
 *            Heal-once, never offline, never after load, never on an unrelated
 *            error, and never at all if sessionStorage cannot be written.
 *   DOES NOT — that a browser dispatches a module LINK failure (a missing
 *            export) as a window `error` event at all. That is a browser
 *            behaviour claim and it belongs to tests/boot-guard-skew.spec.js
 *            (Playwright), which serves a deliberately mismatched set.
 *
 * The parity test COMPARES the thirteen copies rather than pinning the text,
 * so the snippet can grow (e.g. a failure beacon) without this file needing to
 * be rewritten — but it can never grow on the landing alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// The harness lifts the guard out of index.html and runs it against a stubbed
// window. Shared with boot-failure-beacon.test.mjs so the two files can never
// disagree about what the guard actually does.
import {
  ROOT, PAGES, MARKER, APP_SCRIPT, guardOf, runGuard, SKEW_MESSAGES,
} from './boot-guard-harness.mjs';

test('1. all 13 app-loading pages carry exactly one boot guard, byte-identical', () => {
  // VACUITY GUARD: an empty page list would make every loop below pass having
  // checked nothing.
  assert.equal(PAGES.length, 13, `expected 13 app-loading pages (landing + 12), got ${PAGES.length}`);

  for (const file of PAGES) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.match(html, APP_SCRIPT, `${file} does not load js/v2/app.js — the page list is wrong`);
    const hits = guardOf(file);
    assert.equal(hits.length, 1,
      `${file} carries ${hits.length} boot guards, expected exactly 1. `
      + (hits.length === 0
        ? 'Without it, a skewed asset set leaves this page with a dead editor, a dead toolbar and a '
          + 'dead telemetry rail, and nothing recovers. The guard lives in index.html\'s <head>; the 12 '
          + 'generated pages inherit it through `npm run seo` — run it.'
        : 'Two copies would each try to heal, and two heals is a reload loop.'));
  }

  const bodies = PAGES.map((f) => guardOf(f)[0]);
  assert.ok(bodies[0].length > 400, `the extracted guard is only ${bodies[0].length} chars — the extractor is matching the wrong script`);
  for (let i = 1; i < bodies.length; i++) {
    assert.equal(bodies[i], bodies[0], `${PAGES[i]}'s boot guard has drifted from index.html's. Run \`npm run seo\`.`);
  }
});

test('2. the guard is in the HEAD, before anything that could die', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const headEnd = html.indexOf('</head>');
  const guardAt = html.indexOf(MARKER);
  assert.ok(guardAt !== -1 && guardAt < headEnd,
    'the boot guard is no longer inside <head>. It has to install its error listener before the '
    + 'deferred module graph executes; below </head> it can still be early enough by accident, and '
    + '"early enough by accident" is not a mechanism.');
  assert.ok(guardAt < html.search(APP_SCRIPT),
    'the boot guard now appears after the module script it exists to catch');
});

test('3. every measured skew message heals: caches emptied, SW unregistered, ONE reload', async () => {
  for (const msg of SKEW_MESSAGES) {
    const g = runGuard();
    await g.error(msg);
    assert.equal(g.calls.reloads, 1, `no reload for: ${msg}`);
    assert.deepEqual(g.calls.cachesDeleted, ['pdflokal-shell-v2', 'pdflokal-shell-v3'], `caches not emptied for: ${msg}`);
    assert.equal(g.calls.unregisters, 1, `service worker not unregistered for: ${msg}`);
  }
});

test('4. it heals ONCE — a second skew error in the same session does not reload again', async () => {
  const g = runGuard();
  await g.error(SKEW_MESSAGES[0]);
  await g.error(SKEW_MESSAGES[1]);
  await g.error(SKEW_MESSAGES[0]);
  assert.equal(g.calls.reloads, 1,
    'the guard healed more than once in one session. A guard that can heal twice can heal forever, '
    + 'and a reload loop is strictly worse than a broken editor.');
});

test('5. it does NOT heal on an unrelated error — that would reload users through every other bug', async () => {
  const innocent = [
    'ResizeObserver loop completed with undelivered notifications.',
    'Failed to fetch',
    'undefined is not a function',
    "Cannot read properties of undefined (reading 'length')",
    'Script error.',
    '',
  ];
  for (const msg of innocent) {
    const g = runGuard();
    await g.error(msg);
    assert.equal(g.calls.reloads, 0, `healed on an unrelated error: ${JSON.stringify(msg)}`);
  }
});

test('6. OFFLINE never heals, and does not burn the one-shot either', async () => {
  const off = runGuard({ online: false });
  await off.error(SKEW_MESSAGES[0]);
  assert.equal(off.calls.reloads, 0,
    'the guard healed while offline. Emptying the cache offline replaces a dead editor with a '
    + 'browser error page — the stale cache is the only copy that user has.');
  assert.deepEqual(off.calls.cachesDeleted, [], 'the guard deleted caches while offline');

  // And the flag must be untouched, or the user who came back online would find
  // the one heal already spent on a decision that was never made.
  const on = runGuard();
  await on.error(SKEW_MESSAGES[0]);
  assert.equal(on.calls.reloads, 1, 'the online case regressed — the offline check is now unconditional');
});

test('7. a sessionStorage that throws fails CLOSED — no once-guarantee, no heal', async () => {
  const g = runGuard({ storage: 'throws' });
  await g.error(SKEW_MESSAGES[0]);
  assert.equal(g.calls.reloads, 0,
    'the guard healed with sessionStorage unavailable (blocked storage, some private modes). '
    + 'Without a place to record that it healed, "once" is unenforceable and the reload can loop.');
});

test('8. it DISARMS at window load — nothing after boot can trigger a heal', async () => {
  const g = runGuard();
  await g.load();
  await g.error(SKEW_MESSAGES[1]);
  assert.equal(g.calls.reloads, 0,
    'the guard still heals after the load event. The failures it exists for all happen while the '
    + 'module graph is executing, which is before load; staying armed afterwards means an ordinary '
    + 'runtime TypeError can wipe a user\'s cache and reload them mid-edit.');
});
