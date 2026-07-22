/*
 * Headless tests for core/telemetry-schema.js — the telemetry SSOT shared by
 * the client (js/v2/telemetry.js) and the endpoint (api/t.js).
 * Run: npm run test:core   (node --test, no browser)
 *
 * The contract (spec-telemetry.md §2): validateEvent is pure, no I/O, and
 * strict on every axis — unknown event, unknown prop, missing prop, bad enum,
 * wrong type all fail the WHOLE event, never a partial pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SCHEMA, validateEvent, pagesBucket, durationBucket } from '../../js/core/telemetry-schema.js';

// A minimal, schema-valid props object for each event — used to prove every
// declared event validates cleanly at least once, and as a base to mutate
// for the negative tests below.
const VALID_PROPS = {
  doc_open: { text_layer: true, pages: '1', device: 'desktop' },
  tool_use: { tool: 'teks', action: 'text' },
  export: { surgery_used: false, fallback: 'none', duration: 100 },
  font_seen: { flavor: 'type0-identity-h', extract: 'ok' },
  ganti_tap: { hit: true },
  ganti_commit: { outcome: 'commit', font_path: 'doc-font' },
  surgery: { matched: true, reason: 'clean' },
  insert: { path: 'native', reason: 'clean' },
  block_edit: { editable: true, reason: 'single-line', align: 'left' },
  commit_paint: { duration: 250, pages: '2-5', device: 'phone' },
};

test('every SCHEMA event has a VALID_PROPS fixture (test coverage stays complete as events are added)', () => {
  for (const name of Object.keys(SCHEMA)) {
    assert.ok(name in VALID_PROPS, `no fixture for event "${name}" — add one to VALID_PROPS`);
  }
  for (const name of Object.keys(VALID_PROPS)) {
    assert.ok(name in SCHEMA, `fixture "${name}" has no matching SCHEMA entry`);
  }
});

test('every v1 event validates cleanly with its correct props', () => {
  for (const [name, props] of Object.entries(VALID_PROPS)) {
    const result = validateEvent(name, props);
    assert.equal(result.ok, true, `${name} should validate`);
    assert.deepEqual(result.clean, props);
  }
});

test('clean strips nothing extra and is a fresh object (not the same reference)', () => {
  const props = { ...VALID_PROPS.doc_open };
  const { clean } = validateEvent('doc_open', props);
  assert.notEqual(clean, props);
  assert.deepEqual(clean, props);
});

test('unknown event name fails', () => {
  assert.equal(validateEvent('not_a_real_event', {}).ok, false);
  assert.equal(validateEvent('', {}).ok, false);
  assert.equal(validateEvent(undefined, {}).ok, false);
});

test('unknown prop fails the whole event', () => {
  const props = { ...VALID_PROPS.doc_open, extra_field: 'nope' };
  assert.equal(validateEvent('doc_open', props).ok, false);
});

test('missing a required prop fails', () => {
  const { text_layer, ...rest } = VALID_PROPS.doc_open; // eslint-disable-line no-unused-vars
  assert.equal(validateEvent('doc_open', rest).ok, false);
});

test('enum value outside the declared list fails', () => {
  assert.equal(validateEvent('doc_open', { ...VALID_PROPS.doc_open, device: 'smart-fridge' }).ok, false);
  assert.equal(validateEvent('tool_use', { ...VALID_PROPS.tool_use, tool: 'scissors' }).ok, false);
  assert.equal(validateEvent('export', { ...VALID_PROPS.export, fallback: 'server' }).ok, false);
});

test('wrong type fails for bool props', () => {
  assert.equal(validateEvent('doc_open', { ...VALID_PROPS.doc_open, text_layer: 'true' }).ok, false);
  assert.equal(validateEvent('doc_open', { ...VALID_PROPS.doc_open, text_layer: 1 }).ok, false);
  assert.equal(validateEvent('ganti_tap', { hit: 'yes' }).ok, false);
});

test('wrong type fails for enum props (numbers, arrays, objects are never enum values)', () => {
  assert.equal(validateEvent('doc_open', { ...VALID_PROPS.doc_open, pages: 1 }).ok, false);
  assert.equal(validateEvent('doc_open', { ...VALID_PROPS.doc_open, device: ['desktop'] }).ok, false);
  assert.equal(validateEvent('doc_open', { ...VALID_PROPS.doc_open, device: null }).ok, false);
});

test('NO string-typed prop exists anywhere in SCHEMA (spec §2 law)', () => {
  for (const [event, shape] of Object.entries(SCHEMA)) {
    for (const [prop, descriptor] of Object.entries(shape)) {
      const isEnum = Array.isArray(descriptor);
      const isTyped = descriptor === 'bool' || descriptor === 'int' || descriptor === 'duration';
      assert.ok(isEnum || isTyped, `${event}.${prop} has a free-string type descriptor — forbidden`);
      if (isEnum) {
        assert.ok(descriptor.length > 0, `${event}.${prop} enum must not be empty`);
        for (const v of descriptor) assert.equal(typeof v, 'string', `${event}.${prop} enum values must be strings`);
      }
    }
  }
});

test('duration type: must be an integer multiple of 10, within [0, 600000]', () => {
  assert.equal(validateEvent('export', { ...VALID_PROPS.export, duration: 100.5 }).ok, false);
  assert.equal(validateEvent('export', { ...VALID_PROPS.export, duration: -10 }).ok, false);
  assert.equal(validateEvent('export', { ...VALID_PROPS.export, duration: 15 }).ok, false); // not a multiple of 10
  assert.equal(validateEvent('export', { ...VALID_PROPS.export, duration: 600001 }).ok, false); // over the cap
  assert.equal(validateEvent('export', { ...VALID_PROPS.export, duration: 600000 }).ok, true); // at the cap, inclusive
  assert.equal(validateEvent('export', { ...VALID_PROPS.export, duration: 0 }).ok, true); // at the floor, inclusive
});

test('props that are not a plain object (null/array/undefined/string) are treated as empty, not crashed on', () => {
  assert.equal(validateEvent('ganti_tap', null).ok, false); // required prop "hit" then missing
  assert.equal(validateEvent('ganti_tap', undefined).ok, false);
  assert.equal(validateEvent('ganti_tap', []).ok, false);
  assert.equal(validateEvent('ganti_tap', 'nope').ok, false);
});

// ---- bucketing helpers --------------------------------------------------------

test('pagesBucket: boundaries per spec-telemetry.md §3 (1 | 2-5 | 6-20 | 21+)', () => {
  assert.equal(pagesBucket(1), '1');
  assert.equal(pagesBucket(2), '2-5');
  assert.equal(pagesBucket(5), '2-5');
  assert.equal(pagesBucket(6), '6-20');
  assert.equal(pagesBucket(20), '6-20');
  assert.equal(pagesBucket(21), '21+');
  assert.equal(pagesBucket(1000), '21+');
});

test('pagesBucket: defensive on garbage input — never throws, never off-schema', () => {
  assert.equal(pagesBucket(0), '1');
  assert.equal(pagesBucket(-5), '1');
  assert.equal(pagesBucket(NaN), '1');
  assert.equal(pagesBucket(undefined), '1');
  assert.equal(pagesBucket('banyak'), '1');
});

test('durationBucket: clamps to [0, 600000] and rounds to the nearest 10ms', () => {
  assert.equal(durationBucket(-500), 0);
  assert.equal(durationBucket(0), 0);
  assert.equal(durationBucket(1234), 1230);
  assert.equal(durationBucket(1235), 1240); // Math.round ties away from zero at .5
  assert.equal(durationBucket(700000), 600000);
  assert.equal(durationBucket(Infinity), 600000);
  assert.equal(durationBucket(NaN), 0);
});

test('durationBucket output always satisfies the "duration" type descriptor', () => {
  for (const ms of [-100, 0, 1, 9, 10, 12345, 600000, 999999]) {
    const bucketed = durationBucket(ms);
    const result = validateEvent('export', { surgery_used: false, fallback: 'none', duration: bucketed });
    assert.equal(result.ok, true, `durationBucket(${ms}) = ${bucketed} should be schema-valid`);
  }
});
