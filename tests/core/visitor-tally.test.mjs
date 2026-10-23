// The daily visitor tally on the telemetry write path (api/t.js, 2026-10-06).
// "N orang hari ini" reads visitor_day_counts as one row; this pins that every
// accepted batch with a visitor_id offers (WIB day, visitor_id) to visitor_days,
// and that the tally can never cost the rail anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import handler, { __setQueryForTests, __setVisitorDayForTests } from '../../api/t.js';
import { wibDay } from '../../api/visitors.js';

const VID = '7b5451d0-1111-4222-8333-444455556666';
const BATCH = (vid) => ({
  session_id: '3f1c9a52-0b6e-4a7d-9c11-2f7e5d8a4b30',
  app_version: 'abc1234',
  ...(vid ? { visitor_id: vid } : {}),
  events: [{ event: 'doc_open', props: { text_layer: true, signed: false, pages: '1', device: 'desktop', intent: 'none', display_mode: 'browser' } }],
});
function mkReq(obj) {
  const chunks = [Buffer.from(JSON.stringify(obj), 'utf8')];
  return { method: 'POST', headers: { 'content-type': 'application/json' },
    on(evt, cb) { if (evt === 'data') chunks.forEach((c) => cb(c)); if (evt === 'end') cb(); return this; } };
}
function mkRes() { const r = { code: null }; r.status = (c) => { r.code = c; return r; }; r.end = () => r; return r; }

async function run(payload, { events = 'ok', tally = 'ok' } = {}) {
  const seen = [];
  const errs = [];
  const realErr = console.error;
  console.error = (...a) => { errs.push(a.join(' ')); };
  __setQueryForTests(async (sql, params) => {
    if (/telemetry_rejects/.test(sql)) return { rowCount: params.length / 5 };
    if (events === 'throw') throw new TypeError('down');
    return { rowCount: params.length / 6 };
  });
  __setVisitorDayForTests(async (sql, values) => {
    seen.push({ sql, values });
    if (tally === 'throw') throw new TypeError('down');
    return { rowCount: 1 };
  });
  const res = mkRes();
  try { await handler(mkReq(payload), res); } finally {
    __setQueryForTests(null); __setVisitorDayForTests(null); console.error = realErr;
  }
  return { res, seen, errs };
}

test('a batch with a visitor_id offers (WIB day, visitor_id) to the tally', async () => {
  const { res, seen } = await run(BATCH(VID));
  assert.equal(res.code, 204);
  assert.equal(seen.length, 1);
  assert.match(seen[0].sql, /^insert into visitor_days \(day, visitor_id\) values \(\?, \?\) on conflict do nothing$/);
  assert.deepEqual(seen[0].values, [wibDay(Date.now()), VID]);
});

test('no visitor_id (private mode): no tally write', async () => {
  const { seen } = await run(BATCH(null));
  assert.equal(seen.length, 0);
});

test('the events insert failed: no tally write (the tally never counts a visit the rail lost)', async () => {
  const { seen } = await run(BATCH(VID), { events: 'throw' });
  assert.equal(seen.length, 0);
});

test('a failing tally is logged and never changes the 204', async () => {
  const { res, errs } = await run(BATCH(VID), { tally: 'throw' });
  assert.equal(res.code, 204);
  assert.ok(errs.some((e) => /tally FAILED/.test(e)));
});
