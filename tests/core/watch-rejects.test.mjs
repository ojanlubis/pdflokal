/*
 * THE DAILY WATCH READS THE REJECTION COUNTER (api/cron/watch.js measure()).
 * ============================================================================
 * The counter's table (telemetry_rejects) comes from a migration the founder
 * applies, so for some stretch of time the watch will run against a database
 * that does not have it. The watch's own law is "a rail it cannot read is itself
 * the alarm", and that is exactly why this read must be TOLERANT: an unreadable
 * COUNTER reported as an unreadable RAIL would email him a false 'data
 * pengunjung nggak kebaca' every morning until he applied a migration.
 *
 * Revert check: make the read untolerant (drop the try/catch around it) and the
 * first test goes red, because measure() throws.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { measure } from '../../api/cron/watch.js';

const int = (v) => ({ type: 'integer', value: String(v) });
const text = (v) => ({ type: 'text', value: v });

async function withRail(rejectsAnswer, fn) {
  const realFetch = globalThis.fetch;
  const keys = ['TURSO_EVENTS_URL', 'TURSO_EVENTS_TOKEN', 'TURSO_FEEDBACK_URL', 'TURSO_FEEDBACK_TOKEN'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) process.env[k] = k.endsWith('URL') ? 'libsql://db-x.aws-ap-south-1.turso.io' : 'test-token';
  const asked = [];
  globalThis.fetch = async (_url, init) => {
    const stmt = JSON.parse(init.body).requests[0].stmt;
    asked.push(stmt);
    if (/telemetry_rejects/.test(stmt.sql)) return rejectsAnswer(stmt);
    // Every other read: one row of zeros, enough for measure() to destructure.
    return { ok: true, status: 200, json: async () => ({ results: [{ type: 'ok', response: { type: 'execute', result: { cols: [], rows: [[int(0), int(0), int(0)]] } } }] }) };
  };
  try { return await fn(asked); } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

test('WATCH: a missing telemetry_rejects table is `rejects: null`, never an unreadable rail', async () => {
  const m = await withRail(
    async () => ({ ok: true, status: 200, json: async () => ({ results: [{ type: 'error', error: { message: 'no such table', code: 'SQLITE_ERROR' } }] }) }),
    () => measure(new Date('2026-10-02T03:00:00Z')),
  );
  assert.equal(m.rejects, null);
  assert.equal(typeof m.a1, 'number', 'the rest of the measurement must be intact');
});

test('WATCH: the counter is summed by reason over the last 7 Jakarta days and lands in the findings', async () => {
  let bound;
  const m = await withRail(
    async (stmt) => {
      bound = stmt.args.map((a) => a.value);
      return { ok: true, status: 200, json: async () => ({ results: [{ type: 'ok', response: { type: 'execute', result: { cols: [], rows: [[text('missing_prop'), int(12)], [text('bad_json'), int(1)]] } } }] }) };
    },
    () => measure(new Date('2026-10-02T03:00:00Z')),
  );
  assert.deepEqual(m.rejects, { missing_prop: 12, bad_json: 1 });
  assert.deepEqual(bound, ['2026-09-25'], '7 Jakarta days before 2026-10-02');
});

test('WATCH: a counter that reads fine and is EMPTY is {} (nothing dropped), not null (could not read)', async () => {
  const m = await withRail(
    async () => ({ ok: true, status: 200, json: async () => ({ results: [{ type: 'ok', response: { type: 'execute', result: { cols: [], rows: [] } } }] }) }),
    () => measure(new Date('2026-10-02T03:00:00Z')),
  );
  assert.deepEqual(m.rejects, {});
});
