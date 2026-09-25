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
