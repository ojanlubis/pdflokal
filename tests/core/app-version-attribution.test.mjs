/*
 * WHICH BUILD DID THIS COME FROM? — api/rev.js + api/t.js version precedence.
 *
 * THE DEFECT THIS CLOSES (2026-07-28). `app_version` was the SERVER's deploy
 * SHA stamped at the moment a batch ARRIVED. One real 82-minute session carried
 * FOUR values — four deploys had landed while it was flushing; nothing had
 * reloaded, because session_id is per-pageload and never persisted. The field
 * described our deploy timeline, not the user's code, so "did the build we just
 * shipped cause this failure?" had no answer. That question is the whole basis
 * of shipping at night and reading the rail in the morning.
 *
 * The fix has two halves and BOTH are pinned here, because either half alone
 * silently does nothing: /api/rev has to tell the truth, and api/t.js has to
 * stop overwriting the answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import tHandler, { __setQueryForTests } from '../../api/t.js';
import revHandler from '../../api/rev.js';

// ---- /api/rev ----------------------------------------------------------------
function mkRes() {
  const r = { code: null, body: null, headers: {} };
  r.status = (c) => { r.code = c; return r; };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.end = (b) => { r.body = b ?? null; return r; };
  return r;
}
function callRev(method = 'GET', sha) {
  const saved = process.env.VERCEL_GIT_COMMIT_SHA;
  if (sha === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
  else process.env.VERCEL_GIT_COMMIT_SHA = sha;
  const res = mkRes();
  try { revHandler({ method }, res); } finally {
    if (saved === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
    else process.env.VERCEL_GIT_COMMIT_SHA = saved;
  }
  return res;
}

test('1. /api/rev reports this deployment SHA', () => {
  const res = callRev('GET', 'A1B2C3D4E5F60718293A4B5C6D7E8F9012345678');
  assert.equal(res.code, 200);
  assert.equal(JSON.parse(res.body).rev, 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678');
});

test('2. with no deploy SHA it says "dev" — it never guesses one', () => {
  assert.equal(JSON.parse(callRev('GET', undefined).body).rev, 'dev');
  assert.equal(JSON.parse(callRev('GET', 'not-a-sha').body).rev, 'dev');
});

test('3. it must NOT be browser-cacheable', () => {
  // A cached response outlives the deployment and then reports a stale SHA with
  // total confidence — the exact defect this endpoint exists to remove.
  assert.match(callRev('GET', 'abc1234').headers['cache-control'], /no-store/);
});

test('4. GET only', () => {
  assert.equal(callRev('POST', 'abc1234').code, 405);
});

test('5. CONTENT-BLIND BY CONSTRUCTION: it reads nothing off the request', () => {
  // Not "we were careful" — there is no input to leak. Hand it a request whose
  // every field is a tripwire and it must still answer.
  const trap = new Proxy({ method: 'GET' }, {
    get(t, k) {
      if (k === 'method') return 'GET';
      throw new Error(`api/rev read request.${String(k)} — it must read NOTHING but the method`);
    },
  });
  const res = mkRes();
  revHandler(trap, res);
  assert.equal(res.code, 200);
});

// ---- api/t.js precedence -----------------------------------------------------
const SESSION = '3f1c9a52-0b6e-4a7d-9c11-2f7e5d8a4b30';
const EVENT = { event: 'doc_open', props: { text_layer: true, pages: '1', device: 'desktop', intent: 'none', display_mode: 'browser' } };

function mkReq(bodyObj) {
  const text = JSON.stringify(bodyObj);
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    on(evt, cb) {
      if (evt === 'data') cb(Buffer.from(text, 'utf8'));
      if (evt === 'end') cb();
      return this;
    },
  };
}

// Returns the app_version actually written to the insert.
//
// Reads it out of the STATEMENT PARAMETERS since the Neon move (2026-08-23) —
// app_version is the third of the five columns per row. Stubbing fetch and
// parsing a PostgREST body would now mean asserting on the driver's private
// wire format; see tests/core/telemetry-delivery.test.mjs for the full why.
async function stored(clientVersion, serverSha) {
  const saved = { ...process.env };
  process.env.DATABASE_URL = 'postgresql://user:pw@example.test/neondb';
  if (serverSha === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
  else process.env.VERCEL_GIT_COMMIT_SHA = serverSha;
  let params = null;
  __setQueryForTests(async (_text, p) => { params = p; return { rowCount: p.length / 5 }; });
  const res = { code: null, status(c) { this.code = c; return this; }, end() { return this; } };
  try {
    await tHandler(mkReq({ session_id: SESSION, app_version: clientVersion, events: [EVENT] }), res);
  } finally {
    __setQueryForTests(null);
    for (const k of ['DATABASE_URL', 'VERCEL_GIT_COMMIT_SHA']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
  assert.ok(params && params.length, 'the insert must have happened, or this asserts nothing');
  return params[2];
}

test('6. THE REVERSAL: a real client SHA wins over the server arrival stamp', async () => {
  // This is the whole point. Before 2026-07-29 the server value always won,
  // which is how one page load came to carry four "versions".
  assert.equal(await stored('1111111111111111111111111111111111111111', '2222222'), '1111111111111111111111111111111111111111');
});

test('7. a client still saying "dev" falls back to the server SHA', async () => {
  // First batch or two, offline, or an old cached client. The previous
  // behaviour is kept as the FLOOR, so this never regresses to nothing.
  assert.equal(await stored('dev', '2222222'), '2222222');
});

test('8. neither available: the honest literal survives, never a guess', async () => {
  assert.equal(await stored('dev', undefined), 'dev');
});
