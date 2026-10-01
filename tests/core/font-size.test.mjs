/*
 * font-size.js — what a typed text size becomes (headless, pure).
 * Pins the founder's 2026-10-01 ask: sizes below 10 and any typed number
 * work; garbage can never reach an annotation as NaN.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFontSize, formatFontSize, FONT_SIZE_PRESETS } from '../../js/core/font-size.js';

test('comma and dot decimals both parse (Indonesian keyboards type a comma)', () => {
  assert.equal(parseFontSize('7,5', 18), 7.5);
  assert.equal(parseFontSize('7.5', 18), 7.5);
  assert.equal(parseFontSize(' 12 ', 18), 12);
});

test('sizes below the old floor of 10 are accepted', () => {
  assert.equal(parseFontSize('4', 18), 4);
  assert.equal(parseFontSize('1', 18), 1);
});

test('out of range clamps into 1..120', () => {
  assert.equal(parseFontSize('0', 18), 1);
  assert.equal(parseFontSize('-5', 18), 1);
  assert.equal(parseFontSize('500', 18), 120);
  assert.equal(parseFontSize('120', 18), 120);
});

test('garbage returns the current size, never NaN', () => {
  for (const bad of ['abc', '', '   ', '12px', '1e3', '1,2,3', '.', null, undefined]) {
    assert.equal(parseFontSize(bad, 18), 18, JSON.stringify(bad));
  }
  assert.equal(parseFontSize('abc', 7.395), 7.395);
});

test('result is rounded to one decimal', () => {
  assert.equal(parseFontSize('7,55', 18), 7.6);
  assert.equal(parseFontSize('7.04', 18), 7);
});

test('formatFontSize shows 1 decimal, no trailing .0, without touching the stored value', () => {
  assert.equal(formatFontSize(18), '18');
  assert.equal(formatFontSize(7.395), '7.4');
  assert.equal(formatFontSize(NaN), '');
});

test('presets start at 6 and are all valid typed input', () => {
  assert.equal(FONT_SIZE_PRESETS[0], 6);
  for (const p of FONT_SIZE_PRESETS) assert.equal(parseFontSize(String(p), 18), p);
});
