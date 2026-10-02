/*
 * TELEMETRY — THE REJECTION COUNTER. "What api/t.js discards is counted."
 * ============================================================================
 * Seat TODO (2026-10-02), from the bench's 2026-08-09 proposal: api/t.js dropped
 * anything it could not trust and said nothing, so "how much are we dropping?"
 * could only be answered with a shrug and strict-vs-tolerant validation was a
 * ruling about a number nobody had. api/_rejects.js counts the drops by reason.
 *
 * THE LAW THIS FILE PINS, in order of how badly it would hurt to lose:
 *   1. CONTENT-BLIND. A discarded payload is by definition the thing we have not
 *      decided to trust. No sender-supplied string may reach the counter.
 *   2. NO VERDICT CHANGED. What is kept and what is dropped is identical to
 *      before; a valid event costs nothing extra.
 *   3. EVERY discard path is counted, once, under its own reason.
 *   4. The REAL SQL works on a real SQLite, against the real migration.
 *
 * Revert check: put api/t.js back to its pre-counter text and every per-reason
 * test below goes red (the statement is never issued).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// node:sqlite exists from Node 22.5; CI runs Node 20. A static import kills the whole
// file there, so load it lazily and skip only the two real-SQLite tests without it.
const { DatabaseSync } = await import('node:sqlite').catch(() => ({}));
const NO_SQLITE = DatabaseSync ? false : 'node:sqlite is not available on this Node (CI runs 20)';

import handler, { __setQueryForTests } from '../../api/t.js';
import { createTally, upsertSql, ALL_REASONS, REQUEST_REASONS, EVENT_REASONS } from '../../api/_rejects.js';
import { SCHEMA, REJECT_REASONS } from '../../js/core/telemetry-schema.js';

const SESSION = '3f1c9a52-0b6e-4a7d-9c11-2f7e5d8a4b30';
const GOOD = { event: 'doc_open', props: { text_layer: true, signed: false, pages: '1', device: 'desktop', intent: 'none', display_mode: 'browser' } };
const VALID = { session_id: SESSION, app_version: 'abc1234', events: [GOOD] };

function mkReq(body, { error = false } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    method: 'POST',
    on(evt, cb) {
      if (error) { if (evt === 'error') cb(new Error('socket hang up')); return this; }
      if (evt === 'data') cb(Buffer.from(text, 'utf8'));
      if (evt === 'end') cb();
      return this;
    },
  };
}
function mkRes() {
  const r = { code: null };
  r.status = (c) => { r.code = c; return r; };
  r.end = () => r;
  return r;
}

// Drive the handler; return the events inserts and the counter statements apart.
async function run(payload, opts) {
  const events = [];
  const rejects = [];
  const logged = [];
  const realErr = console.error;
  console.error = (...a) => { logged.push(a.join(' ')); };
  __setQueryForTests(async (text, params) => {
    if (/telemetry_rejects/.test(String(text))) {
      const cells = [];
      for (let i = 0; i < params.length; i += 5) {
        cells.push({ day: params[i], reason: params[i + 1], event: params[i + 2], prop: params[i + 3], n: params[i + 4] });
      }
      rejects.push({ text: String(text), params, cells });
      return { rowCount: cells.length };
    }
    events.push({ text: String(text), params });
    return { rowCount: params.length / 6 };
  });
  const res = mkRes();
  try { await handler(mkReq(payload, opts), res); } finally { __setQueryForTests(null); console.error = realErr; }
  return { res, events, rejects, logged };
}
const counted = (r) => r.rejects.flatMap((q) => q.cells).map(({ reason, event, prop, n }) => ({ reason, event, prop, n }));

// ---- one test per reason ----------------------------------------------------
test('REQUEST body_too_big: a body over 32 KB is counted as one request', async () => {
  const big = { ...VALID, events: [{ event: 'doc_open', props: { pad: 'x'.repeat(40 * 1024) } }] };
  const r = await run(big);
  assert.deepEqual(counted(r), [{ reason: 'body_too_big', event: '', prop: '', n: 1 }]);
  assert.equal(r.events.length, 0);
  assert.equal(r.res.code, 204);
});

test('REQUEST body_unreadable: a stream error is counted apart from an oversize body', async () => {
  const r = await run('', { error: true });
  assert.deepEqual(counted(r), [{ reason: 'body_unreadable', event: '', prop: '', n: 1 }]);
  assert.equal(r.res.code, 204);
});

test('REQUEST bad_json: a body that is not JSON', async () => {
  const r = await run('{not json');
  assert.deepEqual(counted(r), [{ reason: 'bad_json', event: '', prop: '', n: 1 }]);
});

test('REQUEST bad_session_id / bad_app_version / no_events: the envelope fault is named, first fault wins', async () => {
  const cases = [
    ['bad_session_id', { ...VALID, session_id: 'not-a-uuid' }],
    ['bad_session_id', { ...VALID, session_id: undefined }],
    ['bad_session_id', null], // JSON `null`: no envelope at all
    ['bad_app_version', { ...VALID, app_version: 'v1.2.3-beta' }],
    ['bad_app_version', { ...VALID, session_id: SESSION, app_version: 42 }],
    ['no_events', { ...VALID, events: [] }],
    ['no_events', { ...VALID, events: 'nope' }],
    ['no_events', { session_id: SESSION, app_version: 'abc1234' }],
    ['bad_session_id', { session_id: 'x', app_version: 'zzz', events: [] }], // all three wrong: the first
  ];
  for (const [reason, payload] of cases) {
    const r = await run(payload === null ? 'null' : payload);
    assert.deepEqual(counted(r), [{ reason, event: '', prop: '', n: 1 }], JSON.stringify(payload));
    assert.equal(r.events.length, 0);
  }
});

test('EVENT events_over_cap: events past the 50th are counted per event, the first 50 still land', async () => {
  const r = await run({ ...VALID, events: Array.from({ length: 53 }, () => GOOD) });
  assert.deepEqual(counted(r), [{ reason: 'events_over_cap', event: '', prop: '', n: 3 }]);
  assert.equal(r.events[0].params.length / 6, 50, 'the cap itself must be unchanged');
});

test('EVENT event_malformed: not an object, or `event` not a string', async () => {
  const r = await run({ ...VALID, events: [null, 'doc_open', { event: 7 }, { props: {} }, GOOD] });
  assert.deepEqual(counted(r), [{ reason: 'event_malformed', event: '', prop: '', n: 4 }]);
  assert.equal(r.events[0].params.length / 6, 1, 'the one valid event is unaffected');
});

test('EVENT unknown_event: counted, and the name is NOT recorded (it is sender-controlled)', async () => {
  const r = await run({ ...VALID, events: [{ event: 'Budi_Santoso_event', props: {} }] });
  assert.deepEqual(counted(r), [{ reason: 'unknown_event', event: '', prop: '', n: 1 }]);
});

test('EVENT unknown_prop: the KNOWN event is named, the sender\'s prop name is not', async () => {
  const r = await run({ ...VALID, events: [{ event: 'doc_open', props: { ...GOOD.props, favorite_food: 'nasi goreng' } }] });
  assert.deepEqual(counted(r), [{ reason: 'unknown_prop', event: 'doc_open', prop: '', n: 1 }]);
});

test('EVENT missing_prop: the known event AND the declared prop that was missing', async () => {
  const { text_layer, ...rest } = GOOD.props; // eslint-disable-line no-unused-vars
  const r = await run({ ...VALID, events: [{ event: 'doc_open', props: rest }] });
  assert.deepEqual(counted(r), [{ reason: 'missing_prop', event: 'doc_open', prop: 'text_layer', n: 1 }]);
});

test('EVENT bad_value: the known event AND the declared prop whose value was wrong', async () => {
  const r = await run({ ...VALID, events: [{ event: 'doc_open', props: { ...GOOD.props, device: 'smart-fridge' } }] });
  assert.deepEqual(counted(r), [{ reason: 'bad_value', event: 'doc_open', prop: 'device', n: 1 }]);
});

// ---- the cases that must be told apart, and the ones that must add up -------
test('SKEW vs BUG: the strict-vs-tolerant question is answerable from the counter alone', async () => {
  // A pre-2e9fa47 `failure`: stage+reason only, the required `class` and `blocked` absent.
  const r = await run({ ...VALID, events: [{ event: 'failure', props: { stage: 'import', reason: 'encrypted' } }] });
  const c = counted(r);
  assert.equal(c.length, 1);
  assert.equal(c[0].reason, 'missing_prop');
  assert.equal(c[0].event, 'failure');
  assert.ok(Object.hasOwn(SCHEMA.failure, c[0].prop), 'the prop named must be one the schema declares');
});

test('A MIXED batch: only the bad events are counted, each under its own reason, and the good one is stored', async () => {
  const r = await run({
    ...VALID,
    events: [
      GOOD,
      { event: 'nope', props: {} },
      { event: 'doc_open', props: { ...GOOD.props, device: 'x' } },
      { event: 'doc_open', props: { ...GOOD.props, device: 'y' } },
      { event: 'also_nope', props: {} },
    ],
  });
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].params.length / 6, 1);
  const byReason = Object.fromEntries(counted(r).map((c) => [`${c.reason}/${c.event}/${c.prop}`, c.n]));
  assert.deepEqual(byReason, { 'unknown_event//': 2, 'bad_value/doc_open/device': 2 });
  assert.equal(r.rejects.length, 1, 'one statement for the whole request, however many causes');
});

test('NOTHING DROPPED, NOTHING COUNTED: a valid event issues no counter statement at all', async () => {
  const r = await run(VALID);
  assert.equal(r.rejects.length, 0, 'a healthy batch paid for a counter write');
  assert.equal(r.events.length, 1);
  assert.deepEqual(r.logged, []);
  assert.equal(r.res.code, 204);
});

test('NO VERDICT CHANGED: the events insert is byte-identical with or without bad company', async () => {
  const alone = await run(VALID);
  const mixed = await run({ ...VALID, events: [{ event: 'nope', props: {} }, GOOD, { event: 'doc_open', props: {} }] });
  const strip = (r) => ({ text: r.events[0].text, rest: r.events[0].params.filter((_, i) => i % 6 !== 0) }); // ts differs by ms
  assert.deepEqual(strip(mixed), strip(alone));
});

// ---- the content law ---------------------------------------------------------
test('CONTENT-BLIND: no sender-supplied string reaches the counter statement', async () => {
  const S = 'Budi Santoso Wijaya';
  const hostile = [
    { event: S, props: {} },
    { event: 'constructor', props: { [S]: S } },
    { event: 'doc_open', props: { ...GOOD.props, [`${S}_prop`]: S } },
    { event: 'doc_open', props: { ...GOOD.props, device: S } },
    { event: `${S}${'x'.repeat(5000)}`, props: S },
    { event: 'doc_open', props: { [S]: 1 } },
  ];
  const r = await run({ ...VALID, events: hostile });
  const wire = JSON.stringify(r.rejects.map((q) => [q.text, q.params]));
  assert.equal(wire.includes('Budi'), false, 'sender content reached the counter');
  assert.equal(wire.includes('xxxx'), false);
  assert.equal(wire.includes('nasi'), false);
  // Anything that did get stored is a closed-list reason and a SCHEMA name or ''.
  for (const c of r.rejects.flatMap((q) => q.cells)) {
    assert.ok(ALL_REASONS.includes(c.reason), `reason ${c.reason} is not in the closed list`);
    assert.ok(c.event === '' || Object.hasOwn(SCHEMA, c.event), `event ${c.event} is not a schema event`);
    assert.ok(c.prop === '' || Object.hasOwn(SCHEMA[c.event], c.prop), `prop ${c.prop} is not declared by ${c.event}`);
  }
});

test('CONTENT-BLIND: the tally itself refuses a prop for an event it does not know, and any reason off the list', () => {
  const t = createTally();
  t.add('bad_value', { event: 'Budi', prop: 'device' });         // unknown event => both dropped to ''
  t.add('bad_value', { event: 'doc_open', prop: 'Budi' });       // undeclared prop => ''
  t.add('unknown_prop', { event: 'doc_open', prop: 'device' });  // this reason never names a prop
  t.add('made_up_reason', { event: 'doc_open' });                // not counted at all
  t.add('events_over_cap', { event: 'doc_open', n: 0 });         // n < 1 not counted
  t.add('events_over_cap', { event: 'doc_open', n: 1.5 });
  assert.deepEqual(t.entries().map(({ reason, event, prop, n }) => [reason, event, prop, n]), [
    ['bad_value', '', '', 1],
    ['bad_value', 'doc_open', '', 1],
    ['unknown_prop', 'doc_open', '', 1],
  ]);
});

test('REASONS: the closed list is exactly what validateEvent can return plus the envelope/body ones', () => {
  assert.deepEqual([...REJECT_REASONS].sort(), ['bad_value', 'missing_prop', 'unknown_event', 'unknown_prop']);
  assert.equal(new Set(ALL_REASONS).size, ALL_REASONS.length, 'a reason is listed twice');
  assert.equal(ALL_REASONS.length, REQUEST_REASONS.length + EVENT_REASONS.length);
  for (const reason of ALL_REASONS) assert.ok(reason.length <= 32, 'the migration CHECK allows 32 characters');
});

// ---- failure is quiet to the client and loud to us ---------------------------
test('A counter write that fails is logged by code only, and the client still gets its 204', async () => {
  const realErr = console.error;
  const logged = [];
  console.error = (...a) => { logged.push(a.join(' ')); };
  __setQueryForTests(async () => { throw Object.assign(new Error('no such table: telemetry_rejects (Budi Santoso)'), { name: 'SqliteError' }); });
  const res = mkRes();
  try { await handler(mkReq({ ...VALID, events: [{ event: 'nope', props: {} }] }), res); } finally { __setQueryForTests(null); console.error = realErr; }
  assert.equal(res.code, 204);
  const line = logged.find((l) => l.includes('reject-count'));
  assert.ok(line, 'a failed counter write must not be invisible: that is the defect this feature exists to end');
  assert.match(line, /FAILED error=SqliteError cells=1/);
  assert.equal(line.includes('Budi'), false, 'the database message reached the log');
});

// ---- the real SQL, on a real SQLite, against the real migration --------------
function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../../scripts/turso-events-migration.sql', import.meta.url), 'utf8'));
  return db;
}

test('SQL: the migration applies, and the upsert ADDS across requests instead of inserting a row per drop', { skip: NO_SQLITE }, () => {
  const db = freshDb();
  const up = (cells) => db.prepare(upsertSql(cells.length)).run(...cells.flatMap((c) => [c.day, c.reason, c.event, c.prop, c.n]));
  up([{ day: '2026-10-02', reason: 'missing_prop', event: 'failure', prop: 'class', n: 2 }, { day: '2026-10-02', reason: 'bad_json', event: '', prop: '', n: 1 }]);
  up([{ day: '2026-10-02', reason: 'missing_prop', event: 'failure', prop: 'class', n: 3 }]);
  up([{ day: '2026-10-03', reason: 'missing_prop', event: 'failure', prop: 'class', n: 1 }]);
  const rows = db.prepare('select day, reason, event, prop, n from telemetry_rejects order by day, reason').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { day: '2026-10-02', reason: 'bad_json', event: '', prop: '', n: 1 },
    { day: '2026-10-02', reason: 'missing_prop', event: 'failure', prop: 'class', n: 5 },
    { day: '2026-10-03', reason: 'missing_prop', event: 'failure', prop: 'class', n: 1 },
  ]);
});

test('SQL: the table refuses what the content law forbids it to hold', { skip: NO_SQLITE }, () => {
  const db = freshDb();
  const ins = (...v) => db.prepare(upsertSql(1)).run(...v);
  assert.throws(() => ins('yesterday', 'bad_json', '', '', 1), /CHECK/i, 'a day that is not a date');
  assert.throws(() => ins('2026-10-02', 'bad_json', 'x'.repeat(49), '', 1), /CHECK/i, 'an event name longer than any schema name');
  assert.throws(() => ins('2026-10-02', 'bad_json', '', '', -1), /CHECK/i, 'a negative count');
  assert.throws(() => ins('2026-10-02', 'bad_json', null, '', 1), /NOT NULL/i, 'NULL would make the upsert insert per drop');
});

test('SQL: every event and prop name the SCHEMA declares fits the migration\'s length backstop', () => {
  for (const [event, shape] of Object.entries(SCHEMA)) {
    assert.ok(event.length <= 48, `${event} is longer than the telemetry_rejects.event CHECK allows`);
    for (const prop of Object.keys(shape)) assert.ok(prop.length <= 48, `${event}.${prop} is longer than the telemetry_rejects.prop CHECK allows`);
  }
});
