// Vercel Web Analytics bills per event, so track() sends it none: page views
// come from its script tag alone (seat decisions.md 2026-10-01). GA4 and
// Mixpanel must still hear every event, including when va() is not loaded,
// which the old early return on a missing va() used to silence.
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = {};
const { track } = await import('../../js/lib/analytics.js');

function sinks(withVa) {
  const calls = { va: 0, gtag: 0, mixpanel: 0 };
  globalThis.window = {
    gtag: () => { calls.gtag++; },
    mixpanel: { track: () => { calls.mixpanel++; } },
  };
  if (withVa) window.va = () => { calls.va++; };
  return calls;
}

test('track() sends nothing to Vercel va()', () => {
  const calls = sinks(true);
  track('tool_use', { tool: 'merge' });
  assert.equal(calls.va, 0);
});

test('track() still reaches GA4 and Mixpanel when va() is absent', () => {
  const calls = sinks(false);
  track('tool_use', { tool: 'merge' });
  assert.deepEqual([calls.gtag, calls.mixpanel], [1, 1]);
});
