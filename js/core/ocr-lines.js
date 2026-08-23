/*
 * PDFLokal — core/ocr-lines.js  (SCAN LADDER RUNG S2 — OCR boxes → tap-able lines)
 * ============================================================================
 * Turns one Tesseract recognize() result into the SAME Line shape
 * js/v2/text-runs.js hands the editor for a born-digital page: {str, x, y, w,
 * h, size} in PAGE-SPACE PX (top-left origin, y down — the frame every
 * annotation coordinate already lives in). Once the shapes match, "tap a word
 * → cover it → retype" is the code that already ships; that is the whole of
 * what the seat spec calls "mostly UX glue once S1 exists"
 * (spec-edit-dokumen-foto.md §3, Rung S2).
 *
 * WHY THIS IS PURE AND SEPARATE FROM THE ENGINE. Everything that can be
 * silently wrong here is arithmetic — a scale divide, a confidence gate, a
 * font-size estimate — and none of it needs a worker, a WASM blob, or a DOM.
 * Splitting it out is what lets tests/core/ocr-lines.test.mjs run it under
 * `node --test` with hand-written fixtures, instead of the alternative:
 * asserting geometry through a 5 MB engine, where a wrong divide and a bad
 * recognition look identical.
 *
 * ⚠️ THE COORDINATE FACT THIS MODULE EXISTS TO GET RIGHT, stated because the
 * project already has the OTHER convention written down one file away.
 * core/ocr-layer.js (rung S1) converts the same Tesseract bbox into PDF POINTS
 * with a BOTTOM-LEFT origin, because a content stream is what it writes into.
 * This module must NOT do that. Annotations live in page-space px, top-left,
 * y down — identical to the raster the words were read off — so the whole
 * conversion is a divide by the raster's scale and NOTHING ELSE. No flip.
 * Reusing S1's bboxToPdfPoint here would put every cover the same distance
 * on the WRONG side of the page's middle, which reads as "OCR is inaccurate"
 * rather than as the frame error it is.
 *
 * Rotation and merge-normalisation are already baked in by the time we see a
 * pixel: the caller OCRs the editor's own page render (core/import.js's
 * rasterizer applies /Rotate + the user's rotation + the merge width factor),
 * so `scale` alone carries the entire px→page-space relationship. This is
 * also why the lab's own note — "a page with /Rotate set is NOT handled" —
 * does not apply to the product path.
 */

// Tesseract reports 0-100 per line. Below this, what comes back is usually
// page furniture read as text — a table rule, a scan edge, JPEG speckle —
// and each one becomes a phantom tap target sitting on top of nothing. The
// cost of dropping a real line is that a tap falls through to "nothing here";
// the cost of keeping a phantom is a cover painted over clean paper. The
// second is worse, so the gate is deliberately not generous.
const MIN_CONFIDENCE = 40;

// A box thinner or shorter than this (page-space px == points) is not a word
// anyone photographed — 2pt tall is below the smallest print in use. Purely a
// degenerate-geometry guard, the same job MIN_FONT_SIZE does in ocr-layer.js.
const MIN_BOX = 2;

// FONT SIZE FROM AN INK BOX — an ESTIMATE, and the spec says so out loud: a
// scan has no embedded font, so nothing here can be proven right the way
// core/stamp.js can prove a born-digital replacement right.
//
// Tesseract's line bbox is the INK extent — the top of the tallest glyph to
// the bottom of the lowest — not the font's em box. So the SAME box height
// means a different font size depending on WHICH LETTERS are in the line:
// "SURAT" inks only its cap height, "yang juga" inks cap-to-descender, and
// "menerus" inks barely more than its x-height. A single divisor therefore
// cannot be right for all three, and picking the mixed-case one under-sizes
// every heading on the page by about a fifth — measured on the first real
// artifact (scan-bersih.pdf's letterhead came back 10pt for a 13pt line).
//
// ⚠️ THE FIX IS A DERIVATION, NOT A BETTER CONSTANT, and that distinction is
// the point: the recognised STRING tells us which zones the line occupies.
// That is a fact about the text, not a guess about the document — so this
// asks the string, then divides by the ratio that string implies.
//
// The three numbers are ordinary Latin text-face metrics (Helvetica's, and
// close enough in every face we could substitute): caps and tall lowercase
// reach ≈0.72em above the baseline, x-height letters ≈0.53em, descenders
// ≈0.21em below it.
const CAP_TOP = 0.72;
const X_TOP = 0.53;
const DESCENDER = 0.21;

