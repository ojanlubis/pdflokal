/*
 * PDFLokal — core/ocr-layer.js  (OCR RUNG — an INVISIBLE searchable text layer)
 * ============================================================================
 * Given OCR word boxes for a scanned page, writes a text layer into the PDF
 * so the page becomes searchable and selectable WITHOUT changing a single
 * pixel. This is the write side of the same fact text-visibility.js's header
 * documents: a searchable scan out of Adobe Scan/CamScanner/Drive is an image
 * with invisible text painted over it in render mode 3. We are building that
 * exact shape on purpose, for documents that don't have it yet.
 *
 * WHY CONTENT-STREAM SPLICING, NOT drawText(). pdf-lib exposes NO
 * pushOperators() and PDFPage#drawText() has no render-mode option — there is
 * no pdf-lib call that can paint text and ALSO set Tr 3. The only working
 * write path (measured, same one core/redact.js already uses to CUT ops) is:
 * read the page's Contents stream(s), decode to a latin1 string, build the
 * new content by hand, re-flate, register, and set it back — exactly
 * js/core/redact.js:169-208's pattern, run in reverse (append instead of
 * remove).
 *
 * WHY THE q...Q WRAPPER IS REQUIRED. It isolates our "3 Tr" graphics-state
 * change from the rest of the page — without it, mode 3 would leak into
 * whatever the page's OWN content stream paints next (if the scan producer's
 * stream is naively concatenated after, or if some other caller later appends
 * more content), silently making REAL text invisible too. Our show-ops sit
 * INSIDE the block, so pdf.js's operator walk still sees them AT mode 3 (q/Q
 * only bracket where the state change is scoped, not whether the ops inside
 * get walked).
 *
 * THE INVISIBILITY CONTRACT. core/text-visibility.js's pageHasVisibleText()
 * is what routes a document into Edit Teks Asli vs the scan offer (via
 * v2/text-runs.js). If our layer ever got misclassified as VISIBLE, every
 * page we touch would flip from "scan" to "has text" and Edit would open on
 * top of it — cutting show-ops that were never meant to be edited, over an
 * untouched image. That is the exact 2026-07-28 incident text-visibility.js's
 * header describes, reachable through a second door. So: Tr MUST be 3 (mode 3
 * is in text-visibility.js's INVISIBLE_RENDER_MODES), it MUST be set before
 * any show-op, and it MUST NOT be left set after our block (the Q restores
 * whatever mode the page had before us) — anything else and this module turns
 * into the bug the rest of the Edit subsystem was built to avoid.
 *
 * Pure core, same discipline as every core/ sibling: buildInvisibleTextOps has
 * zero deps (words/geometry in, an operator string out) — no DOM, no vendor
 * import. writeInvisibleTextLayer needs pdf-lib to load/save/embed a font, so
 * PDFLib is INJECTED via `deps`, never imported.
 */

import { toStandardFontSafe, unencodableInStandardFont } from './text-encode.js';

// ---- geometry / font-size --------------------------------------------------

// The em box comes straight from the OCR word's own box height — an invisible
// layer has no visual size to get "right", only a search/select footprint
// close enough that a reader who copies the selected text gets the right
// word. Floor at 1pt so a degenerate near-zero box (bad OCR geometry) can't
// produce a font size pdf-lib's Tf would choke on.
const MIN_FONT_SIZE = 1;

// ---- horizontal scale (Tz) --------------------------------------------------

// buildInvisibleTextOps is a PURE function — no PDFLib, so no
// font.widthOfTextAtSize() to learn the real glyph advances Helvetica would
// draw. We only need the drawn width to roughly match the OCR box's width (a
// selection highlight that visibly overshoots or undershoots a word looks
// broken even though nothing is painted), so approximate: assume every
// character advances by this fraction of the font size — a commonly-cited
// average for Helvetica running text — then stretch/squeeze with Tz until the
// approximate width lands on the box's actual width. Being invisible is what
// makes this acceptable: no reader ever sees the glyphs, only whether the
// SELECTED region roughly tracks the word underneath.
// PDF 32000-1 Table 106. 3 = neither fill nor stroke: the whole point.
const INVISIBLE_MODE = 3;

// ⚠️ TESTABILITY SEAM, NOT A FEATURE. The product ALWAYS writes mode 3.
// `renderMode` exists so a test can write the VISIBLE TWIN of a layer and
// prove the "this file stays invisible" assertions have power: an
// invisible-by-default writer plus a probe that can only say false would pass
// every such test while protecting nothing.
// tests/core/ocr-render-mode-guard.test.mjs fails if any product file passes
// it. Never pass it from js/v2, js/render, or a lab page.
function modeFrom(opts) {
  const m = opts && opts.renderMode;
  return Number.isInteger(m) ? m : INVISIBLE_MODE;
}

