/*
 * The daily watch, driven end to end through api/cron/watch.js with fetch
 * recorded: what reaches tolongingetin (his inbox) and what reaches
 * routine_runs (the proof it ran). His ruling 2026-10-01: email for feedback
 * or a dark rail, never for A2/A3/A6, and the row every day regardless.
 *
 * Every case asserts BOTH sides. "No email was sent" passes for free if the
 * handler died before it got that far, so a no-email case only counts when the
 * row also landed and says why nothing was sent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../../api/cron/watch.js';
import { jakartaDay } from '../../api/_watch.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const int = (v) => ({ type: 'integer', value: String(v) });
const text = (v) => ({ type: 'text', value: v });
const ok = (rows, err) => ({ ok: true, status: 200, json: async () => ({ results: err ? [
  { type: 'error', error: { message: err, code: 'SQLITE_ERROR' } }] : [
  { type: 'ok', response: { type: 'execute', result: { cols: [], rows, affected_row_count: rows.length ? 0 : 1 } } },
  { type: 'ok', response: { type: 'close' } }] }) });

/**
 * `rail` is what the rail says today. Healthy defaults: 29 days at 90 sessions,
 * Edit in use, A2/A3 under threshold, no hard failures, no feedback.
 */
function stubRail(rail = {}) {
  const r = { sessions: 90, a1: 500, a2: [72, 10], a3: [67, 10], a6: 0, notes: [], a5: [20, 2], unreadable: false, ...rail };
  const now = Date.now();
  const days = [];
  for (let i = 1; i <= 29; i += 1) {
    const n = i === 1 && r.yesterday != null ? r.yesterday : r.sessions;
    if (n > 0) days.push([text(jakartaDay(new Date(now - i * DAY_MS))), int(n), int(n)]);
  }
  const mail = [];
  const rows = [];
  const sqls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (String(url).includes('tolongingetin')) {
      mail.push(body);
      return { ok: true, status: 200, json: async () => ({ status: 'sent' }) };
    }
    const { sql, args } = body.requests[0].stmt;
    sqls.push(sql);
    if (/insert into routine_runs/.test(sql)) {
      rows.push({ status: args[1].value, findings: JSON.parse(args[3].value), note: args[4].value, raw: JSON.stringify(args) });
      return ok([]);
    }
    if (r.unreadable) return { ok: false, status: 503, json: async () => ({}) };
    if (/group by d/.test(sql)) return ok(days);
    if (/ganti_tap/.test(sql)) return ok([[int(r.a1)]]);
    if (/visual_oracle/.test(sql)) return ok([r.a2.map(int)]);
    if (/event = 'insert'/.test(sql)) return ok([r.a3.map(int)]);
    if (/hard_fails/.test(sql)) return ok([[int(r.a6)]]);
    if (/note is not null/.test(sql)) return ok(r.notes.map(([ts, rating, note]) => [text(ts), text(rating), text(note)]));
    if (/rating = 'down'/.test(sql)) return ok([[int(r.a5[0]), int(r.a5[1])]]);
    // The feature vote's ideas live in their own table, counted on their own.
    if (/from feature_requests/.test(sql)) {
      if (r.noFeatureTable) return ok(null, 'no such table: feature_requests');
      return ok([[int(r.featureRequests ?? 0)]]);
    }
    throw new Error(`unstubbed SQL: ${sql.slice(0, 60)}`);
  };
  return { mail, rows, sqls, restore: () => { globalThis.fetch = real; } };
}

const ENV = {
  CRON_SECRET: 's', TOLONGINGETIN_KEY: 'k', WATCH_DISABLED: '',
  TURSO_EVENTS_URL: 'libsql://ev.turso.io', TURSO_EVENTS_TOKEN: 't',
  TURSO_FEEDBACK_URL: 'libsql://fb.turso.io', TURSO_FEEDBACK_TOKEN: 't',
};

async function runWatch(rail) {
  const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENV);
  const stub = stubRail(rail);
  const res = { code: 0, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, end() { return this; } };
  try {
    await handler({ headers: { authorization: 'Bearer s' } }, res);
  } finally {
    stub.restore();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  assert.equal(stub.rows.length, 1, 'exactly one routine_runs row, every day: the row is the proof it ran');
  assert.equal(res.body.record, 'ok', 'and the write landed');
  return { mail: stub.mail, row: stub.rows[0], res, sqls: stub.sqls };
}