// Letters that reach the ascender line, plus digits (which are cap-height in
// most text faces). Anything else Latin sits within the x-height band.
const TALL = /[A-Z0-9ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÑÒÓÔÕÖØÙÚÛÜÝbdfhklt]/;
// Letters that drop below the baseline. The comma and semicolon are in here
// on purpose: on a line of nothing but caps, a single trailing comma is
// enough to change what the box height means.
const DEEP = /[gjpqy,;ç]/;

// How much of an em this line's INK actually spans, from the words themselves.
function inkHeightPerEm(text) {
  const top = TALL.test(text) ? CAP_TOP : X_TOP;
  const bottom = DEEP.test(text) ? DESCENDER : 0;
  return top + bottom;
}

// Matches js/v2/app.js's own clamp for a Ganti draft's font size, so a scan
// replacement and a born-digital one can never disagree about what sizes the
// editor will accept.
const MIN_SIZE = 6;
const MAX_SIZE = 120;

// The cover has to erase DESCENDERS and anti-aliased edges too, and
// Tesseract's box is tight against the ink it found. Same 6%-of-height relief
// js/v2/text-runs.js already pads its own run boxes with, for the same reason:
// a cover that stops exactly at the ink leaves a grey fringe that reads as a
// smudge rather than as a clean erase.
const PAD_RATIO = 0.06;

function boxOf(item) {
  const b = item && item.bbox;
  if (!b) return null;
  const { x0, y0, x1, y1 } = b;
  if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
  // Tesseract emits x0<x1/y0<y1, but a min/max here costs nothing and means a
  // mirrored box from some future engine can never produce a negative width
  // that silently disables every hit test on the page.
  return {
    x: Math.min(x0, x1), y: Math.min(y0, y1),
    w: Math.abs(x1 - x0), h: Math.abs(y1 - y0),
  };
}

function textOf(item) {
  const t = item && typeof item.text === 'string' ? item.text : '';
  // Tesseract terminates a line's text with '\n'; carrying that into a
  // contentEditable prefill would open the editor on a two-line draft whose
  // second line is empty.
  return t.replace(/\s+/g, ' ').trim();
}

