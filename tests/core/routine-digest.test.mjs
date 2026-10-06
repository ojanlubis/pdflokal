// api/routine.js hands the cloud routine its numbers. Brief §0.3: it must
// NEVER ask for feedback.sample_before / sample_after / screenshot (crops of
// the user's own document), and never select * from feedback. Driven through
// the real digest() with fetch recorded, so this asserts what is SENT.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../../api/routine.js';

function recordFetch() {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url: String(url), sql: body.requests[0].stmt.sql });
    return { ok: true, status: 200, json: async () => ({ results: [
      { type: 'ok', response: { type: 'execute', result: { cols: [], rows: [] } } },
      { type: 'ok', response: { type: 'close' } }] }) };
  };
  return { sent, restore: () => { globalThis.fetch = real; } };
}

test('digest: never asks for document crops, never selects * from feedback', async () => {
  process.env.TURSO_EVENTS_URL = 'libsql://ev.turso.io'; process.env.TURSO_EVENTS_TOKEN = 't';
  process.env.TURSO_FEEDBACK_URL = 'libsql://fb.turso.io'; process.env.TURSO_FEEDBACK_TOKEN = 't';
  const r = recordFetch();
  try {
    await digest('2026-09-22T00:00:00.000Z', new Date('2026-09-25T00:00:00.000Z'));
  } finally { r.restore(); }
  const fbSql = r.sent.filter((s) => s.url.includes('fb.turso.io')).map((s) => s.sql);
  assert.ok(fbSql.length >= 1, 'the feedback read must actually have run (vacuity guard)');
  for (const sql of r.sent.map((s) => s.sql)) {
    assert.doesNotMatch(sql, /sample_before|sample_after|screenshot/i);
    assert.doesNotMatch(sql, /select\s+\*/i);
  }
});

// ---- the rows-read budget (Turso free plan: 500M a month; the bill is ROWS SCANNED) ----
// The window scans cost 2 reads a row (ts index entry + the table row for session_id/event),
// so every extra pass over the events window is paid again. One pass answers the liveness
// line, this window's totals and the previous window's session count.

test('digest: the liveness line, window totals and previous total are ONE pass over events, not three', async () => {
  process.env.TURSO_EVENTS_URL = 'libsql://ev.turso.io'; process.env.TURSO_EVENTS_TOKEN = 't';
  process.env.TURSO_FEEDBACK_URL = 'libsql://fb.turso.io'; process.env.TURSO_FEEDBACK_TOKEN = 't';
  const r = recordFetch();
  try {
    await digest('2026-09-22T00:00:00.000Z', new Date('2026-09-25T00:00:00.000Z'));
  } finally { r.restore(); }
  // Statements that range-scan events by ts with BOTH bounds and no event filter in the WHERE:
  // the sessions-by-day group-by and the one totals pass. Three of them is the old shape.
  const passes = r.sent.map((s) => s.sql).filter((sql) => /from events where ts >= \? and ts < \? and session_id <> \?/.test(sql));
  assert.equal(passes.length, 2, `expected the totals pass + sessions-by-day, got ${passes.length}`);
});

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch { /* skipped below, by name */ }
const sqliteTest = (name, fn) => test(name, { skip: sqlite ? false : 'node:sqlite unavailable on this Node (CI runs 20)' }, fn);

// Turso HTTP stand-in backed by a real SQLite: the digest's own SQL runs on it.
function sqliteFetch(db) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const stmt = JSON.parse(init.body).requests[0].stmt;
    const st = db.prepare(stmt.sql);
    const cols = st.columns().map((c) => ({ name: c.name }));
    const out = st.all(...stmt.args.map((a) => a.value)).map((row) => Object.values(row).map((v) =>
      (v === null ? { type: 'null' } : typeof v === 'number' ? { type: 'integer', value: String(v) } : { type: 'text', value: String(v) })));
    return { ok: true, status: 200, json: async () => ({ results: [
      { type: 'ok', response: { type: 'execute', result: { cols, rows: out } } }, { type: 'ok', response: { type: 'close' } }] }) };
  };
  return () => { globalThis.fetch = real; };
}

sqliteTest('digest: the one-pass totals equal the three queries they replaced, on real data', async () => {
  process.env.TURSO_EVENTS_URL = 'libsql://ev.turso.io'; process.env.TURSO_EVENTS_TOKEN = 't';
  process.env.TURSO_FEEDBACK_URL = 'libsql://ev.turso.io'; process.env.TURSO_FEEDBACK_TOKEN = 't';
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(`create table events (id integer primary key autoincrement, ts text not null, session_id text not null,
             app_version text not null default 'x', event text not null, props text not null default '{}', visitor_id text);
           create index events_ts_idx on events (ts desc);
           create table routine_runs (id integer primary key autoincrement, ts text, routine text, status text, window_hours real, findings text default '{}', note text);
           create table feedback (id integer primary key, ts text, rating text, note text);
           create table feature_requests (id integer primary key, ts text);`);
  const ins = db.prepare('insert into events (ts, session_id, event, visitor_id) values (?,?,?,?)');
  const MARK = '00000000-0000-4000-8000-00000000c0de';
  const since = '2026-09-22T00:00:00.000Z';
  const now = new Date('2026-09-25T00:00:00.000Z'); // window 72 h, previous window the 72 h before
  const rows = [
    ['2026-09-19T10:00:00.000Z', 'a', 'doc_open'], ['2026-09-20T10:00:00.000Z', 'a', 'export'], ['2026-09-21T23:59:59.999Z', 'b', 'doc_open'],
    ['2026-09-22T00:00:00.000Z', 'c', 'doc_open'], ['2026-09-22T05:00:00.000Z', 'c', 'export'], ['2026-09-23T05:00:00.000Z', 'd', 'tool_use'],
    ['2026-09-24T05:00:00.000Z', 'a', 'doc_open'], ['2026-09-24T06:00:00.000Z', 'e', 'export'], ['2026-09-24T07:00:00.000Z', MARK, 'doc_open'],
  ];
  for (const [ts, sid, ev] of rows) ins.run(ts, sid, ev, null);
  const restore = sqliteFetch(db);
  let d;
  try { d = await digest(since, now); } finally { restore(); }
  // The three queries this replaced, run on the same data.
  const prevSince = '2026-09-19T00:00:00.000Z';
  const until = now.toISOString();
  const old = {
    alive: db.prepare('select max(ts) m, sum(ts >= ?) w, sum(ts < ?) p from events where ts >= ? and ts < ? and session_id <> ?').get(since, since, prevSince, until, MARK),
    win: db.prepare(`select count(distinct session_id) s, count(distinct case when event='doc_open' then session_id end) o, count(distinct case when event='export' then session_id end) e
                     from events where ts >= ? and ts < ? and session_id <> ?`).get(since, until, MARK),
    prev: db.prepare('select count(distinct session_id) s from events where ts >= ? and ts < ? and session_id <> ?').get(prevSince, since, MARK),
  };
  assert.deepEqual(d.alive, { last_event: old.alive.m, n_window: Number(old.alive.w), n_prev: Number(old.alive.p) });
  assert.deepEqual(d.sessions, { window: Number(old.win.s), prev: Number(old.prev.s) });
  assert.equal(d.opened, Number(old.win.o));
  assert.equal(d.exported, Number(old.win.e));
  // Not vacuous: real, distinct, non-zero numbers (marker excluded, both windows populated).
  assert.deepEqual([d.sessions.window, d.sessions.prev, d.opened, d.exported], [4, 2, 2, 2]);
  assert.equal(d.alive.last_event, '2026-09-24T06:00:00.000Z');
  db.close();
});