const AVG_GLYPH_WIDTH_EM = 0.5;

// Guard rails on the computed Tz percentage — never 0 (a valid but
// degenerate "collapse to a line" scale) and never large enough to produce
// an absurd operand string from a pathological word box (e.g. a single
// character OCR'd with a very wide box).
const MIN_TZ_PERCENT = 1;
const MAX_TZ_PERCENT = 1000;

// ---- WinAnsi (cp1252) single-byte encoder ----------------------------------
//
// unencodableInStandardFont() (text-encode.js) tells us a word is safe for a
// pdf-lib STANDARD font, whose encoder is WinAnsi/cp1252. But that check just
// gates WHETHER we write the word — WE still have to produce the actual PDF
// string bytes ourselves (no font.encodeText() available to a dep-free
// function), so we need our own WinAnsi encoder. ASCII (0x20-0x7e) and the
// Latin-1 supplement (0xa0-0xff) are byte-identical to their Unicode
// codepoint in cp1252, so those pass straight through. The exception is the
// 27 codepoints text-encode.js's own (private) WINANSI_SPECIALS set declares
// encodable — curly quotes, em/en dash, ellipsis, trademark, etc. — which
// live ABOVE U+00FF in Unicode but occupy cp1252's 0x80-0x9F block (the
// bytes cp1252 repurposes from the C1 control range). Get this table wrong
// and a word "unencodableInStandardFont" waved through would still come out
// as a garbage byte — silent corruption, the one failure mode this module is
// forbidden from having.
const WINANSI_C1_BYTES = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);

function winAnsiByte(codePoint) {
  if (codePoint >= 0x20 && codePoint <= 0x7e) return codePoint; // ASCII
  if (codePoint >= 0xa0 && codePoint <= 0xff) return codePoint; // Latin-1 == cp1252 here
  return WINANSI_C1_BYTES.has(codePoint) ? WINANSI_C1_BYTES.get(codePoint) : null;
}

// PDF literal-string body: backslash and unbalanced-looking parens must be
// escaped or they truncate/corrupt the string for every reader. Returns null
// if `text` carries a codepoint winAnsiByte can't place — a "can't happen"
// guard (the caller only reaches here after unencodableInStandardFont already
// cleared the word), kept because disagreeing silently with that check is
// exactly the class of bug this module exists to not have.
function escapePdfString(text) {
  let out = '';
  for (const ch of text) {
    const byte = winAnsiByte(ch.codePointAt(0));
    if (byte === null) return null;
    const c = String.fromCharCode(byte);
    out += (c === '\\' || c === '(' || c === ')') ? `\\${c}` : c;
  }
  return out;
}

// 2 decimal places: plenty of precision for a layer nothing ever paints, and
// short enough to keep the operator string small across a full-page OCR pass
// (hundreds of words).
const num = (n) => n.toFixed(2);

// ---- per-word operator block -------------------------------------------------

// One word -> its "BT ... ET" block, or null if this word should be skipped.
// Shared by buildInvisibleTextOps (which only needs the joined string) and
// writeInvisibleTextLayer (which needs to COUNT what got skipped) so the two
// never risk disagreeing about what "skip" means — two call sites computing
// the same decision two different ways is the exact drift class this
// project's memory bank already has a name for.
function opsForWord(word, fontRes) {
  if (!word || typeof word.text !== 'string') return null;
  const { x, y, w, h } = word;
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;

  if (unencodableInStandardFont(word.text).length > 0) return null;
  const safeText = toStandardFontSafe(word.text);
  if (!safeText) return null; // e.g. a box whose "text" was purely a zero-width mark

  const escaped = escapePdfString(safeText);
  if (escaped === null) return null;

  const fontSize = Math.max(MIN_FONT_SIZE, h);
  const naturalWidth = safeText.length * fontSize * AVG_GLYPH_WIDTH_EM;
  const scalePercent = Math.min(MAX_TZ_PERCENT, Math.max(MIN_TZ_PERCENT, (w / naturalWidth) * 100));

  return [
    'BT',
    `/${fontRes} ${num(fontSize)} Tf`,
    `1 0 0 1 ${num(x)} ${num(y)} Tm`,
    `${num(scalePercent)} Tz`,
    `(${escaped}) Tj`,
    'ET',
  ].join('\n');
}

// Builds both the joined ops string AND the written/skipped counts in one
// pass over `words` — the single source both exported entry points read
// from, per opsForWord's own header note.
function buildOpsAndCounts(words, fontRes, renderMode = INVISIBLE_MODE) {
  const list = Array.isArray(words) ? words : [];
  let written = 0;
  let skipped = 0;
  const blocks = [];
  for (const word of list) {
    const block = fontRes ? opsForWord(word, fontRes) : null;
    if (block) { blocks.push(block); written += 1; } else { skipped += 1; }
  }
  const ops = blocks.length ? `q\n${renderMode} Tr\n${blocks.join('\n')}\nQ` : '';
  return { ops, written, skipped };
}

