/*
 * TELEMETRY SUITE — class C: DELIVERY. "A 204 is not a write."
 * ============================================================================
 * WHY: Jul 7–11 2026, pdflokal.id lost ~97% of its analytics for FIVE DAYS and
 * nobody noticed, because every layer returned success while nothing was
 * recorded (CC memory `ga4-shared-tag-carrier`). The lesson banked from it was
 * "a 204 = accepted, not counted — check the last layer LATE".
 *
 * WHAT THIS CLASS CAN AND CANNOT PROVE, stated up front so nothing here is
 * mistaken for an end-to-end guarantee:
 *   CAN  — the endpoint attempts a write for valid events, drops off-schema
 *          ones, and never breaks the client. All local, deterministic.
 *   CANNOT — that a row actually landed in Supabase. That is a read against the
 *          live rail and belongs to the SEAT (reading reality is seat-owned).
 *          A local test that implied end-to-end delivery would be the 204
 *          failure wearing a new costume, so it is not attempted here.
 *
 * The seat's complement, for the record: class A proves every declared event is
 * EMITTED somewhere in source; the seat's wild-liveness query proves every
 * declared event has actually been SEEN in the rail. An event that is declared,
 * emitted, and never once observed in production is `block_edit` one layer out.
 *
 * `api/t.js` answering 204 to the CLIENT in every case is correct and is pinned
 * below — telemetry must never break or delay the editor. The defect is that it
 * is equally blind to US.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../../api/t.js';

const ENV = { TELEMETRY_SUPABASE_URL: 'https://example.test', TELEMETRY_SUPABASE_SERVICE_KEY: 'k' };

// Minimal Vercel-ish req/res. The body arrives as a stream, matching how the
// handler reads it (it does its own size-capped read).
function mkReq(bodyObj, { method = 'POST' } = {}) {
  const text = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
  const chunks = [Buffer.from(text, 'utf8')];
  return {
    method,
    headers: { 'content-type': 'application/json' },
    on(evt, cb) {
      if (evt === 'data') chunks.forEach((c) => cb(c));
      if (evt === 'end') cb();
      return this;
    },
  };
}
function mkRes() {
  const r = { code: null, ended: false };
  r.status = (c) => { r.code = c; return r; };
  r.end = () => { r.ended = true; return r; };
  return r;
}

const VALID = {
  session_id: '3f1c9a52-0b6e-4a7d-9c11-2f7e5d8a4b30',
  app_version: 'abc1234',
  events: [{ event: 'doc_open', props: { text_layer: true, pages: '1', device: 'desktop', intent: 'none' } }],
};

// Drive the handler with fetch stubbed, and report what the insert saw.
async function run(payload, { fetchImpl } = {}) {
  const realFetch = globalThis.fetch;
  const realErr = console.error;
  const calls = [];
  const logged = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null });
    return fetchImpl ? fetchImpl() : { ok: true, status: 201 };
  };
  console.error = (...a) => { logged.push(a.join(' ')); };
  const saved = {};
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  const res = mkRes();
  try {
    await handler(mkReq(payload), res);
  } finally {
    globalThis.fetch = realFetch;
    console.error = realErr;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  return { res, calls, logged };
}

test('CLIENT CONTRACT: 204 for everything a browser can send — telemetry never breaks the editor', async () => {
  for (const [label, payload] of [
    ['valid batch', VALID],
    ['malformed JSON', '{not json'],
    ['off-schema event', { ...VALID, events: [{ event: 'not_real', props: {} }] }],
    ['empty events', { ...VALID, events: [] }],
    ['bad props', { ...VALID, events: [{ event: 'doc_open', props: { device: 'smart-fridge' } }] }],
  ]) {
    const { res } = await run(payload);
    assert.equal(res.code, 204, `${label} should 204`);
    assert.equal(res.ended, true, `${label} should end the response`);
  }
});

test('DELIVERY: a valid event actually reaches the insert, with its props intact', async () => {
  const { calls } = await run(VALID);
  assert.equal(calls.length, 1, 'expected exactly one Supabase insert call');
  assert.match(calls[0].url, /\/rest\/v1\/events$/);
  const rows = calls[0].body;
  assert.ok(Array.isArray(rows) && rows.length === 1, 'expected one row');
  // The props must survive validation, or the row lands empty and the rail is
  // "working" while carrying nothing — the 2026-07 blackout's exact shape.
  assert.equal(rows[0].event, 'doc_open');
  assert.deepEqual(rows[0].props, { text_layer: true, pages: '1', device: 'desktop', intent: 'none' });
});

test('DELIVERY: an off-schema event is dropped BEFORE the insert, not stored as junk', async () => {
  const { calls } = await run({ ...VALID, events: [{ event: 'not_real', props: {} }] });
  assert.equal(calls.length, 0, 'nothing should be inserted for an all-invalid batch');
});

test('DELIVERY: a mixed batch inserts only the valid events (one bad event never drops the batch)', async () => {
  const { calls } = await run({
    ...VALID,
    events: [
      { event: 'not_real', props: {} },
      VALID.events[0],
      { event: 'doc_open', props: { device: 'smart-fridge' } },
    ],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.length, 1, 'exactly the one valid event');
  assert.equal(calls[0].body[0].event, 'doc_open');
});

// ---------------------------------------------------------------------------
// THE GAP. Expose-first per the seat's ruling — this documents what is NOT
// true today rather than asserting a fix nobody has ruled.
//
// api/t.js awaits the insert but NEVER INSPECTS ITS RESPONSE:
//
//     await fetch(`${url}/rest/v1/events`, {...});   // <- result discarded
//     } catch { /* network failure — silent */ }
//
// `fetch` rejects only on a NETWORK failure. A Supabase error RESPONSE — 401
// (bad key), 400 (schema/column mismatch), 403 (RLS), 5xx, quota — RESOLVES
// NORMALLY and is thrown away. So the single most likely failure mode is not
// merely unreported, it is not even reachable by the existing catch.
//
// Concretely live right now: `failure` and `surgery.reason='residual'` both
// shipped today and both have ZERO rows. The seat reads that as "needs specific
// conditions", which is plausible. But a rejected insert would look EXACTLY the
// same, and nothing in this system can tell the two apart. That is the 2026-07
// blackout's shape — every layer green, nothing recorded.
//
// Marked `todo` so the gate stays a trustworthy signal while the gap stays
// executable and visible. Flip it to a real test the day the seat rules the fix.
// ---------------------------------------------------------------------------
test('a REJECTED insert is reported (Supabase 401/400 must not be silently lost)', async () => {
  const { res, calls, logged } = await run(VALID, {
    fetchImpl: () => ({ ok: false, status: 401, text: async () => 'invalid api key' }),
  });
  assert.equal(calls.length, 1, 'the insert was attempted');
  const line = logged.find((l) => l.includes('[telemetry]'));
  assert.ok(line, 'a rejected insert produced NO observable signal — this is the blackout shape');
  assert.match(line, /REJECTED/);
  assert.match(line, /status=401/);
  assert.match(line, /rows_dropped=1/, 'the log must say HOW MUCH was lost, or it cannot size the damage');
  // The client contract is untouched: telemetry never breaks the editor.
  assert.equal(res.code, 204);
});

