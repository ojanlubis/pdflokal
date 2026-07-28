/*
 * TELEMETRY SUITE — class D (failure coverage) + class E (rail-vs-GA4 parity).
 * ============================================================================
 * Both are static source scans, for the same reason class A is: a runtime test
 * can only prove the paths it happens to drive, and these are claims about what
 * the codebase does EVERYWHERE.
 *
 * CLASS D — every user-facing failure is visible on the first-party rail.
 * The rail's purpose under the auto-push policy is to answer "is it broken?".
 * It cannot, if a failure only ever reaches GA4 — GA4 is ad-blocked wholesale
 * for a large share of Indonesian users, and it is not queryable in the same
 * place as the rest of the rail.
 *
 * CLASS E — which events are first-party is a RULING, not an accident.
 * Fourteen events became GA4-only without anyone deciding. Pinning the list
 * converts drift into a decision: adding a GA4-only event now requires editing
 * this test, which is a place someone has to think.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const JS = path.join(ROOT, 'js');

function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'vendor') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (e.isFile() && e.name.endsWith('.js')) out.push(full);
  }
  return out;
}
// Same comment-stripping discipline as telemetry-liveness.test.mjs: this repo
// discusses track()/tel() in prose constantly, and a scanner that reads prose
// as code produces noise that gets the assertion deleted.
const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

function names(fn) {
  const found = new Set();
  for (const f of sourceFiles(JS)) {
    for (const m of strip(fs.readFileSync(f, 'utf8')).matchAll(new RegExp(`\\b${fn}\\(\\s*'([a-z_]+)'`, 'g'))) {
      found.add(m[1]);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// CLASS E — the pinned split. This test PASSES today: it does not claim the
// split is right, only that it is DELIBERATE. Changing it should require
// changing this list, which is the whole point.
// ---------------------------------------------------------------------------
const GA4_ONLY = [
  'client_error', 'download', 'editor_action', 'file_failed', 'file_loaded',
  'gabungkan_used', 'ganti_no_text_layer', 'intent_armed', 'pwa_card_open',
  'pwa_install', 'pwa_installed', 'tester_optin', 'tool_opened', 'vote_playstore',
];

test('PARITY: the GA4-only event list is exactly what we think it is', () => {
  const tracked = [...names('track')].sort();
  assert.deepEqual(
    tracked, [...GA4_ONLY].sort(),
    'the set of GA4-only events changed.\n'
    + 'If you ADDED one: decide whether it belongs on the first-party rail instead — GA4 is\n'
    + 'ad-blocked for a large share of our users and lives in a different query surface.\n'
    + 'If that was deliberate, add it here. This test exists so the choice is made, not drifted into.',
  );
});

test('PARITY: the scan is finding things — this assertion cannot pass vacuously', () => {
  assert.ok(names('track').size >= 10, `found only ${names('track').size} track() names — scanner broken?`);
  assert.ok(names('tel').size >= 10, `found only ${names('tel').size} tel() names — scanner broken?`);
});

// ---------------------------------------------------------------------------
// CLASS D — THE GAP. Expose-first: this documents what is not true today.
//
// `failure {stage, reason}` shipped 2026-07-28 and was reported — by me, to the
// seat — as closing the rail's failure blind spot. **It closed the EXPORT path
// only.** Two user-facing failures still reach GA4 and nothing else:
//
//   file_failed   — a user's file could not be opened at all. The single most
//                   important "is it broken?" signal we have, and it is
//                   invisible to the rail that the auto-push policy will lean
//                   on. `failure {stage:'import'}` already exists for it.
//   client_error  — an unhandled client error. Same argument.
//
// Until these emit `failure` too, "the telemetry catches everything" is false,
// and it is a PRECONDITION of the push policy — so this gap has a deadline that
// the others do not.
//
// `todo` so the gate stays a trustworthy signal while the gap stays executable.
// ---------------------------------------------------------------------------
test('GAP: every user-facing failure also reaches the first-party rail', { todo: 'exposed 2026-07-28, awaiting seat ruling — file_failed + client_error are GA4-only' }, () => {
  const railBlind = ['file_failed', 'client_error'].filter((e) => names('track').has(e));
  assert.deepEqual(
    railBlind, [],
    `these failures are reported to GA4 only and are invisible to the first-party rail: ${railBlind.join(', ')}`,
  );
});