/**
 * Build the invisible-text-layer operator string for one page's OCR words.
 * Pure: no DOM, no vendor imports. Never throws — a word this can't safely
 * encode is silently skipped (see opsForWord), not a reason to fail the
 * whole page.
 * @param {Array<{text: string, x: number, y: number, w: number, h: number}>} words
 *   PDF POINTS, origin BOTTOM-LEFT (core/export.js's coordinate convention),
 *   y = the box's baseline-ish bottom.
 * @param {{fontRes: string}} opts  fontRes is the page /Resources font key,
 *   WITHOUT the leading slash (e.g. 'F-ocr').
 * @returns {string} a content-stream operator string, wrapped in q...Q, empty
 *   string if every word was skipped.
 */
export function buildInvisibleTextOps(words, opts) {
  const fontRes = opts && opts.fontRes;
  return buildOpsAndCounts(words, fontRes, modeFrom(opts)).ops;
}

// ---- content-stream append (same read/write shape as redact.js) -----------

// Contents may be one stream or an array of streams — decode ALL, join (PDF
// 32000 7.8.2 treats multiple streams as logically one), APPEND our block,
// write back as ONE. Identical decode/encode shape to
// core/redact.js:169-208's removeRunsFromPdfPage; the only difference is
// append instead of edit-in-place. We append rather than prepend because
// whatever produced this PDF already painted the scan image as this page's
// original content — core/page-surgery.js's surgery-before-draw ordering
// rule is the same idea one level up (cut/draw before any OTHER caller's
// content, never reorder against content that must stay first).
function appendToPageContents(pdfPage, PDFLib, ops) {
  const { PDFArray, PDFName, PDFRawStream, decodePDFRawStream } = PDFLib;
  const context = pdfPage.doc.context;
  const contents = pdfPage.node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  const latin1 = (u8) => Array.from(u8, (b) => String.fromCharCode(b)).join('');
  const parts = refs.map((r) => {
    const s = context.lookup(r);
    return latin1(s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents());
  });
  const combined = `${parts.join('\n')}\n${ops}`;
  const bytesOf = (str) => Uint8Array.from(str, (c) => c.charCodeAt(0));
  const newStream = context.flateStream(bytesOf(combined));
  pdfPage.node.set(PDFName.of('Contents'), context.register(newStream));
}

/**
 * Write an invisible searchable-text layer into `pdfBytes` for the given
 * pages. Never throws on a per-word problem (see opsForWord) — an entire
 * page is only skipped if `pageIndex` doesn't resolve to a real page, so one
 * bad entry can't sink every other page's layer.
 * @param {Uint8Array} pdfBytes
 * @param {Array<{pageIndex: number, words: Array}>} pages
 * @param {{PDFLib: object}} deps
 * @returns {Promise<{bytes: Uint8Array, written: number, skipped: number}>}
 */
export async function writeInvisibleTextLayer(pdfBytes, pages, deps, opts) {
  const { PDFLib } = deps;
  const renderMode = modeFrom(opts);
  const { PDFDocument, StandardFonts } = PDFLib;

  const doc = await PDFDocument.load(pdfBytes);
  // Embedded ONCE for the whole document. Helvetica is a pdf-lib STANDARD
  // font (no bytes to embed), but the font dictionary object this creates is
  // still one shared indirect object — every touched page just registers its
  // OWN /Resources entry pointing at the same font.ref (see
  // newFontDictionary below); re-embedding per page would create duplicate
  // objects for the identical font.
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pdfPages = doc.getPages();

  let written = 0;
  let skipped = 0;

  for (const entry of Array.isArray(pages) ? pages : []) {
    const pdfPage = pdfPages[entry && entry.pageIndex];
    if (!pdfPage) continue; // an out-of-range pageIndex must not sink every OTHER page's layer

    // newFontDictionary registers our font in THIS page's own /Resources and
    // hands back the PDFName it actually chose (a page that already has an
    // /F1 resource gets /F2, etc.) — never assume a fixed name, always read
    // it back and strip the leading '/' for the bare resource name our
    // hand-written /Res Tf operand needs.
    const fontKey = pdfPage.node.newFontDictionary(font.name, font.ref);
    const fontRes = fontKey.toString().replace(/^\//, '');

    const { ops, written: pageWritten, skipped: pageSkipped } = buildOpsAndCounts(entry && entry.words, fontRes, renderMode);
    written += pageWritten;
    skipped += pageSkipped;
    if (!ops) continue; // nothing survived for this page -- leave its Contents untouched

    appendToPageContents(pdfPage, PDFLib, ops);
  }

  const bytes = await doc.save({ useObjectStreams: true });
  return { bytes, written, skipped };
}
