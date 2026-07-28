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

import {
  SCHEMA, validateEvent, pagesBucket, durationBucket, intentValue, ratioBucket, inkRatioBucket,
} from '../../js/core/telemetry-schema.js';

// A minimal, schema-valid props object for each event — used to prove every
// declared event validates cleanly at least once, and as a base to mutate
// for the negative tests below.
const VALID_PROPS = {
  doc_open: { text_layer: true, pages: '1', device: 'desktop', intent: 'none', display_mode: 'browser' },
  tool_use: { tool: 'teks', action: 'text' },
  // export carries BOTH the edit-ladder fields (surgery_used/fallback/duration)
  // and the intent fields (format/size/pages_scope) — the two branches taught
  // this event different halves of the same question; the merge keeps both.
  export: {
    surgery_used: false, fallback: 'none', duration: 100,
    format: 'pdf', size: 'asli', pages_scope: 'all',
  },
  // font_seen/insert widened spec-edit-fidelity-instrumentation.md Increment
  // B (rides with Increment A's fingerprint ladder, core/font-fingerprint.js).
  font_seen: {
    flavor: 'type0-identity-h', extract: 'ok', embedded: true, subtype: 'type0',
    name_informative: false, bold: true, style_source: 'program-name',
  },
  // scan_offer — the scan dead end's affordance (2026-07-28).
  scan_offer: { action: 'shown', tool: 'none' },
  ganti_tap: { hit: true },
  ganti_commit: { outcome: 'commit', font_path: 'doc-font' },
  surgery: { matched: true, reason: 'clean' },
  insert: { path: 'native', reason: 'clean', style_source: 'pdf-name', glyph_shortfall: 0 },
  commit_paint: { duration: 250, pages: '2-5', device: 'phone' },
  // failure — the rail's export/commit blind spot, closed 2026-07-28 with its
  // own first case (a protected PDF that views fine and can never be written).
  failure: { stage: 'export', reason: 'encrypted' },
  // visual_oracle (spec-edit-fidelity-instrumentation.md Increment C):
  // core/visual-oracle.js's compareRegions() ratios, bucketed. ink_ratio
  // added 2026-07-28 (the "Pondok Sapi"/"Cibeber" incident) — a REQUIRED
  // field now, bucketed by its own inkRatioBucket(), never ratioBucket().
  visual_oracle: {
    weight_ratio: 'near-parity', height_ratio: 'near-parity', overflow: false, ink_ratio: 'near-parity',
  },
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

// surgery.reason gained 'residual' on 2026-07-28 — the value that lets the cut
// say "I matched, and I could not clear what you asked me to." Without it the
// enum could only express a lie ('clean') or a different thing ('no-match'),
// and a rail that cannot express the finding is how the finding gets lost.
// `failure` is the rail's oldest blind spot closed. Its enum has to be wider
// than the case that motivated it, because an enum is hard to widen once
// dashboards read it — and 'unknown' has to exist or an unclassified failure
// goes UNCOUNTED, which is the rail going quiet exactly when something new
// breaks.
test('failure carries every stage/reason, and refuses invented ones', () => {
  for (const stage of ['import', 'commit', 'export', 'compress', 'render', 'runtime']) {
    assert.equal(validateEvent('failure', { stage, reason: 'unknown' }).ok, true, `stage ${stage}`);
  }
  for (const reason of ['encrypted', 'corrupt', 'out-of-memory', 'unsupported', 'timeout', 'unknown']) {
    assert.equal(validateEvent('failure', { stage: 'export', reason }).ok, true, `reason ${reason}`);
  }
  // The gate still closes, so this test can fail rather than merely agree.
  assert.equal(validateEvent('failure', { stage: 'download', reason: 'unknown' }).ok, false);
  assert.equal(validateEvent('failure', { stage: 'export', reason: 'vibes' }).ok, false);
  // Content-blind: no free-text escape hatch for an error message, which is the
  // one field that can quote the user's document back to us.
  assert.equal(validateEvent('failure', { stage: 'export', reason: 'unknown', message: 'boom' }).ok, false);
});

test("surgery.reason carries 'residual' — the rail can now see an incomplete cut", () => {
  assert.equal(validateEvent('surgery', { matched: true, reason: 'residual' }).ok, true);
  // Every declared value still validates, so adding one didn't narrow the rest.
  for (const reason of ['clean', 'residual', 'no-match', 'untrustworthy-run']) {
    assert.equal(validateEvent('surgery', { matched: true, reason }).ok, true, `${reason} should validate`);
  }
  // And the gate still closes: an invented reason is refused, so this test is
  // capable of failing rather than just agreeing with whatever the code emits.
  assert.equal(validateEvent('surgery', { matched: true, reason: 'probably-fine' }).ok, false);
});

// ---- the "what did they come to do?" additions (intent + export choices) ------

test('doc_open.intent accepts every declared job and rejects an off-list value', () => {
  for (const intent of ['gabung', 'split', 'halaman', 'kompres', 'ttd', 'paraf', 'teks', 'tipex', 'gambar', 'foto', 'none']) {
    assert.equal(validateEvent('doc_open', { ...VALID_PROPS.doc_open, intent }).ok, true, `intent "${intent}" should be valid`);
  }
  assert.equal(validateEvent('doc_open', { ...VALID_PROPS.doc_open, intent: 'hack' }).ok, false);
  assert.equal(validateEvent('doc_open', { ...VALID_PROPS.doc_open, intent: undefined }).ok, false); // now required
});

// display_mode (2026-07-28): GA4 structurally cannot answer "what share of
// sessions come FROM an installed app" — it counts install EVENTS, and iOS
// Safari never fires appinstalled, so every iPhone Add-to-Home-Screen is
// invisible. Asking the running session what it is measures the installed BASE.
test('doc_open.display_mode: both values validate, and it is REQUIRED', () => {
  for (const display_mode of ['standalone', 'browser']) {
    assert.equal(validateEvent('doc_open', { ...VALID_PROPS.doc_open, display_mode }).ok, true, display_mode);
  }
  assert.equal(validateEvent('doc_open', { ...VALID_PROPS.doc_open, display_mode: 'twa' }).ok, false);
  const { display_mode, ...without } = VALID_PROPS.doc_open; // eslint-disable-line no-unused-vars
  assert.equal(validateEvent('doc_open', without).ok, false, 'display_mode must be required, not optional');
});

// scan_offer measures whether the offer LANDS, and it is deliberately narrow:
// `accepted` fires only from the offer itself and only when the tool genuinely
// armed. The wider question — "can these users finish the job without OCR" — is
// a rail query over the SEQUENCE (ganti_no_text_layer -> tool_use), not a second
// meaning bolted onto this enum. Overloading one value with two meanings is how
// `matched:true` came to mean both "found" and "removed".
test('scan_offer: every action/tool pair validates, and invented ones are refused', () => {
  for (const action of ['shown', 'accepted', 'dismissed']) {
    assert.equal(validateEvent('scan_offer', { action, tool: 'none' }).ok, true, action);
  }
  for (const tool of ['tipex', 'teks', 'none']) {
    assert.equal(validateEvent('scan_offer', { action: 'accepted', tool }).ok, true, tool);
  }
  assert.equal(validateEvent('scan_offer', { action: 'ignored', tool: 'none' }).ok, false);
  assert.equal(validateEvent('scan_offer', { action: 'shown', tool: 'ocr' }).ok, false);
  // Both props required — a shown-without-tool would be untyped at the sink.
  assert.equal(validateEvent('scan_offer', { action: 'shown' }).ok, false);
});

test('tool_use gains gabung/merge as the first-party merge signal', () => {
  assert.equal(validateEvent('tool_use', { tool: 'gabung', action: 'merge' }).ok, true);
  assert.equal(validateEvent('tool_use', { tool: 'gabung', action: 'text' }).ok, true); // action enum is per-event, not paired
});

test('export choices: format/size/pages_scope validate and are required', () => {
  for (const format of ['pdf', 'png', 'jpg']) {
    assert.equal(validateEvent('export', { ...VALID_PROPS.export, format }).ok, true);
  }
  for (const size of ['asli', 'kompres', 'sedang', 'kecil']) {
    assert.equal(validateEvent('export', { ...VALID_PROPS.export, size }).ok, true);
  }
  for (const pages_scope of ['all', 'some']) {
    assert.equal(validateEvent('export', { ...VALID_PROPS.export, pages_scope }).ok, true);
  }
  assert.equal(validateEvent('export', { ...VALID_PROPS.export, format: 'docx' }).ok, false);
  assert.equal(validateEvent('export', { ...VALID_PROPS.export, size: 'raksasa' }).ok, false);
  assert.equal(validateEvent('export', { ...VALID_PROPS.export, pages_scope: 'most' }).ok, false);
  // required: dropping any one fails the whole event
  const { format, ...noFormat } = VALID_PROPS.export; // eslint-disable-line no-unused-vars
  assert.equal(validateEvent('export', noFormat).ok, false);
});

test('intentValue: real keys pass through, garbage/null/typos collapse to none (never off-schema)', () => {
  for (const k of ['gabung', 'split', 'halaman', 'kompres', 'ttd', 'paraf', 'teks', 'tipex', 'gambar', 'foto', 'none']) {
    assert.equal(intentValue(k), k);
  }
  assert.equal(intentValue('gabung; DROP TABLE'), 'none');
  assert.equal(intentValue(''), 'none');
  assert.equal(intentValue(null), 'none');
  assert.equal(intentValue(undefined), 'none');
  assert.equal(intentValue('GABUNG'), 'none'); // case-sensitive by design
  // every intentValue output must satisfy the doc_open.intent descriptor
  for (const raw of ['gabung', 'xyz', null, undefined, 42]) {
    const r = validateEvent('doc_open', { ...VALID_PROPS.doc_open, intent: intentValue(raw) });
    assert.equal(r.ok, true, `intentValue(${String(raw)}) must be schema-valid`);
  }
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
    const result = validateEvent('export', { ...VALID_PROPS.export, duration: bucketed });
    assert.equal(result.ok, true, `durationBucket(${ms}) = ${bucketed} should be schema-valid`);
  }
});

