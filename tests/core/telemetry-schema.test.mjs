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
  ocrLinesBucket, zoomBucket,
} from '../../js/core/telemetry-schema.js';

// A minimal, schema-valid props object for each event — used to prove every
// declared event validates cleanly at least once, and as a base to mutate
// for the negative tests below.
const VALID_PROPS = {
  doc_open: { text_layer: true, signed: false, pages: '1', device: 'desktop', intent: 'none', display_mode: 'browser' },
  tool_use: { tool: 'teks', action: 'text' },
  // export_intent — the download sheet was OPENED (2026-09-10). Its whole job
  // is to sit between `export` (a file was produced) and `failure`/export (the
  // builder threw), so abandonment stops looking like never-tried.
  export_intent: { pages: '2-5', device: 'phone' },
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
  // ocr_run — one recognition pass over one page (2026-08-23, rung S2).
  // `lines` uses OCR_LINES_BUCKET, which has a '0' the page bucket does not:
  // "recognised nothing" is the outcome this event exists to be able to see.
  ocr_run: { lines: '6-20', duration: 1200, engine_cached: false },
  ganti_tap: { hit: true },
  ganti_commit: { outcome: 'commit', font_path: 'doc-font' },
  surgery: { matched: true, reason: 'clean' },
  // decision/decided_live/flips added 2026-10-01 (edit font design B8),
  // ADDITIVE and OPTIONAL (OPTIONAL_PROPS; seat ruling: a new prop is never required).
  insert: {
    path: 'native', reason: 'clean', style_source: 'pdf-name', glyph_shortfall: 0,
    decision: 'native', decided_live: true, flips: 0,
    // block_lines/reflowed added 2026-10-01 (Rung D), ADDITIVE and OPTIONAL.
    block_lines: 5, reflowed: true,
  },
  // block_edit (2026-10-01, Rung D): re-added WITH its call sites.
  // decline_reason is OPTIONAL (present only on outcome 'decline').
  block_edit: { outcome: 'decline', decline_reason: 'columns', block_lines: 4 },
  commit_paint: { duration: 250, pages: '2-5', device: 'phone' },
  // failure — the rail's export/commit blind spot, closed 2026-07-28 with its
  // own first case (a protected PDF that views fine and can never be written).
  // class/blocked added 2026-08-09 — both ADDITIVE, and both required, because
  // validateEvent has no optional props (see the SCHEMA header).
  failure: { stage: 'export', reason: 'encrypted', class: 'none', blocked: true },
  // visual_oracle (spec-edit-fidelity-instrumentation.md Increment C):
  // core/visual-oracle.js's compareRegions() ratios, bucketed. ink_ratio
  // added 2026-07-28 (the "Pondok Sapi"/"Cibeber" incident) — a REQUIRED
  // field now, bucketed by its own inkRatioBucket(), never ratioBucket().
  visual_oracle: {
    weight_ratio: 'near-parity', height_ratio: 'near-parity', overflow: false, ink_ratio: 'near-parity',
  },
  // boot_failure (2026-09-07): sent by index.html's inline boot guard, not by
  // any tel() call site — js/v2/telemetry.js is inside the module graph this
  // event reports the death of. Shape pinned against the real bytes in
  // tests/core/boot-failure-beacon.test.mjs.
  boot_failure: { kind: 'missing-export', action: 'heal' },
  // failure_cause (2026-09-06): the two enums failureCause() can return.
  failure_cause: { stage: 'export', name: 'TypeError', hint: 'undefined-prop' },
  // 2026-10-02, the three gaps (split/Ekstrak, the sheet's close, the +/- buttons).
  extract_export: { duration: 450, pages: '2-5', pages_scope: 'some' },
  export_sheet_close: { how: 'x', built: false, waited_ms: 1200 },
  zoom_tap: { dir: 'out', level: '200-249', device: 'desktop' },
  merge_blocked: { reason: 'open_unrebuildable', pages: '2-5' },
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

// THE SKEW `signed` COSTS, STATED OUT LOUD (2026-09-09). This module is
// imported verbatim by api/t.js, which drops an off-schema event silently, and
// every declared prop is required. PDFLokal is an installable PWA, so a cached
// install still running the old JS sends doc_open WITHOUT `signed` and loses
// the WHOLE event — text_layer, pages, device and intent with it — until it
// updates. That cost was accepted (same trade as failure.class/blocked,
// 2026-08-09), but the bank's rule is that a schema edit must SIMULATE the
// skew rather than assume it: this is that simulation, so the loss is a
// measured fact instead of a comment. Expect a doc_open dip after the deploy
// and do not read it as a usage drop.
test('SKEW, ACCEPTED: an old client\'s doc_open (no `signed`) loses the whole event', () => {
  const { signed, ...oldClient } = VALID_PROPS.doc_open; // eslint-disable-line no-unused-vars
  assert.equal(validateEvent('doc_open', oldClient).ok, false);
  // …and the current client is fine, so this is about the skew and not about
  // a schema that rejects everything.
  assert.equal(validateEvent('doc_open', VALID_PROPS.doc_open).ok, true);
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
    assert.equal(validateEvent('failure', { stage, reason: 'unknown', class: 'none', blocked: true }).ok, true, `stage ${stage}`);
  }
  for (const reason of ['encrypted', 'corrupt', 'out-of-memory', 'unsupported', 'timeout', 'unknown']) {
    assert.equal(validateEvent('failure', { stage: 'export', reason, class: 'none', blocked: true }).ok, true, `reason ${reason}`);
  }
  // The gate still closes, so this test can fail rather than merely agree.
  assert.equal(validateEvent('failure', { stage: 'download', reason: 'unknown', class: 'none', blocked: true }).ok, false);
  assert.equal(validateEvent('failure', { stage: 'export', reason: 'vibes', class: 'none', blocked: true }).ok, false);
  // Content-blind: no free-text escape hatch for an error message, which is the
  // one field that can quote the user's document back to us.
  assert.equal(validateEvent('failure', { stage: 'export', reason: 'unknown', class: 'none', blocked: true, message: 'boom' }).ok, false);
});

