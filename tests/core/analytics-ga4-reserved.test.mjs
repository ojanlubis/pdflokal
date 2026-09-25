// GA4 treats source/medium/campaign/term/content/gclid as traffic-source
// fields. forGA4() must rename them before gtag() sees them, or a UI label
// becomes the visitor's "website" (seat decisions.md 2026-09-02).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forGA4 } from '../../js/lib/analytics.js';

test('forGA4: reserved traffic-source keys are renamed, everything else passes', () => {
  assert.deepEqual(
    forGA4({ intent: 'gabung', source: 'card', medium: 'x', campaign: 'y', term: 'z', content: 'c', gclid: 'g', tool: 'merge' }),
    { intent: 'gabung', cta_source: 'card', cta_medium: 'x', cta_campaign: 'y', cta_term: 'z', cta_content: 'c', cta_gclid: 'g', tool: 'merge' },
  );
});

test('forGA4: no data is an empty object, and the input is not mutated', () => {
  assert.deepEqual(forGA4(undefined), {});
  const data = { source: 'card' };
  forGA4(data);
  assert.deepEqual(data, { source: 'card' });
});
