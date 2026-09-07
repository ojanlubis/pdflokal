/*
 * THE DOUBLE-DEGRADED CASE: no `crypto` at all, not even getRandomValues.
 * ============================================================================
 * telemetry-module-armor.test.mjs covers the common real case (iOS Safari <
 * 15.4, or any non-secure LAN http context) where `crypto.getRandomValues`
 * is present and only `randomUUID` is missing — that is the case that shipped
 * broken in 682cb7e (fallback ran, app.js survived, but the fallback shape
 * failed api/t.js's UUID_RE and every event from that population was silently
 * 204'd).
 *
 * This file is the OTHER branch the fix must cover: a runtime with no
 * `crypto` global whatsoever (an ancient WebView, or any environment where
 * even getRandomValues is absent). Per the fix, that must still fall back
 * further — to Math.random — and STILL produce a syntactically valid v4 UUID
 * string, because api/t.js does not know or care which branch produced it; it
 * only ever sees the final string against UUID_RE.
 *
 * A SEPARATE FILE, not another test in the sibling: node's test runner gives
 * each file its own process, and `sessionId` is computed once at module
 * import time from whatever `crypto` looked like at that instant. Stubbing a
 * second, more-degraded `crypto` in the same process after telemetry.js has
 * already been imported (and cached) would never re-run that top-level line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// No getRandomValues, no randomUUID, no crypto object at all — `crypto` reads
// as undefined, matching an environment where the global was never defined.
Object.defineProperty(globalThis, 'crypto', {
  value: undefined,
  configurable: true,
  writable: true,
});

test('telemetry.js imports with no crypto global at all', async () => {
  assert.equal(globalThis.crypto, undefined,
    'instrument check: crypto must actually be absent, or this test passes for free');
  const mod = await import('../../js/v2/telemetry.js');
  assert.equal(typeof mod.tel, 'function', 'telemetry.js loaded but exported no tel()');
});

test('the Math.random fallback still sends a v4 UUID on the wire', async () => {
  const mod = await import('../../js/v2/telemetry.js');
  let sentBlob = null;
  Object.defineProperty(globalThis, 'navigator', {
    value: { sendBeacon: (url, blob) => { sentBlob = blob; return true; } },
    configurable: true,
    writable: true,
  });

  const validDocOpen = {
    text_layer: true, pages: '1', device: 'desktop', intent: 'none', display_mode: 'browser',
  };
  for (let i = 0; i < 10; i += 1) mod.tel('doc_open', validDocOpen); // FLUSH_AT === 10

  assert.ok(sentBlob, 'flush() never reached navigator.sendBeacon — no batch to assert on');
  const envelope = JSON.parse(await sentBlob.text());
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // pinned to api/t.js's own regex
  assert.match(
    envelope.session_id,
    UUID_RE,
    `session_id "${envelope.session_id}" is not a UUID — api/t.js's UUID_RE would silently drop this whole envelope`,
  );
});
