/*
 * Headless tests for lib/i18n.js — the translation layer's contract.
 * Run: npm run test:core   (node --test, no browser)
 *
 * WHY these live here: the plural + fallback machinery is the part that is easy to
 * get subtly wrong and hard to eyeball in a live UI. Proving it headless means the
 * big string-extraction sweep (later) can trust t() instead of re-verifying it.
 * The `id` output is also pinned byte-for-byte so a dictionary edit can't silently
 * change shipped copy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  t, getLocale, setLocale, registerMessages, DEFAULT_LOCALE,
  decimalSeparator, formatDecimal,
} from '../../js/lib/i18n.js';

test('boots to the default locale (id) headless', () => {
  assert.equal(DEFAULT_LOCALE, 'id');
  assert.equal(getLocale(), 'id');
});

test('resolves a real id string and interpolates a slot', () => {
  assert.equal(t('install.chip', { where: 'hapemu' }), 'Install PDFLokal di hapemu');
  assert.equal(t('install.device.mobile'), 'hapemu');
  assert.equal(t('install.device.desktop'), 'komputermu');
});

test('a missing slot leaves the token visible (never blank)', () => {
  assert.equal(t('install.chip'), 'Install PDFLokal di {where}');
});

test('array values (step lists) come back as an interpolated array', () => {
  const steps = t('install.ios.steps');
  assert.ok(Array.isArray(steps));
  assert.equal(steps.length, 3);
  assert.match(steps[0], /Share/);
});

test('a missing key returns the key itself — a visible, greppable miss', () => {
  assert.equal(t('nope.not.here'), 'nope.not.here');
});

test('unknown locale is refused; active locale stays put', () => {
  assert.equal(setLocale('zz'), false);
  assert.equal(getLocale(), 'id');
});

test('plural selection picks by count, and missing keys fall back to id', () => {
  registerMessages('en', {
    pages: { deleted: { one: '{count} page deleted', other: '{count} pages deleted' } },
    // deliberately no `install.*` — must fall back to id
  });
  assert.equal(setLocale('en'), true);

  assert.equal(t('pages.deleted', { count: 1 }), '1 page deleted');
  assert.equal(t('pages.deleted', { count: 5 }), '5 pages deleted');
  // fall back to the id dictionary when the key is absent in `en`
  assert.equal(t('install.device.mobile'), 'hapemu');

  setLocale('id'); // restore for any later test
});

test('number formatting is locale-driven', () => {
  assert.equal(decimalSeparator('id'), ',');
  assert.equal(decimalSeparator('en'), '.');
  assert.equal(formatDecimal(0.5, 1, 'id'), '0,5');
  assert.equal(formatDecimal(2.34, 1, 'en'), '2.3');
});
