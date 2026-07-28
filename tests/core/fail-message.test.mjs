/*
 * "Try again" must only be said when trying again can work.
 *
 * On 2026-07-28 a user pressed Unduh 41 times against a document that could
 * never export, because every failure toasted "Coba sekali lagi ya". Advice
 * that cannot work is worse than none: it converts our failure into their
 * wasted effort, and it kept them there for 82 minutes.
 *
 * Copy here is PLACEHOLDER (Fauzan writes client-facing words). These tests
 * assert the RULE, not his sentences, so they survive him rewriting them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failMessage, RETRYABLE } from '../../js/v2/download-sheet.js';
import { SCHEMA } from '../../js/core/telemetry-schema.js';

// The defect is advice to REPEAT THE FAILED ACTION. "Cek teks yang kamu tulis"
// also starts with an imperative, but it sends them somewhere that can actually
// change the outcome, so it must NOT trip this. Matching the bare word "coba"
// did trip it, and that was the test being blunter than the rule.
const RETRY_RE = /(coba|cobalah)\s+(sekali\s+)?lagi|sekali lagi|ulangi|refresh|muat ulang/i;

test('1. deterministic failures NEVER suggest a retry', () => {
  for (const reason of ['encrypted', 'corrupt', 'unsupported']) {
    const msg = failMessage(reason);
    assert.equal(RETRY_RE.test(msg), false, `"${msg}" invites a retry that cannot succeed (${reason})`);
    assert.ok(msg.length > 0, 'a failure must still say something');
  }
});

test('2. genuinely transient failures DO', () => {
  for (const reason of RETRYABLE) {
    assert.match(failMessage(reason), RETRY_RE, `${reason} should offer a retry`);
  }
});

test('3. every reason in the schema gets a message, and the split is exhaustive', () => {
  // A reason nobody wrote a message for would silently fall to the default. If
  // that default said "try again", a new deterministic failure would inherit
  // the exact advice this file exists to remove.
  const reasons = SCHEMA.failure.reason;
  assert.ok(reasons.length >= 5, 'schema enum looks empty - this test would be vacuous');
  for (const r of reasons) {
    const msg = failMessage(r);
    assert.ok(msg && msg.length > 0, `no message for reason "${r}"`);
    if (!RETRYABLE.has(r)) {
      assert.equal(RETRY_RE.test(msg), false, `non-retryable "${r}" inherited retry advice: "${msg}"`);
    }
  }
});

test('4. an UNKNOWN-to-us reason does not inherit retry advice either', () => {
  assert.equal(RETRY_RE.test(failMessage('something-new')), false);
});
