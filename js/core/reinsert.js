/*
 * PDFLokal — core/reinsert.js  (RUNG C — native re-insert, pdf-lib ADAPTER)
 * ============================================================================
 * Rung B (redact.js) proves it can CUT a matched run's show-text ops out of a
 * page's content stream. Rung C is the other half: writing the REPLACEMENT
 * text back in with the document's OWN embedded font, as a real show-text op
 * in the content stream — not a drawn annotation on top. Founder ruling
 * (2026-07-19, seat decisions.md): only do this when we can PROVE the
 * replacement's glyphs are covered by that exact font program; otherwise the
 * caller (core/export.js) falls back to today's metric-twin annotation.
 * Never guess a substitute font.
 *
 * Same vendor-injection discipline as redact.js: PDFLib and fontkit are
 * passed in by the caller — this file has zero vendor imports.
 *
 * v1 SCOPE (deliberately narrow — each exclusion returns a distinct `reason`
 * instead of guessing or throwing):
 *   - Only Type0 fonts with Encoding NAME /Identity-H (CID = GID, the shape
 *     pdf-lib's own custom-font embedding produces). Simple fonts (Type1/
 *     TrueType, incl. standard-14 with no embedded program), Identity-V, and
 *     CMap-stream encodings are all "unsupported-font" — declined, not forced.
 *   - Single-line replacements only (a newline can't reuse one run's single
 *     baseline geometry).
 *   - No mixed-font runs (the walk's `insert.mixedFonts` flag) — one font or
 *     decline.
 *   - No shaping: each codepoint maps to ITS OWN glyph one at a time. That is
 *     exactly how pdf-lib's own drawText paints Latin text today (no ligature/
 *     kerning-pair substitution), so this is not a regression for the fonts
 *     this path targets — just not a general text-shaping engine.
 */

// ---- shared little helpers ---------------------------------------------------

// Same ambiguity redact.js resolves: a dict/array VALUE is either a direct
// object or an indirect PDFRef — only a runtime check tells them apart.
function resolve(context, PDFRef, value) {
  return value instanceof PDFRef ? context.lookup(value) : value;
}

// PDF number literal: ≤4 decimals, trailing zeros (and a bare trailing '.')
// stripped — same convention as text-walk.js's replacementFor.
function fmtNum(n) {
  let v = Math.round(n * 10000) / 10000;
  if (Object.is(v, -0)) v = 0;
  let s = String(v);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

function hexToRgb01(hex) {
  const h = (hex || '#000000').replace('#', '');
  return [
    Number.parseInt(h.slice(0, 2), 16) / 255,
    Number.parseInt(h.slice(2, 4), 16) / 255,
    Number.parseInt(h.slice(4, 6), 16) / 255,
  ];
}

// PDF name syntax (32000 7.3.5): any byte that isn't a "regular" printable
// ASCII character, OR one of the delimiters (incl. '#' itself, the escape
// char), must be written as #XX (two hex digits) so the name round-trips.
// redact.js's font-name extraction runs content-stream.js's decodeName,
// which UN-escapes #XX back to the raw byte — so a name pulled off a Tf
// operand may need exactly this re-escaping to go back into a content stream.
const NAME_DELIMS = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%', '#']);
function escapeNameForWrite(name) {
  let out = '';
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (code > 0xff) return null; // not representable as a single PDF name byte
    if (code < 0x21 || code > 0x7e || NAME_DELIMS.has(name[i])) {
      out += `#${code.toString(16).padStart(2, '0')}`;
    } else {
      out += name[i];
    }
  }
  return out;
}

// ---- font program extraction ---------------------------------------------------