// ---- ink_ratio / inkRatioBucket (2026-07-28 incident fix) ---------------------
// core/visual-oracle.js's compareRegions().inkRatio is a NEW, separately-
// bucketed field on visual_oracle — added because ratioBucket()'s cuts,
// tuned for stroke-weight noise tolerance, missed a real production defect
// by 0.010015 (see decisions.md / the builder's report for the full incident).

test('visual_oracle.ink_ratio is a REQUIRED prop — dropping it fails the whole event, same as any other visual_oracle field', () => {
  const { ink_ratio, ...rest } = VALID_PROPS.visual_oracle; // eslint-disable-line no-unused-vars
  assert.equal(validateEvent('visual_oracle', rest).ok, false);
});

test('visual_oracle.ink_ratio accepts the same 5 RATIO_BUCKET labels as weight_ratio/height_ratio', () => {
  for (const bucket of ['much-lower', 'lower', 'near-parity', 'higher', 'much-higher']) {
    assert.equal(validateEvent('visual_oracle', { ...VALID_PROPS.visual_oracle, ink_ratio: bucket }).ok, true);
  }
  assert.equal(validateEvent('visual_oracle', { ...VALID_PROPS.visual_oracle, ink_ratio: 'identical' }).ok, false);
});

test('inkRatioBucket: the 5 cuts (0.7/0.9/1.1/1.3) are TIGHTER than ratioBucket\'s (0.6/0.8/1.3/1.6)', () => {
  assert.equal(inkRatioBucket(0.5), 'much-lower');
  assert.equal(inkRatioBucket(0.8), 'lower');
  assert.equal(inkRatioBucket(1.0), 'near-parity');
  assert.equal(inkRatioBucket(1.2), 'higher');
  assert.equal(inkRatioBucket(1.5), 'much-higher');
});

test('inkRatioBucket: non-finite inputs collapse to the directional extreme, same discipline as ratioBucket', () => {
  assert.equal(inkRatioBucket(Infinity), 'much-higher');
  assert.equal(inkRatioBucket(NaN), 'much-lower');
  assert.equal(inkRatioBucket(-Infinity), 'much-lower');
});

test('REGRESSION (the 2026-07-28 incident number, 863/669): ratioBucket calls it near-parity — inkRatioBucket must not', () => {
  const incidentRatio = 863 / 669; // 1.2899850523168908 — the real emitted weightRatio/inkRatio
  assert.ok(Math.abs(incidentRatio - 1.2899850523168908) < 1e-9);
  // The bug as it shipped: ratioBucket's 1.3 cut reads this as an all-clear.
  assert.equal(ratioBucket(incidentRatio), 'near-parity', 'documents the actual miss — ratioBucket was fooled by 0.010015');
  // The fix: inkRatioBucket's tighter 1.1 cut does NOT call this near-parity.
  assert.equal(inkRatioBucket(incidentRatio), 'higher');
  assert.notEqual(inkRatioBucket(incidentRatio), 'near-parity');
});
