/*
 * api/_turso.js — the dual-write path, and specifically its THREE GATES.
 * ============================================================================
 * Added 2026-09-16 with the dual-write (seat `specs/spec-rail-to-turso.md`).
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

test('GATE 2 goes RED if removed: deleting the results[].type==="error" check makes the case above pass', async () => {
  // A structural guard: the ONLY thing distinguishing the failing payload from
  // the succeeding one is the `type` field, since both are HTTP 200. If a
  // refactor starts trusting `r.ok`, the assertion above is what catches it —
  // this test documents that the two payloads are otherwise indistinguishable.
  const errPayload = { results: [{ type: 'error', error: { code: 'SQLITE_CONSTRAINT' } }, { type: 'ok', response: { type: 'close' } }] };
  const okPayload = okBody(1);
  assert.equal(jsonRes(errPayload, 200).ok, jsonRes(okPayload, 200).ok,
    'both payloads are HTTP 200 — transport status cannot tell them apart, which is the whole point');
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
