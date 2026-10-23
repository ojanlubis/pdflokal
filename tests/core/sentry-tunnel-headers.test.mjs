/*
 * SENTRY TUNNEL — Sentry's back-pressure reaches the SDK, and a bad envelope
 * is the CLIENT's fault (400), not ours (500).
 * ============================================================================
 * WHY: the tunnel copied back only Content-Type. The SDK learns its rate limits
 * from `Retry-After` and `X-Sentry-Rate-Limits` (per-category limits ride on
 * ordinary 200s too), so with them stripped it kept sending events Sentry was
 * already discarding: every one an Edge invocation and quota spent for nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../../api/sentry-tunnel.js';

const DSN = 'https://abc@o4511472486580224.ingest.us.sentry.io/4511472494313472';
const envelope = (dsn = DSN) => `${JSON.stringify({ dsn })}\n{"type":"event"}\n{}`;
const post = (body) => new Request('https://pdflokal.id/api/sentry-tunnel', { method: 'POST', body });

function withUpstream(response, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return response; };
  return fn(calls).finally(() => { globalThis.fetch = real; });
}

test('a 429 from Sentry reaches the browser WITH its Retry-After and rate-limit headers', () =>
  withUpstream(new Response('', {
    status: 429,
    headers: { 'Retry-After': '60', 'X-Sentry-Rate-Limits': '60:error:organization' },
  }), async (calls) => {
    const res = await handler(post(envelope()));
    assert.equal(calls.length, 1, 'VACUITY GUARD: the envelope was forwarded upstream');
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('retry-after'), '60');
    assert.equal(res.headers.get('x-sentry-rate-limits'), '60:error:organization');
  }));

test('a 200 carrying per-category limits passes them through too', () =>
  withUpstream(new Response('{}', {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-Sentry-Rate-Limits': '30:transaction:key' },
  }), async () => {
    const res = await handler(post(envelope()));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-sentry-rate-limits'), '30:transaction:key');
    assert.equal(res.headers.get('content-type'), 'application/json');
  }));

test('a healthy 200 without limits adds no invented headers', () =>
  withUpstream(new Response('{}', { status: 200 }), async () => {
    const res = await handler(post(envelope()));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('retry-after'), null);
    assert.equal(res.headers.get('x-sentry-rate-limits'), null);
  }));

test('a malformed envelope is a 400 and never reaches Sentry; an upstream failure stays a 500', async () => {
  await withUpstream(new Response('{}', { status: 200 }), async (calls) => {
    for (const bad of ['not json at all', '{"dsn":"::not a url"}\n{}', '']) {
      const res = await handler(post(bad));
      assert.equal(res.status, 400, `bad envelope ${JSON.stringify(bad)} -> 400`);
      assert.doesNotMatch(await res.text(), /not json|not a url/, 'never echoes the client body');
    }
    assert.equal(calls.length, 0, 'nothing malformed was forwarded');
  });
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const res = await handler(post(envelope()));
    assert.equal(res.status, 500, 'a failed upstream is our side, not the client');
  } finally { globalThis.fetch = real; }
});

test('the allowlist still holds (known-positive for the 400 path)', () =>
  withUpstream(new Response('{}', { status: 200 }), async (calls) => {
    const res = await handler(post(envelope('https://abc@evil.example/4511472494313472')));
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  }));
