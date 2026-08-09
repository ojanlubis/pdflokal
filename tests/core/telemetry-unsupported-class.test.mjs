/*
 * telemetry-unsupported-class.test.mjs — WHICH KIND of character was refused,
 * without ever saying WHICH character.
 * ============================================================================
 * `failure {stage:'commit', reason:'unsupported'}` fires when a standard font
 * cannot paint something the user typed. Until 2026-08-09 that single count
 * could not tell "a few people put a 🙂 in a form" apart from "Chinese users
 * cannot use the text tool at all" — two findings with completely different
 * answers, arriving as one number.
 *
 * `class` splits them into three, and NOTHING ELSE may travel. The rail is
 * string-free by design and that is the moat: a refused character IS document
 * content — a name, a number, a symbol out of someone's file — and one leaked
 * codepoint is the same breach as a leaked string. So this file tests two
 * separate claims, and the second is the one that matters:
 *
 *   1. the three classes are actually produced for representative input, and
 *   2. NO INPUT AT ALL can put text on the rail — proved by sweeping tens of
 *      thousands of codepoints through the real chain and asserting every
 *      output is one of four fixed words. A hand-picked set of examples could
 *      only ever show that the cases someone thought of are safe.
 *
 * THE CHAIN IS TESTED WHOLE, not just the classifier: real text ->
 * core/text-encode.js's unencodableInStandardFont() -> the first offender ->
 * unsupportedCharClass() -> validateEvent(). A classifier that is correct in
 * isolation but fed the wrong character (a lone UTF-16 surrogate, say) would
 * pass a unit test of itself and mislabel every emoji in production.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { unencodableInStandardFont } from '../../js/core/text-encode.js';
import { unsupportedCharClass, validateEvent, SCHEMA } from '../../js/core/telemetry-schema.js';

const CLASSES = SCHEMA.failure.class;

// The real path js/v2/app.js takes at commit: the text the user typed, through
// the encoder's own refusal list, first offender only.
const classFor = (text) => unsupportedCharClass(unencodableInStandardFont(text)[0]);

test('the enum is exactly the three classes plus the neutral — nothing was widened by accident', () => {
  assert.deepEqual(CLASSES, ['emoji', 'cjk', 'other', 'none']);
});

test('EMOJI: representative inputs, through the real encoder chain', () => {
  // Multi-codepoint emoji matter more than the simple ones. `for…of` over a
  // string iterates CODEPOINTS, so unencodableInStandardFont yields whole
  // characters and not UTF-16 halves — if it ever splits surrogates instead,
  // bad[0] becomes a lone high surrogate (U+D800..U+DBFF) and would classify
  // 'other'. These cases are what would catch that.
  assert.equal(classFor('Terima kasih 🙂'), 'emoji');       // BMP-outside, single codepoint
  assert.equal(classFor('Selesai ✅'), 'emoji');            // Dingbats
  assert.equal(classFor('Suka ❤️ banget'), 'emoji');        // base + VARIATION SELECTOR-16
  assert.equal(classFor('Bendera 🇮🇩'), 'emoji');           // regional indicator pair
  assert.equal(classFor('Keluarga 👨‍👩‍👧'), 'emoji');          // ZWJ sequence
  assert.equal(classFor('Cuaca ☀️ cerah'), 'emoji');        // text-default pictograph
});

test('CJK: representative inputs, through the real encoder chain', () => {
  assert.equal(classFor('Nama: 中文'), 'cjk');              // Han
  assert.equal(classFor('カタカナ'), 'cjk');                 // Katakana
  assert.equal(classFor('ひらがな'), 'cjk');                 // Hiragana
  assert.equal(classFor('한글 이름'), 'cjk');                // Hangul
  assert.equal(classFor('句読点、です'), 'cjk');             // CJK punctuation
  assert.equal(classFor('全角ＡＢＣ'), 'cjk');               // fullwidth forms
});

test('OTHER: a script we simply do not cover is neither emoji nor CJK', () => {
  assert.equal(classFor('Привет'), 'other');               // Cyrillic
  assert.equal(classFor('مرحبا'), 'other');                // Arabic
  assert.equal(classFor('สวัสดี'), 'other');                  // Thai
  assert.equal(classFor('Ελληνικά'), 'other');             // Greek
  assert.equal(classFor('हिन्दी'), 'other');                   // Devanagari
});

test("NONE: text a standard font CAN paint produces no offender, and no class", () => {
  // The negative case is the one carrying information (fixture-must-distinguish):
  // a classifier that returned 'other' for everything would pass every test
  // above and fail here.
  for (const clean of ['Surat Keterangan', 'Rp1.500.000', 'café — naïve', 'A—B “quoted”', '']) {
    assert.deepEqual(unencodableInStandardFont(clean), [], `${clean} should encode cleanly`);
    assert.equal(classFor(clean), 'none');
  }
  // And the lookalike rescue still counts as clean: a thin space is REPLACED,
  // not refused, so nothing should be reported at all.
  assert.equal(classFor('Rp1 500'), 'none');
});

test('THE MOAT: no input can put text on the rail — a full codepoint sweep', () => {
  // Every BMP codepoint plus a stride through the astral planes. The claim is
  // not "these characters classify correctly" — it is that the function is
  // INCAPABLE of returning anything but the enum, whatever it is handed. That
  // is what makes "the rail is content-blind" a property rather than a promise.
  const seen = new Set();
  for (let cp = 0; cp <= 0x10ffff; cp += 1) {
    // Lone surrogates are not codepoints and String.fromCodePoint refuses
    // them; they are covered separately below, as themselves.
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    if (cp > 0xffff && cp % 7 !== 0) continue; // stride the astral planes
    const cls = unsupportedCharClass(String.fromCodePoint(cp));
    assert.ok(CLASSES.includes(cls), `codepoint U+${cp.toString(16)} produced ${JSON.stringify(cls)}`);
    seen.add(cls);
  }
  // The sweep must actually be exercising the branches, or it proves only that
  // a constant is in a list.
  assert.deepEqual([...seen].sort(), ['cjk', 'emoji', 'other'], 'the sweep did not reach all three classes');

  // Hostile shapes: a whole string (the thing that must never be passed), a
  // lone surrogate, and non-strings. All collapse to a valid enum value — and
  // critically, a STRING input can only ever be read for its FIRST codepoint,
  // so even a caller that passed the user's whole sentence by mistake could
  // not put that sentence on the rail.
  for (const hostile of ['Nama lengkap saya', '\ud800', '\udfff', 42, null, undefined, {}, [], '']) {
    const cls = unsupportedCharClass(hostile);
    assert.ok(CLASSES.includes(cls), `${JSON.stringify(hostile)} produced ${JSON.stringify(cls)}`);
    assert.ok(typeof cls === 'string' && cls.length <= 5);
  }
});

test('the event the commit path actually sends validates, and a raw character does not', () => {
  const bad = unencodableInStandardFont('Terima kasih 🙂');
  const props = {
    stage: 'commit',
    reason: 'unsupported',
    class: unsupportedCharClass(bad[0]),
    blocked: false,
  };
  assert.equal(validateEvent('failure', props).ok, true);
  assert.deepEqual(validateEvent('failure', props).clean, props);

  // The schema is the backstop, not just the call site's good manners: handing
  // it the character itself must fail the WHOLE event rather than half-record it.
  assert.equal(validateEvent('failure', { ...props, class: bad[0] }).ok, false);
  assert.equal(validateEvent('failure', { ...props, char: bad[0] }).ok, false);
});

test('blocked distinguishes the two import failures that share a stage AND a reason', () => {
  // The protected-PDF notice: the file OPENED and is fully editable.
  const notice = { stage: 'import', reason: 'encrypted', class: 'none', blocked: false };
  // The genuine decline: the file could not be opened at all.
  const decline = { stage: 'import', reason: 'encrypted', class: 'none', blocked: true };
  assert.equal(validateEvent('failure', notice).ok, true);
  assert.equal(validateEvent('failure', decline).ok, true);
  // Identical on every other axis — which is exactly why the prop had to exist.
  assert.notDeepEqual(notice, decline);
  assert.equal(notice.stage, decline.stage);
  assert.equal(notice.reason, decline.reason);
  // And it is a BOOL, so nothing free-form can ride in on it.
  assert.equal(validateEvent('failure', { ...notice, blocked: 'no' }).ok, false);
  assert.equal(validateEvent('failure', { ...notice, blocked: 0 }).ok, false);
});