// Pull the raw embedded font PROGRAM bytes for `fontName` (a page Resources
// /Font key, no leading '/') out of the page — v1 scope: Type0/Identity-H
// only (see module header). Returns { ok:true, bytes } or { ok:false, reason }
// — never throws (the caller wraps in try/catch anyway as a second layer,
// since a malformed dict can still throw INSIDE this function's own gets).
function extractFontProgram(page, PDFLib, fontName) {
  const { PDFName, PDFDict, PDFRef, PDFRawStream, decodePDFRawStream } = PDFLib;
  const context = page.doc.context;
  const res = (v) => resolve(context, PDFRef, v);

  const resources = page.node.Resources();
  if (!resources) return { ok: false, reason: 'unsupported-font' };
  const fontDictRaw = resources.get(PDFName.of('Font'));
  if (!fontDictRaw) return { ok: false, reason: 'unsupported-font' };
  const fontDict = res(fontDictRaw);
  if (!(fontDict instanceof PDFDict)) return { ok: false, reason: 'unsupported-font' };

  const fontObjRaw = fontDict.get(PDFName.of(fontName));
  if (!fontObjRaw) return { ok: false, reason: 'unsupported-font' };
  const fontObj = res(fontObjRaw);

  const subtype = res(fontObj.get(PDFName.of('Subtype')));
  if (!(subtype instanceof PDFName) || subtype.toString() !== '/Type0') {
    return { ok: false, reason: 'unsupported-font' };
  }
  const encoding = res(fontObj.get(PDFName.of('Encoding')));
  if (!(encoding instanceof PDFName) || encoding.toString() !== '/Identity-H') {
    return { ok: false, reason: 'unsupported-font' };
  }

  const descendantsRaw = fontObj.get(PDFName.of('DescendantFonts'));
  if (!descendantsRaw) return { ok: false, reason: 'unsupported-font' };
  const descendants = res(descendantsRaw);
  const desc0 = res(descendants.asArray()[0]);

  const fdRaw = desc0.get(PDFName.of('FontDescriptor'));
  if (!fdRaw) return { ok: false, reason: 'unsupported-font' };
  const fd = res(fdRaw);

  // FontFile2 (TrueType/OpenType-TT glyf outlines) or FontFile3 (CFF /
  // OpenType-CFF) — either is a real font PROGRAM fontkit can parse.
  // Standard-14 fonts (no embedded program at all) carry neither: that's the
  // normal "decline, don't guess" shape, not malformed input.
  const streamRaw = fd.get(PDFName.of('FontFile2')) || fd.get(PDFName.of('FontFile3'));
  if (!streamRaw) return { ok: false, reason: 'unsupported-font' };
  const stream = res(streamRaw);
  if (!(stream instanceof PDFRawStream)) return { ok: false, reason: 'unsupported-font' };

  const bytes = decodePDFRawStream(stream).decode();
  return { ok: true, bytes };
}

// ---- the plan ---------------------------------------------------------------

