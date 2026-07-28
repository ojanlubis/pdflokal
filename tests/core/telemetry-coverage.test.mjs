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
// CLOSED for file_failed (2026-07-28): js/v2/app.js now emits
// tel('failure', {stage:'import', reason}) beside the GA4 call, classifying the
// reason from the error's NAME only — a name is a fixed identifier, a message
// can quote the document back to us.
//
// STILL OPEN for client_error, and deliberately NOT forced: a global uncaught
// error is not an import, commit, export, compress or render, and jamming it
// into one of those to make this test green would put a wrong value on the rail
// to satisfy a test. It needs a schema decision (a new stage, or its own
// event). Tracked with the seat, not papered over here.
test('COVERAGE: file-open failures reach the first-party rail, not just GA4', () => {
  const emitted = names('tel');
  assert.ok(emitted.has('failure'), 'the failure event is not emitted anywhere');
  // The import stage specifically — the file-open path.
  const app = fs.readFileSync(path.join(JS, 'v2', 'app.js'), 'utf8');
  assert.match(
    strip(app), /tel\('failure',\s*\{\s*stage:\s*'import'/,
    'js/v2/app.js no longer reports a failed file open to the first-party rail',
  );
});

// Position-independent on purpose. The first draft of this test sliced a window
// before `indexOf("tel('failure', { stage: 'import'")` — and there are TWO such
// call sites in app.js (the protected-PDF warning and the file-open failure),
// so it measured the wrong one and failed for a reason that had nothing to do
// with the code. A whole-file claim cannot pick the wrong occurrence.
// The live product's own error channel. This is the test that would have caught
// the 2026-07-28 mistake: js/lib/errors.js LOOKS like global capture, but it is
// imported only by js/init.js, which is loaded only by alat-gambar.html — the
// OLD wing. Editor v2 had no global capture at all except Sentry, so a runtime
// error on pdflokal.id reached the first-party rail nowhere.
//
// Asserting on the file that the LIVE page loads, rather than on "some file
// installs a handler", is the whole point — the earlier finding was true about
// a file and false about the product.
test('COVERAGE: the LIVE product captures runtime errors onto the first-party rail', () => {
  const app = strip(fs.readFileSync(path.join(JS, 'v2', 'app.js'), 'utf8'));
  assert.match(app, /addEventListener\('error'/, 'v2 installs no window error handler');
  assert.match(app, /addEventListener\('unhandledrejection'/, 'v2 installs no rejection handler');
  assert.match(app, /tel\('failure',\s*\{\s*stage:\s*'runtime'/, 'v2 does not report runtime failures to the rail');
  // index.html is the live product; it must load the file that does this.
  const index = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(index, /js\/v2\/app\.js/, 'index.html no longer loads the file carrying the capture');
});

// The old wing's channel must stay free of user-controlled text. Kept as a
// tripwire rather than deleted with the wing, because it is live until
// demolition and a well-meaning "add the message back for debugging" is exactly
// how it would return.
test('COVERAGE: the legacy GA4 error path sends no free text', () => {
  const errs = strip(fs.readFileSync(path.join(JS, 'lib', 'errors.js'), 'utf8'));
  for (const banned of ['message', 'stack', 'filename', 'lineno', 'colno']) {
    assert.equal(
      new RegExp(`\\b${banned}\\b`).test(errs), false,
      `js/lib/errors.js references "${banned}" again — an error's own text is free text we do not `
      + 'control (String(reason) stringifies whatever a rejection holds). The ruling was STOP, not sanitise.',
    );
  }
});

// ⚠️ THIS TEST CHANGED ITS SHAPE ON 2026-07-28, AND THE REASON MATTERS.
// It used to assert that `err.message` appears NOWHERE — a structural proxy for
// "a thrown message never reaches the rail": if you never read it, you cannot
// leak it. Cheap and strong, and it was too strong. pdf-lib throws a PLAIN
// `Error` for every failure it has — truncation, encryption, everything — so a
// name-only classifier can never distinguish ANY export failure. That is not
// hypothetical: on 2026-07-28 a user hit 41 consecutive export failures and all
// 41 recorded `unknown`, because there was nothing else they could record.
//
// So the invariant is now enforced where it actually lives — TRANSMISSION, not
// inspection — and it is still structural rather than a promise:
//   1. core/failure-reason.js may read err.message. It imports NOTHING, so it
//      has no rail to leak to; it can only return one of the schema's enum
//      values (proved against real pdf-lib errors in failure-reason.test.mjs).
//   2. Every OTHER file stays under the original ban.
test('COVERAGE: only the pure classifier may read err.message, and it cannot transmit', () => {
  const classifier = strip(fs.readFileSync(path.join(JS, 'core', 'failure-reason.js'), 'utf8'));
  assert.match(classifier, /err\?\.message/, 'the classifier no longer reads the message it exists to read');
  // The guarantee: a module with no imports cannot reach telemetry, the network,
  // or a toast. If this ever grows an import, the leak becomes possible again.
  assert.equal(
    /^\s*import\s/m.test(classifier), false,
    'core/failure-reason.js grew an import. It reads raw error text, so it must stay a PURE function '
    + 'with no way to send anything anywhere — that isolation IS the content-blindness guarantee.',
  );

  for (const rel of [['v2', 'app.js'], ['v2', 'download-sheet.js'], ['v2', 'telemetry.js']]) {
    const src = strip(fs.readFileSync(path.join(JS, ...rel), 'utf8'));
    assert.equal(
      /err\?\.message|err\.message/.test(src), false,
      `err.message appeared in js/${rel.join('/')} — a thrown message can quote the document back to us. `
      + 'Pass the error to failureReason() and send only the bucket it returns.',
    );
  }
});

// THE TEST THAT WOULD HAVE CAUGHT THE 2026-07-28 INCIDENT. `reason` was the
// LITERAL 'unknown' at the export call site, so 41 real failures reported a
// constant — the classifier was never asked. A hard-coded enum value in a
// failure report is indistinguishable from a real classification on the rail,
// which is what made it survive review and a full gate.
test('COVERAGE: no failure report hard-codes its reason', () => {
  for (const rel of [['v2', 'app.js'], ['v2', 'download-sheet.js']]) {
    const src = strip(fs.readFileSync(path.join(JS, ...rel), 'utf8'));
    const calls = src.match(/tel\('failure',\s*\{[^}]*\}/g) || [];
    assert.ok(calls.length > 0, `no failure reports found in js/${rel.join('/')} — the scan broke`);
    for (const call of calls) {
      const m = /reason:\s*([^}]*)/.exec(call);
      if (!m) continue;
      const expr = m[1].trim().replace(/,$/, '').trim();
      // Two acceptable shapes, and nothing else:
      //   failureReason(err)  — the classifier actually ran
      //   'encrypted'         — a fact the app read off the DOCUMENT at import,
      //                         which is stronger than anything derived from a
      //                         throw. Allowed alone or as the ternary's branch.
      const classified = /failureReason\s*\(/.test(expr);
      // A LITERAL IS ONLY OK WHEN THE CALL SITE DETERMINED IT ITSELF, rather
      // than failing to classify something it caught. Both entries here are
      // measurements, not guesses:
      //   'encrypted'   read off the DOCUMENT at import (core/import.js)
      //   'unsupported' computed from the TEXT at commit — we know exactly
      //                 which characters cannot encode, there is no error yet
      // Anything else must go through failureReason(err). Keep this list tiny;
      // every addition is a place the rail can start asserting without knowing.
      const DETERMINED = ["'encrypted'", "'unsupported'"];
      const documentFact = DETERMINED.includes(expr);
      assert.ok(
        classified || documentFact,
        `hard-coded failure reason in js/${rel.join('/')} → reason: ${expr.slice(0, 60)}\n`
        + 'A literal here is indistinguishable from a real classification once it is on the rail — '
        + 'that is exactly how 41 real export failures all reported "unknown" on 2026-07-28. '
        + 'Call failureReason(err).',
      );
    }
  }
});
