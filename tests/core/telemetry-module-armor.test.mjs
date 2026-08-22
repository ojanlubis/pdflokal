/*
 * TELEMETRY MUST NOT BE ABLE TO KILL THE EDITOR AT IMPORT TIME.
 * ============================================================================
 * LIVE BREAKAGE (Sentry JAVASCRIPT-T, 2026-08-14; JAVASCRIPT-K, 5 events
 * before it): `crypto.randomUUID is not a function`, thrown from
 * js/v2/telemetry.js module scope on iOS Safari < 15.4 — randomUUID shipped
 * in 15.4. app.js imports telemetry.js, so the throw takes the WHOLE import
 * graph with it: the page renders and every button is dead.
 *
 * ⭐ THE LESSON, and this repo has now paid for it twice: THE FIX WENT TO ONE
 * SITE, NOT THE CLASS. js/lib/analytics.js hit exactly this in July (over LAN
 * http, where randomUUID is undefined for want of a secure context), got the
 * `typeof crypto?.randomUUID === 'function'` guard, and its comment even
 * spells out the consequence — "the throw killed the ENTIRE app.js import
 * graph: page rendered, every button dead." The sibling module holding the
 * same unguarded call was never touched. Two homes, one rule, and the
 * un-fixed home is the one app.js actually imports.
 *
 * WHY THIS TEST IMPORTS RATHER THAN GREPS: a scan for the guard's spelling
 * asserts vocabulary. What must hold is BEHAVIOUR — telemetry.js loads, and
 * tel() still works, on a browser with no randomUUID. So the test deletes
 * randomUUID from globalThis.crypto and imports the real module. node's test
 * runner gives each file its own process, so this stub cannot leak into a
 * sibling test that wants the real one.
 *
 * WHY A DEGRADED SESSION ID IS THE RIGHT ANSWER (not a decline): the id joins
 * events into one funnel within a pageload and is never persisted (spec §2 —
 * no cookies, no localStorage id, no fingerprinting). It needs UNIQUENESS,
 * not cryptography. Losing telemetry for old-iOS users is a cost; losing the
 * editor for them is not a trade anyone made.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Strip randomUUID the way an old iOS Safari presents it: `crypto` exists
// (getRandomValues and all), the one method simply is not there. A PLAIN
// object, deliberately — Object.create(Crypto.prototype) would inherit
// randomUUID straight back and the stub would silently be a no-op.
const realCrypto = globalThis.crypto;
Object.defineProperty(globalThis, 'crypto', {
  value: {
    getRandomValues: (a) => realCrypto.getRandomValues(a),
    subtle: realCrypto.subtle,
  },
  configurable: true,
  writable: true,
});

test('telemetry.js imports on a browser without crypto.randomUUID', async () => {
  assert.equal(typeof globalThis.crypto.randomUUID, 'undefined',
    'instrument check: the stub must actually be missing randomUUID, or this test passes for free');

  // The import itself is the assertion — unguarded, this rejects and every
  // module downstream of app.js's telemetry import never evaluates.
  const mod = await import('../../js/v2/telemetry.js');
  assert.equal(typeof mod.tel, 'function', 'telemetry.js loaded but exported no tel()');
});

test('tel() still works with a degraded session id', async () => {
  const mod = await import('../../js/v2/telemetry.js');
  // tel() is fire-and-forget and try/catch-armored; what matters is that
  // calling it does not throw into app code.
  assert.doesNotThrow(() => mod.tel('open', { pages: 1 }));
});
