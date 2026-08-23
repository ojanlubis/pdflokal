/*
 * Rung S2 — OCR boxes → tap-able lines (headless).
 *
 * Pins the arithmetic that stands between a Tesseract result and a cover
 * painted on a user's scan. The whole reason core/ocr-lines.js is a separate
 * pure module is that a wrong scale divide and a bad recognition look
 * IDENTICAL through the engine — both come out as "the box is in the wrong
 * place" — so this suite drives it with hand-written boxes where the right
 * answer is arithmetic, not judgement.
 *
 * The load-bearing assertion is TEST 2: this module must NOT flip y. Its
 * sibling one directory away (core/ocr-layer.js, rung S1) converts the same
 * Tesseract bbox into PDF points with a BOTTOM-LEFT origin, and reusing that
 * conversion here is the single most likely way for this feature to ship
 * broken while looking like an accuracy problem.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ocrLinesToPageLines, ocrScaleFor } from '../../js/core/ocr-lines.js';

// One Tesseract-shaped line. Canvas px, origin top-left, y down.
function line(text, x0, y0, x1, y1, confidence = 90) {
  return { text, confidence, bbox: { x0, y0, x1, y1 } };
}

function word(text, x0, y0, x1, y1, confidence = 90) {
  return { text, confidence, bbox: { x0, y0, x1, y1 } };
}

test('1 · scale divide: canvas px become page-space px', () => {
  const out = ocrLinesToPageLines({ lines: [line('Halo', 300, 600, 500, 640)] }, 2);
  assert.equal(out.length, 1);
  // 300/2=150, 600/2=300, w=100, h=20 — then the 6% pad relief on each side.
  const pad = 20 * 0.06;
  assert.ok(Math.abs(out[0].x - (150 - pad)) < 1e-9);
  assert.ok(Math.abs(out[0].y - (300 - pad)) < 1e-9);
  assert.ok(Math.abs(out[0].w - (100 + pad * 2)) < 1e-9);
  assert.ok(Math.abs(out[0].h - (20 + pad * 2)) < 1e-9);
});

test('2 · Y IS NOT FLIPPED — a box near the TOP of the scan stays near the top', () => {
  // The regression this whole file exists for. A page 800 page-space px tall,
  // rendered at scale 2 (1600 canvas px). A line at canvas y=100 is near the
  // TOP of the page. If anyone "reuses" rung S1's bottom-left conversion,
  // this lands at y≈750 — near the BOTTOM — and every cover on every scan
  // sits mirrored about the page's middle while the words themselves read
  // perfectly, which presents as "OCR is inaccurate".
  const out = ocrLinesToPageLines({ lines: [line('Judul', 200, 100, 900, 160)] }, 2);
  assert.equal(out.length, 1);
  assert.ok(out[0].y < 100, `expected a top-of-page y, got ${out[0].y}`);
});

test('3 · low-confidence lines are dropped — a phantom cover is worse than a miss', () => {
  const out = ocrLinesToPageLines({
    lines: [line('nyata', 10, 10, 200, 40, 88), line('|||', 10, 60, 200, 90, 12)],
  }, 1);
  assert.deepEqual(out.map((l) => l.str), ['nyata']);
});

test('4 · blank and whitespace-only lines never become tap targets', () => {
  const out = ocrLinesToPageLines({
    lines: [line('   \n', 10, 10, 200, 40), line('', 10, 60, 200, 90), line('ada', 10, 110, 200, 140)],
  }, 1);
  assert.deepEqual(out.map((l) => l.str), ['ada']);
});

test("5 · Tesseract's trailing newline never reaches the editor prefill", () => {
  const out = ocrLinesToPageLines({ lines: [line('Nomor  Surat\n', 0, 0, 300, 40)] }, 1);
  assert.equal(out[0].str, 'Nomor Surat');
});

test('6 · degenerate geometry is skipped, not turned into NaN', () => {
  const out = ocrLinesToPageLines({
    lines: [
      { text: 'nobox', confidence: 99 },
      { text: 'nan', confidence: 99, bbox: { x0: 0, y0: NaN, x1: 10, y1: 10 } },
      line('hairline', 0, 0, 300, 1),
      line('nyata', 0, 20, 300, 60),
    ],
  }, 1);
  assert.deepEqual(out.map((l) => l.str), ['nyata']);
  for (const l of out) {
    for (const k of ['x', 'y', 'w', 'h', 'size']) assert.ok(Number.isFinite(l[k]), `${k} is not finite`);
  }
});

test('7 · font size is derived from WHICH LETTERS the line contains, not one constant', () => {
  // THE REGRESSION THIS PINS, seen on the first real artifact: an all-caps
  // letterhead came back 10pt for a line that was really ~13pt, because the
  // divisor assumed a descender the line does not have. Three lines, IDENTICAL
  // box height, three different right answers — a single constant cannot
  // produce all three, so a green here proves the derivation is live.
  const H = 28; // canvas px, scale 1
  const caps = ocrLinesToPageLines({ lines: [line('SURAT KETERANGAN', 0, 0, 300, H)] }, 1)[0];
  // 'bertanda' carries BOTH an ascender (b, d, t) and a descender (g) — the
  // ordinary shape of a line of Indonesian body text. ('yang juga' would not
  // do: it has a descender but no tall letter, so it is the x-height+descender
  // case, which is a fourth answer again.)
  const desc = ocrLinesToPageLines({ lines: [line('yang bertanda', 0, 0, 300, H)] }, 1)[0];
  const xOnly = ocrLinesToPageLines({ lines: [line('menerus', 0, 0, 300, H)] }, 1)[0];

  const ink = H * 1; // the pad does not enter the size calculation
  assert.equal(caps.size, Math.round(ink / 0.72));   // caps: no descender
  assert.equal(desc.size, Math.round(ink / 0.93));   // cap top + descender
  assert.equal(xOnly.size, Math.round(ink / 0.53));  // x-height only

  // All-caps must come out SMALLER-numbered than x-height-only at the same ink
  // height (more of the em is inked, so less em is needed), and the mixed line
  // sits between them. Asserted as an ORDER as well as as values: if someone
  // later re-tunes the three metrics, this still catches an inverted fix.
  assert.ok(caps.size < xOnly.size);
  assert.ok(desc.size < caps.size);

  // A single trailing comma is enough to change what the box height MEANS on
  // an otherwise all-caps line — which is why punctuation is in the descender
  // class rather than ignored as noise.
  const withComma = ocrLinesToPageLines({ lines: [line('SURAT KETERANGAN,', 0, 0, 300, H)] }, 1)[0];
  assert.ok(withComma.size < caps.size);

  // Absurd geometry clamps instead of producing a font size pdf-lib chokes on.
  const huge = ocrLinesToPageLines({ lines: [line('X', 0, 0, 100, 4000)] }, 1);
  assert.equal(huge[0].size, 120);
});

test('8 · no `lines` array: words are banded by vertical overlap', () => {
  // Two words on one row, one on the next. A build that reports only words
  // must still yield two tap targets, not three.
  const out = ocrLinesToPageLines({
    words: [
      word('Nama', 10, 100, 80, 130),
      word('Lengkap', 90, 102, 200, 132),
      word('Alamat', 10, 200, 90, 230),
    ],
  }, 1);
  assert.equal(out.length, 2);
  assert.equal(out[0].str, 'Nama Lengkap');
  assert.equal(out[1].str, 'Alamat');
  // The merged row spans both words horizontally.
  assert.ok(out[0].w > 180, `expected the row box to span both words, got w=${out[0].w}`);
});

test('9 · `lines` wins over `words` when both are present', () => {
  const out = ocrLinesToPageLines({
    lines: [line('dari lines', 0, 0, 100, 20)],
    words: [word('dari', 0, 0, 40, 20), word('words', 50, 0, 100, 20)],
  }, 1);
  assert.deepEqual(out.map((l) => l.str), ['dari lines']);
});

test('10 · unusable input returns an empty array instead of throwing', () => {
  for (const bad of [null, undefined, {}, { lines: [] }, { lines: null, words: null }]) {
    assert.deepEqual(ocrLinesToPageLines(bad, 2), []);
  }
  assert.deepEqual(ocrLinesToPageLines({ lines: [line('x', 0, 0, 10, 10)] }, 0), []);
  assert.deepEqual(ocrLinesToPageLines({ lines: [line('x', 0, 0, 10, 10)] }, NaN), []);
});

test('11 · ocrScaleFor targets ~1800px on the long edge and caps at 3', () => {
  // A4 portrait (595pt) would want 3.03x, so the cap bites there too — the
  // scale-driven branch needs a page wider than 600pt to be exercised at all.
  assert.ok(Math.abs(ocrScaleFor(842) - 1800 / 842) < 1e-9); // A4 landscape
  assert.equal(ocrScaleFor(595), 3);                          // A4 portrait: capped
  assert.equal(ocrScaleFor(200), 3);                          // a small crop: capped
  assert.equal(ocrScaleFor(0), 2);                            // degenerate: a safe default
  assert.equal(ocrScaleFor(NaN), 2);
});