test('a NETWORK failure is reported too — the catch was silent before', async () => {
  const boom = new TypeError('fetch failed: getaddrinfo ENOTFOUND supabase');
  const { res, logged } = await run(VALID, { fetchImpl: () => { throw boom; } });
  const line = logged.find((l) => l.includes('[telemetry]'));
  assert.ok(line, 'a network failure produced no observable signal');
  assert.match(line, /FAILED/);
  assert.match(line, /error=TypeError/);
  assert.equal(res.code, 204);
});

// The log is a place user content must not reach either — the same reasoning
// that kept the export-failure branch off `err.message`. A thrown message or a
// PostgREST error body can quote row content straight into a log line.
test('the failure log is CONTENT-BLIND: no error message, no response body, no rows', async () => {
  const leaky = new TypeError('parse failed near "Budi Santoso Wijaya" in stream 42');
  const { logged } = await run(VALID, { fetchImpl: () => { throw leaky; } });
  const all = logged.join('\n');
  assert.ok(all.includes('[telemetry]'), 'expected a telemetry log line');
  assert.equal(all.includes('Budi Santoso Wijaya'), false, 'the error MESSAGE reached the log');
  assert.equal(all.includes('stream 42'), false, 'the error message reached the log');
  // And the rows themselves never appear.
  assert.equal(all.includes('doc_open'), false, 'row content reached the log');
});

// NOTE this one guards a DIFFERENT axis from the three above, and deliberately
// agrees with both the fixed and the unfixed code — verified: reverting the fix
// turns the three above red and leaves this green. That is correct, not a hole:
// it exists to stop the signal becoming chatty (a log that always fires is one
// nobody reads), which is the opposite failure from being silent. Do not read
// it as coverage of the response check.
test('a SUCCESSFUL insert stays quiet — the signal only fires on real trouble', async () => {
  const { res, logged } = await run(VALID, { fetchImpl: () => ({ ok: true, status: 201 }) });
  assert.deepEqual(logged.filter((l) => l.includes('[telemetry]')), [],
    'a healthy insert must not log — a signal that always fires is one nobody reads');
  assert.equal(res.code, 204);
});