test('a healthy day: no email, and the row says it stayed quiet', async () => {
  const { mail, row } = await runWatch({});
  assert.deepEqual(row.findings.fired, []);
  assert.equal(row.findings.email, 'skipped: quiet');
  assert.equal(mail.length, 0);
});

test('A6 alone (threshold 1): recorded in the row, never emailed', async () => {
  const { mail, row } = await runWatch({ a6: 3 });
  assert.deepEqual(row.findings.fired, ['A6'], 'A6 still fires: the standard stays on the record');
  assert.equal(row.findings.a6, 3);
  assert.equal(row.findings.email, 'skipped: only A6');
  assert.equal(row.status, 'warn');
  assert.equal(mail.length, 0, 'A6 at threshold 1 mailed him nearly every day; it must not');
});

test('A4: a human wrote words, so the note reaches him verbatim, and only him', async () => {
  const note = 'tolong dong font nya gak bisa di kecilin';
  const { mail, row } = await runWatch({ a6: 2, notes: [['2026-10-01T02:00:00.000Z', 'down', note]], a5: [9, 3] });
  assert.equal(mail.length, 1);
  assert.ok(mail[0].body.includes(`"${note}"`), 'the note, exactly as written');
  assert.match(mail[0].body, /7 hari terakhir: 6 👍, 3 👎\./);
  assert.match(mail[0].idem_key, /^pdflokal-watch:\d{4}-\d{2}-\d{2}$/, 'one email per Jakarta day');
  assert.deepEqual(row.findings.fired, ['A6', 'A4']);
  assert.deepEqual(row.findings.email_for, ['A4']);
  assert.equal(row.findings.email, 'ok');
  assert.ok(!row.raw.includes(note), 'PRIVACY: note text goes to his inbox, never into routine_runs');
});

test('a dark rail (floor breached): emails him', async () => {
  const { mail, row } = await runWatch({ yesterday: 0 });
  assert.equal(mail.length, 1);
  assert.match(mail[0].subject, /data pengunjung anjlok/);
  assert.deepEqual(row.findings.email_for, ['floor']);
  assert.equal(row.findings.email, 'ok');
  assert.equal(row.status, 'fail');
});

test('A2 and A3 only: recorded, never emailed', async () => {
  // A2 at 30% (> 20%), A3 at 40% (> 30%): both over threshold.
  const { mail, row } = await runWatch({ a2: [100, 30], a3: [100, 40] });
  assert.deepEqual(row.findings.fired, ['A2', 'A3']);
  assert.equal(row.findings.email, 'skipped: only A2,A3');
  assert.equal(mail.length, 0);
});

test('the rail cannot be read: that is the alarm, and it emails', async () => {
  const { mail, row, res } = await runWatch({ unreadable: true });
  assert.equal(res.code, 500);
  assert.equal(mail.length, 1);
  assert.equal(row.status, 'fail');
  assert.equal(row.findings.email, 'ok');
});

test('FEATURE VOTE IDEAS: counted from their own table, never emailed, and A4/A5 never read that table', async () => {
  // 40 ideas in a day and nothing else wrong: no email, but the row says how many.
  const { mail, row, sqls } = await runWatch({ featureRequests: 40 });
  assert.equal(row.findings.feature_requests, 40, 'counted separately, in the row');
  assert.equal(row.findings.a4, 0, 'an idea is not "new feedback"');
  assert.deepEqual(row.findings.fired, []);
  assert.equal(row.findings.email, 'skipped: quiet');
  assert.equal(mail.length, 0, 'one email per idea would be the failure this guards');
  const a4 = sqls.filter((q) => /note is not null/.test(q));
  const a5 = sqls.filter((q) => /rating = 'down'/.test(q));
  assert.equal(a4.length, 1, 'vacuity guard: the A4 read ran');
  assert.equal(a5.length, 1, 'vacuity guard: the A5 read ran');
  for (const q of [...a4, ...a5]) assert.doesNotMatch(q, /feature_requests/, 'thumbs reads never touch the ideas table');
  assert.equal(sqls.filter((q) => /from feature_requests/.test(q)).length, 1);
});

test('FEATURE VOTE IDEAS: before the migration is applied the watch records null, it does NOT cry "rail unreadable"', async () => {
  const { mail, row, res } = await runWatch({ noFeatureTable: true });
  assert.equal(res.code, 200, 'a missing ideas table is not a dark rail');
  assert.equal(row.findings.feature_requests, null);
  assert.equal(row.findings.email, 'skipped: quiet');
  assert.equal(mail.length, 0);
});
