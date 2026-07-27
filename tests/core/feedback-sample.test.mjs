/*
 * core/feedback-sample.js — Increment D consent-gated sample validation
 * (spec-edit-fidelity-instrumentation.md).
 * ============================================================================
 * Pure string-arithmetic tests, no canvas/DOM/vendor needed: dataUrlBytes()
 * and validateSample() only ever see already-encoded data URL strings, never
 * an ImageData or canvas. Run: npm run test:core (node --test, no browser).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SAMPLE_DATA_URL_PREFIX, SAMPLE_MAX_BYTES, SAMPLE_TOTAL_MAX_BYTES,
  dataUrlBytes, validateSample,
} from '../../js/core/feedback-sample.js';

// Builds a syntactically-valid `data:image/png;base64,...` string whose
// DECODED payload is exactly `byteLen` bytes — real base64 alphabet, correct
// padding, so it exercises the same code path a real canvas.toDataURL()
// output would.
function fakeDataUrl(byteLen) {
  const full4Groups = Math.floor(byteLen / 3);
  const rem = byteLen - full4Groups * 3;
  let b64 = 'A'.repeat(full4Groups * 4);
  if (rem === 1) b64 += 'AA==';
  else if (rem === 2) b64 += 'AAA=';
  return SAMPLE_DATA_URL_PREFIX + b64;
}

// ---- dataUrlBytes -----------------------------------------------------------

test('dataUrlBytes: decodes the exact byte length for a well-formed data URL (no padding)', () => {
  const url = fakeDataUrl(3000); // divisible by 3 -> no '=' padding
  assert.equal(dataUrlBytes(url), 3000);
});

test('dataUrlBytes: decodes correctly with 1-byte and 2-byte padding remainders', () => {
  assert.equal(dataUrlBytes(fakeDataUrl(3001)), 3001); // remainder 1 -> "AA=="
  assert.equal(dataUrlBytes(fakeDataUrl(3002)), 3002); // remainder 2 -> "AAA="
});

test('dataUrlBytes: wrong mime prefix (jpeg) -> Infinity, never a number', () => {
  const jpeg = 'data:image/jpeg;base64,' + 'A'.repeat(100);
  assert.equal(dataUrlBytes(jpeg), Infinity);
});

test('dataUrlBytes: non-string input -> Infinity, never throws', () => {
  assert.equal(dataUrlBytes(undefined), Infinity);
  assert.equal(dataUrlBytes(null), Infinity);
  assert.equal(dataUrlBytes(42), Infinity);
  assert.equal(dataUrlBytes({}), Infinity);
});

test('dataUrlBytes: malformed base64 (bad char, bad length) -> Infinity', () => {
  assert.equal(dataUrlBytes(SAMPLE_DATA_URL_PREFIX + 'not-base64!!'), Infinity);
  assert.equal(dataUrlBytes(SAMPLE_DATA_URL_PREFIX + 'AAA'), Infinity); // length not a multiple of 4
});

test('dataUrlBytes: empty payload -> Infinity, not 0 (an empty crop is not a valid sample)', () => {
  assert.equal(dataUrlBytes(SAMPLE_DATA_URL_PREFIX), Infinity);
});

// ---- validateSample ---------------------------------------------------------

test('validateSample: a well-formed pair well under both caps passes through unchanged', () => {
  const sample = { before: fakeDataUrl(1000), after: fakeDataUrl(1200) };
  assert.deepEqual(validateSample(sample), sample);
});

test('validateSample: a single crop exactly AT the per-crop cap passes', () => {
  const sample = { before: fakeDataUrl(SAMPLE_MAX_BYTES), after: fakeDataUrl(1000) };
  assert.deepEqual(validateSample(sample), sample);
});

test('validateSample: a single crop ONE BYTE over the per-crop cap is rejected (whole sample dropped)', () => {
  const sample = { before: fakeDataUrl(SAMPLE_MAX_BYTES + 1), after: fakeDataUrl(1000) };
  assert.equal(validateSample(sample), null);
});

test('validateSample: both crops individually under cap but combined over SAMPLE_TOTAL_MAX_BYTES -> null', () => {
  // The total cap is deliberately LESS than 2x the per-crop cap (core/
  // feedback-sample.js's own WHY), so two crops can each pass the per-crop
  // gate alone yet still trip the combined one — that's the case this test
  // exists to pin.
  const half = Math.floor(SAMPLE_TOTAL_MAX_BYTES / 2) + 500;
  assert.ok(half < SAMPLE_MAX_BYTES, 'test setup: half must still be under the per-crop cap');
  assert.ok(half + half > SAMPLE_TOTAL_MAX_BYTES, 'test setup: combined must exceed the total cap');
  const sample = { before: fakeDataUrl(half), after: fakeDataUrl(half) };
  assert.equal(validateSample(sample), null);
});

test('validateSample: combined EXACTLY at the total cap passes', () => {
  const a = 35000; const b = SAMPLE_TOTAL_MAX_BYTES - a;
  assert.ok(a <= SAMPLE_MAX_BYTES && b <= SAMPLE_MAX_BYTES, 'test setup: both must fit the per-crop cap too');
  const sample = { before: fakeDataUrl(a), after: fakeDataUrl(b) };
  assert.deepEqual(validateSample(sample), sample);
});

test('validateSample: a partial pair (only "before") is rejected — never sends/stores half a sample', () => {
  assert.equal(validateSample({ before: fakeDataUrl(1000) }), null);
  assert.equal(validateSample({ after: fakeDataUrl(1000) }), null);
});

test('validateSample: wrong mime type on either crop rejects the whole pair', () => {
  const jpeg = 'data:image/jpeg;base64,' + 'A'.repeat(100);
  assert.equal(validateSample({ before: jpeg, after: fakeDataUrl(1000) }), null);
  assert.equal(validateSample({ before: fakeDataUrl(1000), after: jpeg }), null);
});

test('validateSample: null/undefined/non-object input -> null, never throws', () => {
  assert.equal(validateSample(null), null);
  assert.equal(validateSample(undefined), null);
  assert.equal(validateSample('not an object'), null);
  assert.equal(validateSample(42), null);
});

test('validateSample: non-string before/after fields reject rather than coerce', () => {
  assert.equal(validateSample({ before: 123, after: fakeDataUrl(1000) }), null);
});
