/*
 * FEEDBACK DELIVERY — the sibling guard api/t.js has had since 2026-07-28,
 * and api/feedback.js did not have until 2026-08-23.
 * ============================================================================
 * WHY IT WAS MISSING, which is the useful part: the fix for "a discarded
 * response is a silent loss" was written for api/t.js, tested for api/t.js,
 * and never travelled the six feet to the file beside it. `api/feedback.js`
 * kept `await fetch(...)` with the result thrown away, inside an EMPTY catch —
 * so a rejected insert AND a network failure both ended as a cheerful 204 with
 * nothing written anywhere. Two files held one lesson by hand; one of them
 * forgot. That is the whole argument for a test rather than a comment.
 *
 * AND IT HIDES BETTER HERE THAN IN THE EVENTS RAIL. A 👎 is three orders of
 * magnitude rarer than a doc_open, so a feedback table that quietly stopped
 * accepting rows reads exactly like a product nobody complains about. There is
 * no volume drop to notice. The only thing that could ever have caught it is
 * the endpoint saying so.
 *
 * WHAT THIS CAN AND CANNOT PROVE: that the endpoint attempts the write, reports
 * a failure, reports a SHORT write, stays quiet when healthy, and never leaks
 * content into the log. NOT that a row landed in Neon — that is a read against
 * the live table and belongs to the seat.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import handler, { __setQueryForTests } from '../../api/feedback.js';

const ENV = {};
const SESSION = '3f1c9a52-0b6e-4a7d-9c11-2f7e5d8a4b30';

function mkReq(bodyObj, { method = 'POST' } = {}) {
  const text = typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj);
  return {
    method,
    headers: { 'content-type': 'application/json' },
    on(evt, cb) {
      if (evt === 'data') cb(Buffer.from(text, 'utf8'));
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

const VALID = { session_id: SESSION, app_version: 'abc1234', rating: 'down', note: 'hurufnya jadi tebal' };

async function run(payload, { queryImpl } = {}) {
  const realErr = console.error;
  const calls = [];
  const logged = [];
  __setQueryForTests(async (text, params) => {
    calls.push({ text: String(text), params });
    if (queryImpl) return queryImpl();
    return { rowCount: 1 };
  });
  console.error = (...a) => { logged.push(a.join(' ')); };
  const saved = {};
  for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
  const res = mkRes();
  try {
    await handler(mkReq(payload), res);
  } finally {
    __setQueryForTests(null);
    console.error = realErr;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  return { res, calls, logged };
}

test('DELIVERY: a valid 👎 reaches the insert, parameterized, with its note intact', async () => {
  const { calls, res } = await run(VALID);
  assert.equal(calls.length, 1, 'expected exactly one insert statement');
  assert.match(calls[0].text, /insert into feedback\b/i);
  // The note is a value, never text spliced into SQL. This is the one field a
  // user actually types, so it is the one that must never reach the statement.
  assert.equal(calls[0].text.includes('hurufnya'), false, 'the note was interpolated into the SQL');
  // ⚠️ THE WHOLE ARRAY, not a subset — and it went red for the right reason on
  // 2026-09-09 when `screenshot` was added as the 7th parameter. A new column
  // silently joining this insert is exactly what a full-array assertion is for,
  // so it is updated deliberately here rather than loosened to a prefix match.
  // The trailing nulls are sample_before, sample_after, screenshot: this body
  // carries no image of any kind.
  //
  // ⚠️ UPDATED AGAIN 2026-09-16 when `ts` became the FIRST parameter (dual-write,
  // seat `specs/spec-rail-to-turso.md`). It moved from a database default to an
  // explicit value for a reason the soak depends on: Neon and Turso issue
  // different ids, so without one shared clock written to both there is no
  // column pair that identifies a single feedback row in both stores, and the
  // daily comparison has nothing to join on.
  // The value itself is generated at call time, so its SHAPE is asserted — that
  // shape is what `feedback_ts_shape_chk` in the Turso schema enforces, and a
  // drift here would be refused there rather than silently stored.
  const [sentTs, ...rest] = calls[0].params;
  assert.match(sentTs, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'ts must be ISO-8601 UTC ms');
  assert.deepEqual(rest, [SESSION, 'abc1234', 'down', 'hurufnya jadi tebal', null, null, null]);
  assert.equal(res.code, 204);
});

// The REAL write path, with only the network stubbed: Turso refuses a
// statement with HTTP 200 and an error inside the body (measured 2026-09-16;
// api/_turso.js header). That is the blackout shape, so it is driven here
// end to end rather than through the SQL seam.
async function runRefused(payload, envPrefix) {
  const realErr = console.error;
  const realFetch = globalThis.fetch;
  const logged = [];
  const saved = {};
  for (const k of [`${envPrefix}_URL`, `${envPrefix}_TOKEN`]) saved[k] = process.env[k];
  process.env[`${envPrefix}_URL`] = 'libsql://db-x.aws-ap-south-1.turso.io';
  process.env[`${envPrefix}_TOKEN`] = 'test-token';
  __setQueryForTests(null);
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ results: [
      { type: 'error', error: { message: 'SQLite error: CHECK constraint failed: value Budi Santoso Wijaya', code: 'SQLITE_CONSTRAINT' } },
      { type: 'ok', response: { type: 'close' } }] }),
  });
  console.error = (...a) => { logged.push(a.join(' ')); };
  const res = mkRes();
  try {
    await handler(mkReq(payload), res);
  } finally {
    console.error = realErr;
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  return { res, logged };
}

test('a REJECTED insert is reported — this branch was silent for three weeks', async () => {
  const { res, logged } = await runRefused(VALID, 'TURSO_FEEDBACK');
  const line = logged.find((l) => l.includes('[feedback]'));
  assert.ok(line, 'a feedback row Turso REFUSED inside an HTTP 200 produced NO observable signal');
  assert.match(line, /FAILED/);
  assert.match(line, /error=sql_SQLITE_CONSTRAINT/);
  assert.equal(line.includes('Budi'), false, 'the database message quotes the value; it must never reach the log');
  assert.equal(res.code, 204, 'the client contract is untouched: feedback never breaks the editor');
});

test('a NETWORK failure is reported too — the catch used to be empty', async () => {
  const { logged } = await run(VALID, { queryImpl: () => { throw new TypeError('fetch failed'); } });
  const line = logged.find((l) => l.includes('[feedback]'));
  assert.ok(line, 'a network failure was swallowed');
  assert.match(line, /FAILED/);
  assert.match(line, /error=TypeError/);
});

test('a SHORT write is reported — "no error" is not "it landed"', async () => {
  const { logged } = await run(VALID, { queryImpl: () => ({ rowCount: 0 }) });
  const line = logged.find((l) => l.includes('[feedback]'));
  assert.ok(line, 'a row that was never written passed as a success');
  assert.match(line, /SHORT/);
  assert.match(line, /written=0/);
});

test('the failure log is CONTENT-BLIND: the note the user typed never reaches it', async () => {
  // Postgres quotes the offending VALUE in its error text, so err.message is a
  // direct channel from a user-authored field into a log. Same reasoning that
  // kept the export-failure branch off err.message.
  const leaky = Object.assign(
    new Error(`value too long for type character varying: "Budi Santoso Wijaya"`),
    { name: 'NeonDbError', code: '22001' },
  );
  const { logged } = await run(VALID, { queryImpl: () => { throw leaky; } });
  const all = logged.join('\n');
  assert.ok(all.includes('[feedback]'), 'expected a feedback log line');
  assert.equal(all.includes('Budi Santoso Wijaya'), false, 'the error MESSAGE reached the log');
  assert.equal(all.includes('hurufnya'), false, 'the user note reached the log');
});

test('a SUCCESSFUL insert stays quiet — a signal that always fires is one nobody reads', async () => {
  const { logged, res } = await run(VALID, { queryImpl: () => ({ rowCount: 1 }) });
  assert.deepEqual(logged.filter((l) => l.includes('[feedback]')), []);
  assert.equal(res.code, 204);
});

test('DARK RAIL: no Turso config means no insert and still a 204', async () => {
  // The deploy-order hazard, pinned: without its env vars the rail drops every
  // event and nothing here goes red (the daily watch is what notices). It must
  // not even TRY to reach the network, and must still answer 204.
  const saved = { url: process.env.TURSO_FEEDBACK_URL, token: process.env.TURSO_FEEDBACK_TOKEN };
  delete process.env.TURSO_FEEDBACK_URL; delete process.env.TURSO_FEEDBACK_TOKEN;
  __setQueryForTests(null);
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; return { ok: true, status: 200, json: async () => ({}) }; };
  const res = mkRes();
  try {
    await handler(mkReq(VALID), res);
  } finally {
    globalThis.fetch = realFetch;
    if (saved.url !== undefined) process.env.TURSO_FEEDBACK_URL = saved.url;
    if (saved.token !== undefined) process.env.TURSO_FEEDBACK_TOKEN = saved.token;
  }
  assert.equal(fetched, 0, 'a dark rail must not attempt a write');
  assert.equal(res.code, 204);
});