test("surgery.reason carries 'residual' — the rail can now see an incomplete cut", () => {
  assert.equal(validateEvent('surgery', { matched: true, reason: 'residual' }).ok, true);
  // Every declared value still validates, so adding one didn't narrow the rest.
  // 'untrustworthy-run' left this list 2026-08-09 — runSurgery could never emit
  // it, so looping over it proved only that the schema agreed with itself.
  for (const reason of ['clean', 'residual', 'no-match']) {
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
  // 'ocr' joined this enum on 2026-08-23 when rung S2 gave the sheet a fourth
  // option. It used to be pinned here as the REFUSED example, which was right
  // while OCR had no entry point; the pin moves to a value that is still
  // invented rather than being deleted, so the enum keeps a live negative.
  for (const tool of ['tipex', 'teks', 'ocr', 'none']) {
    assert.equal(validateEvent('scan_offer', { action: 'accepted', tool }).ok, true, tool);
  }
  assert.equal(validateEvent('scan_offer', { action: 'ignored', tool: 'none' }).ok, false);
  assert.equal(validateEvent('scan_offer', { action: 'shown', tool: 'tandatangan' }).ok, false);
  // Both props required — a shown-without-tool would be untyped at the sink.
  assert.equal(validateEvent('scan_offer', { action: 'shown' }).ok, false);
});

test('ocrLinesBucket keeps ZERO visible — the outcome that would retire rung S2', () => {
  // THE POINT OF THE WHOLE BUCKET. pagesBucket collapses 0 into '1' (a
  // document always has a page), so reusing it would make "this scan was too
  // poor to recognise anything" read identically to "one line found" — the
  // single reading that decides whether a 5 MB engine is worth shipping,
  // erased by the metric meant to report it.
  assert.equal(ocrLinesBucket(0), '0');
  assert.notEqual(ocrLinesBucket(0), pagesBucket(0));
  assert.equal(ocrLinesBucket(1), '1-5');
  assert.equal(ocrLinesBucket(5), '1-5');
  assert.equal(ocrLinesBucket(6), '6-20');
  assert.equal(ocrLinesBucket(60), '21-60');
  assert.equal(ocrLinesBucket(61), '61+');
  // Garbage collapses to the smallest bucket rather than emitting an
  // off-schema string validateEvent would then silently drop the event over.
  for (const junk of [NaN, undefined, null, -5, 'abc']) {
    assert.equal(ocrLinesBucket(junk), '0', String(junk));
    assert.equal(validateEvent('ocr_run', { lines: ocrLinesBucket(junk), duration: 0, engine_cached: true }).ok, true);
  }
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

// ---- optional props (seat ruling 2026-10-01: a new prop is never required) ----
// The insert event gained decision/decided_live/flips. api/t.js validates with
// this module, so if they were required every cached PWA client — sending the
// pre-2026-10-01 shape — would lose the WHOLE insert event until it refreshed.
const OLD_INSERT = { path: 'native', reason: 'clean', style_source: 'pdf-name', glyph_shortfall: 0 };

test('an OLD-shape insert (no decision/decided_live/flips) still validates and lands intact', () => {
  const r = validateEvent('insert', OLD_INSERT);
  assert.equal(r.ok, true, 'a cached client\'s insert must not be dropped');
  assert.deepEqual(r.clean, OLD_INSERT, 'absent optional props are not invented');
});

test('optional props are still TYPE-checked when present, and only those three may be absent', () => {
  assert.equal(validateEvent('insert', { ...OLD_INSERT, decision: 'substitute' }).ok, true);
  assert.equal(validateEvent('insert', { ...OLD_INSERT, decision: 'helvetica' }).ok, false);
  assert.equal(validateEvent('insert', { ...OLD_INSERT, flips: -1 }).ok, false);
  assert.equal(validateEvent('insert', { ...OLD_INSERT, decided_live: 'yes' }).ok, false);
  const { glyph_shortfall: _g, ...noShortfall } = OLD_INSERT;
  assert.equal(validateEvent('insert', noShortfall).ok, false, 'an OLD prop stays required');
  assert.equal(validateEvent('surgery', { matched: true }).ok, false, 'no other event gained optionals');
});

// ---- 2026-10-02: the three telemetry gaps (R4 split/Ekstrak, R5 sheet close, 0a zoom) ----

test("tool_use accepts 'extract' on halaman, and old clients' actions still validate (skew)", () => {
  assert.equal(validateEvent('tool_use', { tool: 'halaman', action: 'extract' }).ok, true);
  // An enum ADDITION must not disturb what a cached client already sends.
  for (const action of ['select', 'whiteout', 'text', 'text_inline', 'signature', 'paraf', 'delete', 'pages_open', 'merge', 'arm', 'sig_modal_open']) {
    assert.equal(validateEvent('tool_use', { tool: 'halaman', action }).ok, true, action);
  }
  assert.equal(validateEvent('tool_use', { tool: 'halaman', action: 'extracted' }).ok, false);
});

test('extract_export is export-shaped but NOT export: it cannot be read as one', () => {
  assert.equal(validateEvent('extract_export', VALID_PROPS.extract_export).ok, true);
  // pages_scope uses the same two values as export's, so the rail can join them.
  assert.equal(validateEvent('extract_export', { ...VALID_PROPS.extract_export, pages_scope: 'all' }).ok, true);
  assert.equal(validateEvent('extract_export', { ...VALID_PROPS.extract_export, pages_scope: 'half' }).ok, false);
  // duration obeys the 10 ms-step law like every other duration.
  assert.equal(validateEvent('extract_export', { ...VALID_PROPS.extract_export, duration: 455 }).ok, false);
  // `export` itself is untouched: still exactly its old props, still all required.
  assert.deepEqual(Object.keys(SCHEMA.export).sort(),
    ['duration', 'fallback', 'format', 'pages_scope', 'size', 'surgery_used']);
});

test('export_sheet_close: every `how` validates, an unknown one does not, built is a bool', () => {
  for (const how of ['x', 'backdrop', 'escape', 'export', 'other']) {
    assert.equal(validateEvent('export_sheet_close', { ...VALID_PROPS.export_sheet_close, how }).ok, true, how);
  }
  assert.equal(validateEvent('export_sheet_close', { ...VALID_PROPS.export_sheet_close, how: 'back' }).ok, false);
  assert.equal(validateEvent('export_sheet_close', { ...VALID_PROPS.export_sheet_close, built: 'yes' }).ok, false);
  // waited_ms goes through durationBucket, which clamps: a sheet left open for an hour is still valid.
  const clamped = { ...VALID_PROPS.export_sheet_close, waited_ms: durationBucket(3_600_000) };
  assert.equal(clamped.waited_ms, 600000);
  assert.equal(validateEvent('export_sheet_close', clamped).ok, true);
  assert.equal(validateEvent('export_sheet_close', { ...VALID_PROPS.export_sheet_close, waited_ms: 1234 }).ok, false);
});

test('zoomBucket: the measured openings of 913eb38 each land in their own bucket', () => {
  assert.equal(zoomBucket(2.38), '200-249'); // desktop 1512px
  assert.equal(zoomBucket(1.59), '150-199'); // desktop 1040px
  assert.equal(zoomBucket(1.0), '100-149');  // tablet / small desktop
  assert.equal(zoomBucket(0.65), '60-99');   // phone
  // The cuts, from both sides, including the clamps the buttons enforce (0.3 .. 3).
  assert.equal(zoomBucket(0.3), '<60');
  assert.equal(zoomBucket(0.59), '<60');
  assert.equal(zoomBucket(0.6), '60-99');
  assert.equal(zoomBucket(0.99), '60-99');
  assert.equal(zoomBucket(1.49), '100-149');
  assert.equal(zoomBucket(1.5), '150-199');
  assert.equal(zoomBucket(2.0), '200-249');
  assert.equal(zoomBucket(2.49), '200-249');
  assert.equal(zoomBucket(2.5), '250+');
  assert.equal(zoomBucket(3), '250+');
  // The buttons step by 0.25 from an arbitrary opening, so float dust must not split a cut.
  assert.equal(zoomBucket(0.1 + 0.2 + 0.3), '60-99'); // 0.6000000000000001-ish
  for (const junk of [NaN, undefined, null, 'abc', Infinity]) {
    assert.equal(validateEvent('zoom_tap', { dir: 'in', level: zoomBucket(junk), device: 'phone' }).ok, true, String(junk));
  }
});

test('zoom_tap: dir and device are closed enums, level must be a bucket', () => {
  assert.equal(validateEvent('zoom_tap', VALID_PROPS.zoom_tap).ok, true);
  assert.equal(validateEvent('zoom_tap', { ...VALID_PROPS.zoom_tap, dir: 'up' }).ok, false);
  assert.equal(validateEvent('zoom_tap', { ...VALID_PROPS.zoom_tap, level: 2.38 }).ok, false); // a raw number is never speakable
  assert.equal(validateEvent('zoom_tap', { ...VALID_PROPS.zoom_tap, device: 'watch' }).ok, false);
});
