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

// WHY THIS TEST EXISTS ON TOP OF THE TWO ABOVE: "does not throw" was the
// whole bar the JAVASCRIPT-T fix (682cb7e) cleared, and its fallback shipped
// as `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`
// — never a UUID. api/t.js's UUID_RE
// (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`) rejects
// anything else, and a session_id that fails it drops the WHOLE envelope
// (api/t.js: "either failing means we can't trust the envelope at all") — not
// just the id. So the exact population this fallback exists to save (old iOS
// Safari, LAN http) stayed invisible to the rail even after the crash was
// fixed: the app no longer died, but every one of its events was silently
// 204'd on arrival.
//
// Reads the WIRE payload sendBeacon actually receives, not a re-implemented
// copy of the generator or a private variable — `sessionId` is module-scope
// and was never exported, and asserting on a copy could pass while the real
// call site still ships the old shape.
test('the session id sent on the wire is a v4 UUID under this same degraded crypto', async () => {
  const mod = await import('../../js/v2/telemetry.js');
  let sentBlob = null;
  Object.defineProperty(globalThis, 'navigator', {
    value: { sendBeacon: (url, blob) => { sentBlob = blob; return true; } },
    configurable: true,
    writable: true,
  });

  const validDocOpen = {
    text_layer: true, signed: false, pages: '1', device: 'desktop', intent: 'none', display_mode: 'browser',
  };
  // FLUSH_AT is 10 in js/v2/telemetry.js — the 10th call flushes synchronously.
  for (let i = 0; i < 10; i += 1) mod.tel('doc_open', validDocOpen);

  assert.ok(sentBlob, 'flush() never reached navigator.sendBeacon — no batch to assert on');
  const envelope = JSON.parse(await sentBlob.text());
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // pinned to api/t.js's own regex
  assert.match(
    envelope.session_id,
    UUID_RE,
    `session_id "${envelope.session_id}" is not a UUID — api/t.js's UUID_RE would silently drop this whole envelope`,
  );
});
