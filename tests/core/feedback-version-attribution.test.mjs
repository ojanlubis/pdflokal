/*
 * feedback-version-attribution.test.mjs — api/feedback.js version precedence
 * (audit 2026-08-09, finding 4).
 * ============================================================================
 * THE DEFECT THIS CLOSES: api/t.js was reversed on 2026-07-29 to let a real
 * CLIENT SHA (pinned at page load via /api/rev) win over the server's
 * arrival-time deploy SHA — tests/core/app-version-attribution.test.mjs pins
 * that. api/feedback.js kept the PRE-reversal copy of the same logic, with a
 * comment claiming "same reasoning as api/t.js": a 👎's stored app_version
 * named whatever deploy was live when it ARRIVED, not the build the user ran.
 * A diverged twin — the exact "fix one copy and not the other" cost the
 * maintenance spec's category 2 names. Same three-way precedence, same pins,
 * mirrored here so the two files can never silently disagree again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import feedbackHandler from '../../api/feedback.js';

const SESSION = '3f1c9a52-0b6e-4a7d-9c11-2f7e5d8a4b30';

function mkReq(bodyObj) {
  const text = JSON.stringify(bodyObj);
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    on(evt, cb) {
      if (evt === 'data') cb(Buffer.from(text, 'utf8'));
      if (evt === 'end') cb();
      return this;
    },
  };
}

// Returns the app_version actually written to the feedback insert.
async function stored(clientVersion, serverSha) {
  const realFetch = globalThis.fetch;
  const saved = { ...process.env };
  process.env.TELEMETRY_SUPABASE_URL = 'https://example.test';
  process.env.TELEMETRY_SUPABASE_SERVICE_KEY = 'k';
  if (serverSha === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
  else process.env.VERCEL_GIT_COMMIT_SHA = serverSha;
  let rows = null;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/rest/v1/feedback')) rows = JSON.parse(opts.body);
    return { ok: true, status: 201 };
  };
  const res = { code: null, status(c) { this.code = c; return this; }, end() { return this; } };
  try {
    await feedbackHandler(mkReq({ session_id: SESSION, app_version: clientVersion, rating: 'down' }), res);
  } finally {
    globalThis.fetch = realFetch;
    for (const k of ['TELEMETRY_SUPABASE_URL', 'TELEMETRY_SUPABASE_SERVICE_KEY', 'VERCEL_GIT_COMMIT_SHA']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
  assert.ok(rows && rows.length, 'the insert must have happened, or this asserts nothing');
  return rows[0].app_version;
}

test('1. THE MIRRORED REVERSAL: a real client SHA wins over the server arrival stamp', async () => {
  assert.equal(
    await stored('1111111111111111111111111111111111111111', '2222222'),
    '1111111111111111111111111111111111111111',
  );
});

test('2. a client still saying "dev" falls back to the server SHA (the old floor, kept)', async () => {
  assert.equal(await stored('dev', '2222222'), '2222222');
});

test('3. neither available: the honest literal survives, never a guess', async () => {
  assert.equal(await stored('dev', undefined), 'dev');
});
