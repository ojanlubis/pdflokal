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

const ENV = { DATABASE_URL: 'postgresql://user:pw@example.test/neondb' };
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
  assert.deepEqual(calls[0].params, [SESSION, 'abc1234', 'down', 'hurufnya jadi tebal', null, null]);
  assert.equal(res.code, 204);
});

test('a REJECTED insert is reported — this branch was silent for three weeks', async () => {
  const err = Object.assign(new Error('new row violates check constraint'), { name: 'NeonDbError', code: '23514' });
  const { res, logged } = await run(VALID, { queryImpl: () => { throw err; } });
  const line = logged.find((l) => l.includes('[feedback]'));
  assert.ok(line, 'a rejected feedback insert produced NO observable signal');
  assert.match(line, /FAILED/);
  assert.match(line, /error=NeonDbError/);
  assert.match(line, /code=23514/);
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

test('DARK RAIL: no DATABASE_URL means no insert and still a 204', async () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  __setQueryForTests(null);
  const res = mkRes();
  try {
    await handler(mkReq(VALID), res);
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved;
  }
  assert.equal(res.code, 204);
});