// Words → lines, for an engine build that returns no `lines` array. Bands by
// vertical overlap of the ink boxes rather than by baseline arithmetic: OCR
// boxes are already axis-aligned (the raster was rotated before recognition),
// so "do these two boxes share most of their height" is both simpler and more
// robust than reconstructing a baseline the engine never reported.
// core/text-lines.js is NOT reused here on purpose — it clusters in raw PDF
// user space off a `pdf:{x0,y0,ux,uy,len,size}` field that a pixel box does
// not have, and synthesising one would be inventing a coordinate frame just
// to satisfy a signature.
function bandWords(words) {
  const boxes = [];
  for (const word of words) {
    const box = boxOf(word);
    const str = textOf(word);
    if (!box || !str) continue;
    boxes.push({ ...box, str, conf: Number.isFinite(word.confidence) ? word.confidence : 100 });
  }
  boxes.sort((a, b) => (a.y - b.y) || (a.x - b.x));

  const lines = [];
  for (const box of boxes) {
    const last = lines[lines.length - 1];
    // Same row when the vertical overlap covers most of the SHORTER box —
    // the smaller participant bounds the decision, the same reasoning
    // core/text-lines.js's PERP_TOLERANCE_FACTOR comment records for its own
    // band (a tall word must not license a band that swallows the line below).
    if (last) {
      const top = Math.max(last.y, box.y);
      const bottom = Math.min(last.y + last.h, box.y + box.h);
      const overlap = bottom - top;
      if (overlap > 0 && overlap >= 0.5 * Math.min(last.h, box.h)) {
        last.words.push(box);
        last.x = Math.min(last.x, box.x);
        last.y = Math.min(last.y, box.y);
        last.h = Math.max(last.y + last.h, box.y + box.h) - last.y;
        last.w = Math.max(last.x + last.w, box.x + box.w) - last.x;
        continue;
      }
    }
    lines.push({ ...box, words: [box] });
  }

  return lines.map((line) => ({
    bbox: { x0: line.x, y0: line.y, x1: line.x + line.w, y1: line.y + line.h },
    text: line.words.slice().sort((a, b) => a.x - b.x).map((w) => w.str).join(' '),
    confidence: line.words.reduce((sum, w) => sum + w.conf, 0) / line.words.length,
  }));
}

/**
 * One Tesseract recognize() result → tap-able Lines in page-space px.
 *
 * @param {object} data  the `data` half of tesseract.js's recognize() result.
 *   `data.lines` is used when the build provides it (5.x does); `data.words`
 *   is banded as a fallback so a future engine that drops line segmentation
 *   degrades to slightly worse grouping instead of to nothing.
 * @param {number} scale  raster px per page-space px — core/import.js's
 *   `page.raster.scale`, or whatever scale the OCR canvas was rendered at.
 * @returns {Array<{str: string, x: number, y: number, w: number, h: number,
 *   size: number, conf: number}>} PAGE-SPACE PX, TOP-LEFT ORIGIN. Empty array
 *   for any input this cannot read — never throws, because the caller's only
 *   sane response to a throw here would be to show nothing, which is what an
 *   empty array already does.
 */
export function ocrLinesToPageLines(data, scale) {
  if (!data || !Number.isFinite(scale) || scale <= 0) return [];

  const raw = Array.isArray(data.lines) && data.lines.length
    ? data.lines
    : bandWords(Array.isArray(data.words) ? data.words : []);

  const out = [];
  for (const item of raw) {
    const str = textOf(item);
    if (!str) continue;
    const conf = Number.isFinite(item.confidence) ? item.confidence : 100;
    if (conf < MIN_CONFIDENCE) continue;
    const box = boxOf(item);
    if (!box) continue;

    const x = box.x / scale;
    const y = box.y / scale;
    const w = box.w / scale;
    const h = box.h / scale;
    if (w < MIN_BOX || h < MIN_BOX) continue;

    const pad = h * PAD_RATIO;
    const size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(h / inkHeightPerEm(str))));

    out.push({
      str,
      x: x - pad,
      y: y - pad,
      w: w + pad * 2,
      h: h + pad * 2,
      size,
      conf,
    });
  }
  return out;
}

/**
 * The OCR scale for a page: raster px per page-space px.
 *
 * Recognition accuracy tracks PIXEL DENSITY, not screen size, so this is
 * deliberately higher than the editor's own display raster — and capped,
 * because the canvas it sizes is decoded in a phone's memory. 1800px on the
 * long edge is the density the engine was proven at in production
 * (2026-08-22: 53 words, 0 skipped, 0.7s under the live CSP), and the ×3 cap
 * keeps a small page — a photo cropped to a receipt — from being blown up
 * past the resolution its own pixels actually carry.
 * @param {number} widthPt  page width in page-space px (== points)
 */
export function ocrScaleFor(widthPt) {
  if (!Number.isFinite(widthPt) || widthPt <= 0) return 2;
  return Math.min(3, 1800 / widthPt);
}