// req: { insert (text-walk.js's per-target insert block), text, color }
// → { ok:true, snippet, width } | { ok:false, reason }
export function planNativeInsert(page, PDFLib, fontkit, req) {
  const { insert, color } = req;
  const text = req.text ?? '';

  // Guards first, in this order — each is a distinct, honest decline, never a
  // throw and never a silent best-effort substitution.
  if (insert.mixedFonts) return { ok: false, reason: 'mixed-fonts' };
  if (text.includes('\n')) return { ok: false, reason: 'multiline' };
  if (text.length === 0) return { ok: false, reason: 'empty' };

  let extracted;
  try {
    extracted = extractFontProgram(page, PDFLib, insert.fontName);
  } catch (_err) {
    return { ok: false, reason: 'font-parse-failed' };
  }
  if (!extracted.ok) return extracted;

  let font;
  try {
    // fontkit.create wants the raw font-program bytes. Verified empirically
    // (Node harness against tests/fixtures/nasty/undangan-cid.pdf's embedded
    // Montserrat FontFile2): a plain Uint8Array works directly — this
    // vendored build's internal `Buffer.from(bytes)` shim accepts it without
    // needing a real Node Buffer, so no extra wrapping is needed in-browser.
    font = fontkit.create(extracted.bytes);
  } catch (_err) {
    return { ok: false, reason: 'font-parse-failed' };
  }

  // Coverage: every non-space char must have a real glyph. Spaces are exempt
  // — a subset font built from one run's characters often has NO space glyph
  // at all (nothing to render), and PDF word gaps are TJ kern advances, not
  // painted glyphs, so a missing space glyph is not a coverage failure.
  for (const ch of text) {
    if (ch === ' ') continue;
    if (!font.hasGlyphForCodePoint(ch.codePointAt(0))) return { ok: false, reason: 'missing-glyph' };
  }

  const escapedName = escapeNameForWrite(insert.fontName);
  if (escapedName === null) return { ok: false, reason: 'font-name-unwritable' };

  const unitsPerEm = font.unitsPerEm;
  // WHY the 0.28em fallback: same subset reality as above — if there's truly
  // no space glyph to measure, 0.28em approximates a typical Latin
  // proportional space. This only feeds a TJ kern (a positioning nudge for a
  // gap), never a rendered glyph, so an approximate width has no visible
  // artifact.
  const spaceAdvance = font.hasGlyphForCodePoint(32)
    ? font.glyphForCodePoint(32).advanceWidth
    : 0.28 * unitsPerEm;

  // Walk the text char by char (no shaping — see module header): consecutive
  // non-space glyphs accumulate into one hex run; each space closes the
  // current hex run and inserts a TJ kern number instead of a glyph.
  const tjParts = [];
  let hexRun = '';
  let widthUnits = 0; // glyph-space units (÷unitsPerEm × size == user-space points)
  const flushHex = () => {
    if (hexRun) { tjParts.push(`<${hexRun}>`); hexRun = ''; }
  };
  for (const ch of text) {
    if (ch === ' ') {
      flushHex();
      const kern = -Math.round((spaceAdvance / unitsPerEm) * 1000);
      tjParts.push(String(kern));
      widthUnits += spaceAdvance;
    } else {
      const glyph = font.glyphForCodePoint(ch.codePointAt(0));
      hexRun += glyph.id.toString(16).padStart(4, '0');
      widthUnits += glyph.advanceWidth;
    }
  }
  flushHex();

  const width = (widthUnits / unitsPerEm) * insert.size;
  const [r, g, b] = hexToRgb01(color);

  // Positioning reproduces the removed op's observed rendering matrix
  // EXACTLY: Tf is set to 1 and the size is folded into Tm instead, because
  // `insert.{x,y,ux,uy,size}` (from text-walk.js's walkShowOps) already IS the
  // full text rendering matrix decomposed into direction + magnitude — piping
  // that straight into Tm with Tf=1 avoids re-deriving the original Tf size /
  // Tm scale split, which the walk never needed to know separately.
  const a = fmtNum(insert.size * insert.ux);
  const bC = fmtNum(insert.size * insert.uy);
  const c = fmtNum(-insert.size * insert.uy);
  const d = fmtNum(insert.size * insert.ux);
  const x = fmtNum(insert.x);
  const y = fmtNum(insert.y);

  const snippet = `q BT /${escapedName} 1 Tf ${fmtNum(r)} ${fmtNum(g)} ${fmtNum(b)} rg `
    + `${a} ${bC} ${c} ${d} ${x} ${y} Tm [${tjParts.join(' ')}] TJ ET Q`;

  return { ok: true, snippet, width };
}

// Append `snippet` as a NEW content stream on the page. MUST run before any
// pdf-lib draw call touches this page: pdf-lib's own first drawXxx() call
// also appends a stream onto Contents, and while an append-after-append
// composes fine (verified empirically — a later drawRectangle after this
// append still landed as its own trailing stream, order preserved, nothing
// clobbered), the caller (core/export.js) guarantees this runs first anyway
// so that guarantee is never actually exercised in production.
export function appendNativeText(page, PDFLib, snippet) {
  const { PDFArray, PDFName } = PDFLib;
  const context = page.doc.context;
  const bytesOf = (str) => Uint8Array.from(str, (ch) => ch.charCodeAt(0));
  const newRef = context.register(context.flateStream(bytesOf(snippet)));

  // Contents may already be a direct array (multiple streams) or a single
  // stream/ref — normalize to an array so the snippet becomes ANOTHER stream,
  // painted after everything already on the page. Same read shape redact.js
  // uses for the same ambiguity.
  const existing = page.node.Contents();
  let arr;
  if (existing instanceof PDFArray) {
    arr = existing;
  } else {
    arr = PDFArray.withContext(context);
    arr.push(page.node.get(PDFName.of('Contents'))); // raw (possibly a ref) — not the dereferenced value
  }
  arr.push(newRef);
  page.node.set(PDFName.of('Contents'), arr);
}
