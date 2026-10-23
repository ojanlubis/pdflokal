/*
 * api/_turso.js — the dual-write path, and specifically its THREE GATES.
 * ============================================================================
 * Added 2026-09-16 with the dual-write (seat decisions.md 2026-09-16).
 *
 * WHY THIS FILE IS NOT OPTIONAL. Turso's SQL-over-HTTP returns **HTTP 200** for
 * a statement the database REFUSED — measured against the real database on
 * 2026-09-16, not read off a doc:
 *
 *     HTTP_STATUS=200
 *     {"results":[{"type":"error","error":{"code":"SQLITE_CONSTRAINT", ...}}]}
 *
 * A writer that checks `r.ok` therefore reports success for every rejected row.
 * That is the exact shape of the Jul 7-11 blackout (~97% of analytics lost for
 * five days, every layer green) that `api/t.js`'s own header describes. These
 * tests exist so that gate cannot be deleted by a later refactor without
 * something going red.
 *
 * Each test names the change that would make it fail.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tursoWrite, toHttpUrl, arg, placeholders } from '../../api/_turso.js';
import { Buffer } from 'node:buffer';
import handler, { __setQueryForTests, __setVisitorDayForTests } from '../../api/t.js';

const URL_OK = 'libsql://db-x.aws-ap-south-1.turso.io';
const TOKEN = 'test-token';

function stubFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = original; };
}

const okBody = (affected) => ({
  results: [
    { type: 'ok', response: { type: 'execute', result: { affected_row_count: affected } } },
    { type: 'ok', response: { type: 'close' } },
  ],
});
const jsonRes = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

// ---------------------------------------------------------------- GATE 2 ----
test('THE BLACKOUT GATE: a refused statement inside an HTTP 200 is a FAILURE, not a success', async () => {
  // This is the real payload shape, copied from a measured response.
  const restore = stubFetch(async () => jsonRes({
    baton: null,
    results: [
      {
        type: 'error',
        error: { message: 'SQLite error: CHECK constraint failed: events_session_id_shape_chk', code: 'SQLITE_CONSTRAINT' },
      },
      { type: 'ok', response: { type: 'close' } },
    ],
  }, 200));
  try {
    const out = await tursoWrite({ url: URL_OK, token: TOKEN, sql: 'insert into events values (?)', args: [arg('x')], expected: 1 });
    assert.equal(out.ok, false, 'a rejected write must never report ok — this is the blackout');
    assert.equal(out.written, 0);
    assert.equal(out.reason, 'sql_SQLITE_CONSTRAINT');
  } finally { restore(); }
});

// Was a tautology over two local fakes (it compared jsonRes(...).ok with itself
// and never called tursoWrite). Now it drives the REAL writer with a refused
// statement that ALSO carries a full row count, so GATE 3 would wave it
// through: only GATE 2 (results[].type === 'error') can tell the two apart.
// Catches: deleting GATE 2 from api/_turso.js.
test('GATE 2 goes RED if removed: a refusal that also reports the expected row count is still a failure', async () => {
  const refusedButCounted = {
    results: [
      { type: 'error', error: { code: 'SQLITE_CONSTRAINT' }, response: { type: 'execute', result: { affected_row_count: 1 } } },
      { type: 'ok', response: { type: 'close' } },
    ],
  };
  let restore = stubFetch(async () => jsonRes(refusedButCounted, 200));
  try {
    const out = await tursoWrite({ url: URL_OK, token: TOKEN, sql: 'insert', args: [], expected: 1 });
    assert.deepEqual(out, { ok: false, written: 0, reason: 'sql_SQLITE_CONSTRAINT' },
      'the statement-level error is the ONLY thing marking this refused; it must win over the row count');
  } finally { restore(); }
  // Known-positive: the same count without the error IS a success, so the
  // verdict above is GATE 2's and nothing else's.
  restore = stubFetch(async () => jsonRes(okBody(1), 200));
  try {
    const out = await tursoWrite({ url: URL_OK, token: TOKEN, sql: 'insert', args: [], expected: 1 });
    assert.equal(out.ok, true);
  } finally { restore(); }
});

// ---------------------------------------------------------------- GATE 3 ----
test('SHORT WRITE: fewer rows written than sent is a failure — a partial write is the same blackout, smaller', async () => {
  const restore = stubFetch(async () => jsonRes(okBody(2), 200));
  try {
    const out = await tursoWrite({ url: URL_OK, token: TOKEN, sql: 'insert', args: [], expected: 5 });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'short_2');
  } finally { restore(); }
});

test('a missing affected_row_count is a failure, never an assumed success', async () => {
  const restore = stubFetch(async () => jsonRes({
    results: [{ type: 'ok', response: { type: 'execute', result: {} } }, { type: 'ok', response: { type: 'close' } }],
  }, 200));
  try {
    const out = await tursoWrite({ url: URL_OK, token: TOKEN, sql: 'insert', args: [], expected: 1 });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'short_unknown');
  } finally { restore(); }
});

test('an empty results array is a failure — "nothing came back" is not "it worked"', async () => {
  const restore = stubFetch(async () => jsonRes({ results: [] }, 200));
  try {
    const out = await tursoWrite({ url: URL_OK, token: TOKEN, sql: 'insert', args: [], expected: 1 });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'no_results');
  } finally { restore(); }
});

// ---------------------------------------------------------------- GATE 1 ----
test('transport failure is reported with its status', async () => {
  const restore = stubFetch(async () => jsonRes({}, 401));
  try {
    const out = await tursoWrite({ url: URL_OK, token: TOKEN, sql: 'insert', args: [], expected: 1 });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'http_401');
  } finally { restore(); }
});

test('a network throw is caught and never escapes — the caller must always reach its 204', async () => {
  const restore = stubFetch(async () => { throw new TypeError('fetch failed'); });
  try {
    const out = await tursoWrite({ url: URL_OK, token: TOKEN, sql: 'insert', args: [], expected: 1 });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'network');
  } finally { restore(); }
});

test('a hung Turso aborts rather than holding the invocation open', async () => {
  const restore = stubFetch(async (_u, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
    });
  }));
  try {
    const out = await tursoWrite({ url: URL_OK, token: TOKEN, sql: 'insert', args: [], expected: 1, timeoutMs: 20 });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'timeout');
  } finally { restore(); }
});

// ------------------------------------------------------------ dark branch ----
test('DARK BRANCH: no url or no token means no write, no network call, and no noise', async () => {
  let called = false;
  const restore = stubFetch(async () => { called = true; return jsonRes(okBody(1), 200); });
  try {
    for (const [url, token] of [[null, TOKEN], [URL_OK, null], [null, null], ['', '']]) {
      const out = await tursoWrite({ url, token, sql: 'insert', args: [], expected: 1 });
      assert.equal(out.ok, false);
      assert.equal(out.reason, 'unconfigured', 'must be distinguishable from a real loss, or the log cannot be read');
    }
    assert.equal(called, false, 'an unconfigured writer must not touch the network');
  } finally { restore(); }
});

// ------------------------------------------------------------------ happy ----
test('a clean write reports ok with the row count it actually wrote', async () => {
  const restore = stubFetch(async (url, opts) => {
    assert.equal(url, 'https://db-x.aws-ap-south-1.turso.io/v2/pipeline');
    assert.equal(opts.headers.Authorization, `Bearer ${TOKEN}`);
    const body = JSON.parse(opts.body);
    assert.equal(body.requests.at(-1).type, 'close', 'the pipeline must always be closed');
    return jsonRes(okBody(3), 200);
  });
  try {
    const out = await tursoWrite({ url: URL_OK, token: TOKEN, sql: 'insert', args: [], expected: 3 });
    assert.deepEqual(out, { ok: true, written: 3, reason: null });
  } finally { restore(); }
});

// -------------------------------------------------------------- url + arg ----
test('toHttpUrl: libsql:// becomes https://, https:// survives, http:// is REFUSED', () => {
  assert.equal(toHttpUrl('libsql://a.turso.io'), 'https://a.turso.io');
  assert.equal(toHttpUrl('https://a.turso.io'), 'https://a.turso.io');
  assert.equal(toHttpUrl('a.turso.io'), 'https://a.turso.io');
  assert.equal(toHttpUrl('libsql://a.turso.io/'), 'https://a.turso.io');
  assert.equal(toHttpUrl('http://a.turso.io'), null, 'never send a bearer token in clear text');
  assert.equal(toHttpUrl(''), null);
  assert.equal(toHttpUrl(null), null);
});

test('arg: null becomes an explicit {type:"null"} — JSON null would bind wrongly', () => {
  assert.deepEqual(arg(null), { type: 'null' });
  assert.deepEqual(arg(undefined), { type: 'null' });
  assert.deepEqual(arg('x'), { type: 'text', value: 'x' });
  assert.deepEqual(arg(7), { type: 'float', value: 7 });
});

test('placeholders: only the skeleton is built from the count, never a value', () => {
  assert.equal(placeholders(1, 6), '(?,?,?,?,?,?)');
  assert.equal(placeholders(2, 3), '(?,?,?),(?,?,?)');
  assert.equal(placeholders(0, 6), '');
});

// ----------------------------------------------------- the ts/uuid contract ----
test('the row shape api/t.js sends satisfies the Turso CHECKs it will be measured against', () => {
  // These two CHECKs live in scripts/turso-events-migration.sql. Postgres's uuid
  // type normalises case and SQLite has no such type, so an uppercase id would
  // land in Neon and be REFUSED by Turso — the two stores would then disagree
  // for a reason that has nothing to do with either being broken, and the daily
  // comparison would read as data loss. api/t.js lowercases for exactly this.
  const TS_OK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*Z$/;
  const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  assert.ok(TS_OK.test(new Date().toISOString()), 'toISOString must satisfy events_ts_shape_chk');

  const mixed = '00000000-0000-4000-8000-0000000000AA';
  assert.ok(!UUID_LOWER.test(mixed), 'the uppercase form is what Turso refuses');
  assert.ok(UUID_LOWER.test(mixed.toLowerCase()), 'and lowercasing is what api/t.js does about it');
});

// The test above proves the CHECK refuses uppercase; this one proves api/t.js
// actually lowercases before binding. Drives the real handler through its test
// seam with UPPERCASE ids and reads the bound row.
// Catches: removing `.toLowerCase()` from session_id or visitor_id in api/t.js.
test('api/t.js binds session_id and visitor_id LOWERCASED, whatever case the client sent', async () => {
  const SESSION = '3F1C9A52-0B6E-4A7D-9C11-2F7E5D8A4B30';
  const VISITOR = 'AB12CD34-EF56-4A7B-8C9D-0E1F2A3B4C5D';
  const inserts = [];
  __setQueryForTests(async (sql, params) => {
    if (/insert into events/.test(String(sql))) inserts.push(params);
    return { rowCount: /insert into events/.test(String(sql)) ? params.length / 6 : params.length / 5 };
  });
  __setVisitorDayForTests(async () => ({ rowCount: 1 })); // never the network
  const chunks = [Buffer.from(JSON.stringify({
    session_id: SESSION,
    visitor_id: VISITOR,
    app_version: 'abc1234',
    events: [{ event: 'doc_open', props: { text_layer: true, signed: false, pages: '1', device: 'desktop', intent: 'none', display_mode: 'browser' } }],
  }))];
  const req = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    on(evt, cb) { if (evt === 'data') chunks.forEach((c) => cb(c)); if (evt === 'end') cb(); return this; },
  };
  const res = { status() { return res; }, end() { return res; } };
  try {
    await handler(req, res);
  } finally { __setQueryForTests(null); __setVisitorDayForTests(null); }

  assert.equal(inserts.length, 1, 'the uppercase batch never reached the insert — nothing to assert on');
  // Column order: ts, session_id, app_version, event, props, visitor_id.
  const [, sessionId, , , , visitorId] = inserts[0];
  const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  assert.equal(sessionId, SESSION.toLowerCase());
  assert.equal(visitorId, VISITOR.toLowerCase());
  assert.ok(UUID_LOWER.test(sessionId) && UUID_LOWER.test(visitorId), 'a bound id would be refused by Turso\'s lowercase CHECK');
});
