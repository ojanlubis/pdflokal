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
 *
 * RUNG C+ EXTENSION (2026-07-19 — founder field test on a real Word-made PDF):
 * Word does not write Type0/Identity-H — it writes a SIMPLE /Subtype
 * /TrueType font, code-keyed (not CID-keyed), with /Encoding the NAME
 * /WinAnsiEncoding and /FirstChar+/Widths declaring advances. v1's whole
 * pipeline (hex-glyph-id CID strings, /W-array widths) doesn't apply to that
 * shape at all — it needs its own byte-encoded path, added alongside v1
 * without touching it:
 *   - Font dict test: /Subtype /TrueType (not Type0). /Encoding must be the
 *     bare NAME /WinAnsiEncoding — a /Differences dict, /MacRomanEncoding, or
 *     no /Encoding at all is a genuinely different byte table we don't know,
 *     declined as 'unsupported-encoding' (new reason, same discipline).
 *   - Every replacement char must round-trip to ONE WinAnsi byte (PDF 32000
 *     Annex D.2) AND that font's own program must have a real glyph for it
 *     (fontkit hasGlyphForCodePoint) — either failure declines
 *     'missing-glyph', same as v1's coverage guard.
 *   - Advances come from /FirstChar+/Widths (code-keyed, same shape
 *     core/redact.js's extractFontMetrics already reads for the CUT side);
 *     a byte outside that declared range with no /MissingWidth to fall back
 *     on declines 'unsupported-font' — writing a 0-width glyph would corrupt
 *     the layout, not just mis-trust a position like the read-only reader may.
 *   - The show op is a literal string of real encoded BYTES (Tj), not a
 *     hex-glyph-id TJ run — WinAnsi bytes ARE character codes for this font,
 *     so there's no subset-glyph-id indirection and no need for the CID
 *     path's space-as-kern trick (this path's space is a real, provable,
 *     0x20 byte with its own declared /Widths advance).
 */

// ---- shared little helpers ---------------------------------------------------

// Same ambiguity redact.js resolves: a dict/array VALUE is either a direct
// object or an indirect PDFRef — only a runtime check tells them apart.
function resolve(context, PDFRef, value) {
  return value instanceof PDFRef ? context.lookup(value) : value;
}

// PDF number literal: ≤4 decimals, trailing zeros (and a bare trailing '.')
// stripped — same convention as text-walk.js's replacementFor.
export function fmtNum(n) {
  let v = Math.round(n * 10000) / 10000;
  if (Object.is(v, -0)) v = 0;
  let s = String(v);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

export function hexToRgb01(hex) {
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
export function escapeNameForWrite(name) {
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

// ---- Word-shape (simple TrueType) helpers --------------------------------------

// PDF 32000-1:2008 Annex D.2 WinAnsiEncoding, unicode codepoint -> byte.
// ASCII 0x20-0x7E is a straight identity mapping (checked separately below,
// no table lookup needed). 0xA0-0xFF mirrors the Latin-1 supplement
// byte-for-byte (also identity — built with a loop, not typed out, since
// "byte === codepoint" is exactly what it says). 0x80-0x9F is the genuinely
// NONOBVIOUS part: CP1252's overlay of curly quotes, dashes, the Euro sign,
// etc. — the ~27 entries below, listed explicitly. Five codes in that range
// (0x81, 0x8D, 0x8F, 0x90, 0x9D) are undefined in WinAnsiEncoding — no entry,
// so a char that maps to one of those codepoints correctly falls through to
// "not encodable" rather than us inventing a byte for it.
const WINANSI_CP1252_OVERLAY = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84],
  [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88],
  [0x2030, 0x89], [0x0160, 0x8a], [0x2039, 0x8b], [0x0152, 0x8c],
  [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92], [0x201c, 0x93],
  [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b],
  [0x0153, 0x9c], [0x017e, 0x9e], [0x0178, 0x9f],
]);
const WINANSI_UNICODE_TO_BYTE = new Map(WINANSI_CP1252_OVERLAY);
for (let byte = 0xa0; byte <= 0xff; byte += 1) WINANSI_UNICODE_TO_BYTE.set(byte, byte);

// A codepoint's WinAnsi byte, or undefined when WinAnsiEncoding simply has no
// byte for it (a genuine "can't encode this", not something to guess around).
function winAnsiByteFor(codepoint) {
  if (codepoint >= 0x20 && codepoint <= 0x7e) return codepoint;
  return WINANSI_UNICODE_TO_BYTE.get(codepoint);
}

// PDF literal-string byte escaping (32000 7.3.4.2). '\', '(' and ')' would
// otherwise corrupt or prematurely close the '(...)' body; every byte outside
// printable ASCII — control bytes below 0x20, and 0x7F upward, which is where
// this path's whole Latin-1-supplement half (accented Latin, curly
// punctuation) lives — gets the spec's own 1-3 digit octal \nnn escape
// instead of a raw byte. 0x20 (space) is left as a real byte on purpose (see
// module header: no TJ-kern trick on this path).
function encodeLiteralStringBytes(bytes) {
  let out = '';
  for (const byte of bytes) {
    if (byte === 0x5c) out += '\\\\';
    else if (byte === 0x28) out += '\\(';
    else if (byte === 0x29) out += '\\)';
    else if (byte < 0x20 || byte > 0x7e) out += `\\${byte.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(byte);
  }
  return out;
}

// /FirstChar + /Widths (code-keyed) — same shape core/redact.js's
// parseSimpleFont already reads for the CUT side, but that reader is
// read-only positioning (a missing entry safely degrades to 0/"untrusted").
// Writing a brand-new show op can't take that shortcut: a byte with no
// declared width and no /MissingWidth fallback must decline outright, not
// silently paint at 0 width. Returns { widths: Map<byte,width>, missingWidth }
// (missingWidth is `null`, not 0, when the FontDescriptor carries none — the
// caller tells "no fallback" and "font declares 0" apart) or `null` when
// there's no /Widths (or no /FirstChar to anchor it) to read at all.
function readSimpleFontWidths(fontObj, context, PDFLib) {
  const { PDFName, PDFRef } = PDFLib;
  const res = (v) => resolve(context, PDFRef, v);

  const widthsRaw = fontObj.get(PDFName.of('Widths'));
  const firstCharRaw = fontObj.get(PDFName.of('FirstChar'));
  if (!widthsRaw || !firstCharRaw) return null;

  const firstChar = res(firstCharRaw).asNumber();
  const widthsArr = res(widthsRaw).asArray();
  const widths = new Map();
  widthsArr.forEach((w, i) => widths.set(firstChar + i, res(w).asNumber()));

  let missingWidth = null;
  const fdRaw = fontObj.get(PDFName.of('FontDescriptor'));
  if (fdRaw) {
    const fd = res(fdRaw);
    const mwRaw = fd.get(PDFName.of('MissingWidth'));
    if (mwRaw) missingWidth = res(mwRaw).asNumber();
  }
  return { widths, missingWidth };
}

// ---- font program extraction ---------------------------------------------------

// Shared page/Resources/Font walk: resolve `fontName` (a page Resources
// /Font key, no leading '/') down to its font dict object, or `null` if
// anything along the way is missing/wrong-shaped. Both extractFontProgram
// (the embedded PROGRAM bytes) and planNativeInsert's simple-TrueType guards
// (which need the DICT itself — /Subtype, /Encoding, /Widths) walk this same
// path; this is the one place that walk lives.
export function lookupFontObject(page, PDFLib, fontName) {
  const { PDFName, PDFDict, PDFRef } = PDFLib;
  const context = page.doc.context;
  const res = (v) => resolve(context, PDFRef, v);

  const resources = page.node.Resources();
  if (!resources) return null;
  const fontDictRaw = resources.get(PDFName.of('Font'));
  if (!fontDictRaw) return null;
  const fontDict = res(fontDictRaw);
  if (!(fontDict instanceof PDFDict)) return null;

  const fontObjRaw = fontDict.get(PDFName.of(fontName));
  if (!fontObjRaw) return null;
  return res(fontObjRaw);
}

// Pull the raw embedded font PROGRAM bytes for `fontName` out of the page —
// Type0/Identity-H (v1) OR a simple /Subtype /TrueType font (the Word shape,
// see module header): either way, the FontDescriptor's FontFile2 (TrueType
// glyf) or FontFile3 (CFF/OpenType-CFF) is a real program fontkit can parse.
// A simple font's FontDescriptor sits directly on the font dict; a Type0
// font's sits one level down, on its sole DescendantFont. Anything else —
// standard-14 (no embedded program), a Type1 font's raw FontFile, any other
// /Subtype — is "unsupported-font": a genuine decline, not malformed input.
// Returns { ok:true, bytes } or { ok:false, reason } — never throws (the
// caller wraps in try/catch anyway as a second layer, since a malformed dict
// can still throw INSIDE this function's own gets).
// EXPORTED (Rung C live-font-preview, 2026-07-19): js/v2/app.js needs this at
// draft-open time too — a DRY RUN against the SOURCE page purely to learn
// whether the tapped line's font has a real program to load into the browser
// via FontFace, before any cut/insert ever happens. Same function, same
// guarantees (never throws, ok:false is a decline never a guess); no logic
// changed for the export path that already called it.
export function extractFontProgram(page, PDFLib, fontName) {
  const { PDFName, PDFRef, PDFRawStream, decodePDFRawStream } = PDFLib;
  const context = page.doc.context;
  const res = (v) => resolve(context, PDFRef, v);

  const fontObj = lookupFontObject(page, PDFLib, fontName);
  if (!fontObj) return { ok: false, reason: 'unsupported-font' };

  const readProgram = (fd) => {
    if (!fd) return null;
    const streamRaw = fd.get(PDFName.of('FontFile2')) || fd.get(PDFName.of('FontFile3'));
    if (!streamRaw) return null;
    const stream = res(streamRaw);
    if (!(stream instanceof PDFRawStream)) return null;
    return decodePDFRawStream(stream).decode();
  };

  const subtype = res(fontObj.get(PDFName.of('Subtype')));
  const subtypeName = subtype instanceof PDFName ? subtype.toString() : '';

  if (subtypeName === '/TrueType') {
    const fdRaw = fontObj.get(PDFName.of('FontDescriptor'));
    const bytes = readProgram(fdRaw ? res(fdRaw) : null);
    if (!bytes) return { ok: false, reason: 'unsupported-font' };
    return { ok: true, bytes };
  }

  if (subtypeName !== '/Type0') return { ok: false, reason: 'unsupported-font' };

  const encoding = res(fontObj.get(PDFName.of('Encoding')));
  if (!(encoding instanceof PDFName) || encoding.toString() !== '/Identity-H') {
    return { ok: false, reason: 'unsupported-font' };
  }

  const descendantsRaw = fontObj.get(PDFName.of('DescendantFonts'));
  if (!descendantsRaw) return { ok: false, reason: 'unsupported-font' };
  const descendants = res(descendantsRaw);
  const desc0 = res(descendants.asArray()[0]);

  const fdRaw = desc0.get(PDFName.of('FontDescriptor'));
  const bytes = readProgram(fdRaw ? res(fdRaw) : null);
  if (!bytes) return { ok: false, reason: 'unsupported-font' };
  return { ok: true, bytes };
}

// ---- the plan: simple TrueType (Word shape) ----------------------------------

// Does `cp` map to a glyph that will ACTUALLY PAINT in this program?
// hasGlyphForCodePoint alone is NOT enough: a SUBSET font's cmap can LIE — it
// keeps a full-font entry for a codepoint whose outline the subset dropped or
// re-indexed, so the glyph resolves to .notdef or an EMPTY contour and bakes
// as INVISIBLE text. (Founder's org-structure.pdf, 2026-07-22: 's' never
// appears in "(Berlaku 01 Maret 2026)", so the F2 subset has no real 's'
// glyph, yet hasGlyphForCodePoint('s') returned true and native-insert painted
// nothing.) Require a real, non-empty outline. Space (cp 32) legitimately has
// no outline and is handled by its caller (exempt / kern), so it's accepted as
// long as the cmap covers it. Never throws — any fontkit quirk = "won't paint".
function glyphPaints(font, cp) {
  if (!font.hasGlyphForCodePoint(cp)) return false;
  if (cp === 32) return true; // space: valid without contours
  try {
    const g = font.glyphForCodePoint(cp);
    if (!g || g.id === 0) return false; // .notdef
    const cmds = g.path && g.path.commands;
    return Array.isArray(cmds) && cmds.length > 0;
  } catch {
    return false;
  }
}

// The page's residual CTM (text-walk's endCTM, on insert.baseCTM) is in effect
// when appendNativeText's snippet runs — so our ABSOLUTE Tm (which already IS the
// original run's device-space matrix) would be transformed by it a SECOND time
// (PowerPoint/Word exports carry a base `cm` that persists to end-of-content).
// Return the `<R⁻¹> cm ` string to prepend right after the snippet's own `q`,
// cancelling that CTM to identity for OUR text only — the trailing `Q` restores
// it, so pdf-lib's later draws see the same state as before. '' when the CTM is
// already identity (the common case, incl. undangan-cid — a true no-op); null
// when it's singular (unrecoverable — the caller declines to the twin).
export function neutralizeCTMPrefix(baseCTM) {
  if (!Array.isArray(baseCTM) || baseCTM.length !== 6) return '';
  const [a, b, c, d, e, f] = baseCTM;
  if (a === 1 && b === 0 && c === 0 && d === 1 && e === 0 && f === 0) return '';
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null; // singular — can't invert
  const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
  const ie = (c * f - d * e) / det, iff = (b * e - a * f) / det;
  return `${fmtNum(ia)} ${fmtNum(ib)} ${fmtNum(ic)} ${fmtNum(id)} ${fmtNum(ie)} ${fmtNum(iff)} cm `;
}

// The Rung C+ counterpart of planNativeInsert's v1 body below, for a font
// dict already proven /Subtype /TrueType. Same return shape, same
// never-throw-past-this discipline; declines in the exact order the module
// header lists: encoding shape, then per-char WinAnsi encodability, then
// per-char glyph existence, then advance widths.
function planSimpleTrueTypeInsert(fontObj, context, PDFLib, fontkit, extracted, insert, color, text) {
  const { PDFName, PDFRef } = PDFLib;
  const res = (v) => resolve(context, PDFRef, v);

  // Only the bare NAME /WinAnsiEncoding is a byte table we actually know. A
  // /Differences dict remaps individual codes away from it, /MacRomanEncoding
  // is a different table entirely, and no /Encoding at all means "whatever
  // this font's built-in cmap says" (font-specific, opaque to us) — all three
  // are a genuine unknown, never guessed at.
  const encoding = res(fontObj.get(PDFName.of('Encoding')));
  if (!(encoding instanceof PDFName) || encoding.toString() !== '/WinAnsiEncoding') {
    return { ok: false, reason: 'unsupported-encoding' };
  }

  // Every char needs ONE WinAnsi byte to become part of the show string. A
  // char WinAnsiEncoding has no byte for at all can't be written on this
  // path — same practical effect as v1's coverage decline (this glyph can't
  // be painted), so it reuses 'missing-glyph' rather than inventing a
  // separate reason for what the caller experiences identically.
  const bytes = [];
  for (const ch of text) {
    const byte = winAnsiByteFor(ch.codePointAt(0));
    if (byte === undefined) return { ok: false, reason: 'missing-glyph' };
    bytes.push(byte);
  }

  let font;
  try {
    // Same fontkit.create contract v1 relies on (see its own comment below) —
    // a plain Uint8Array of the extracted program bytes.
    font = fontkit.create(extracted.bytes);
  } catch (_err) {
    return { ok: false, reason: 'font-parse-failed' };
  }

  // WinAnsi encodability (above) only proves the BYTE exists in the table —
  // it says nothing about whether THIS embedded program actually drew a
  // glyph for that codepoint (a font can legally omit glyphs it never uses).
  // No space exemption here (unlike v1): this path has no subset-CID reality
  // to work around, so a space glyph is checked and proven like anything
  // else.
  for (const ch of text) {
    if (!glyphPaints(font, ch.codePointAt(0))) return { ok: false, reason: 'missing-glyph' };
  }

  const widthInfo = readSimpleFontWidths(fontObj, context, PDFLib);
  if (!widthInfo) return { ok: false, reason: 'unsupported-font' };
  let widthUnits = 0; // /Widths units — 1/1000 em by the format's own convention
  for (const byte of bytes) {
    let w = widthInfo.widths.get(byte);
    if (w === undefined) {
      // No declared width for this byte AND no /MissingWidth fallback: an
      // honest decline, not a 0-width glyph that would silently corrupt the
      // painted layout.
      if (widthInfo.missingWidth === null) return { ok: false, reason: 'unsupported-font' };
      w = widthInfo.missingWidth;
    }
    widthUnits += w;
  }

  const escapedName = escapeNameForWrite(insert.fontName);
  if (escapedName === null) return { ok: false, reason: 'font-name-unwritable' };

  const width = (widthUnits / 1000) * insert.size;
  const [r, g, b] = hexToRgb01(color);
  const literal = encodeLiteralStringBytes(bytes);

  // Same rendering-matrix reproduction v1 uses (see its own comment below):
  // Tf fixed at 1, size folded into Tm.
  const a = fmtNum(insert.size * insert.ux);
  const bC = fmtNum(insert.size * insert.uy);
  const c = fmtNum(-insert.size * insert.uy);
  const d = fmtNum(insert.size * insert.ux);
  const x = fmtNum(insert.x);
  const y = fmtNum(insert.y);

  // A literal string of real encoded BYTES + Tj — not a hex-glyph-id TJ run:
  // WinAnsi bytes ARE this font's character codes, so no kern-array trick is
  // needed even for the spaces (see module header).
  const ctmPrefix = neutralizeCTMPrefix(insert.baseCTM);
  if (ctmPrefix === null) return { ok: false, reason: 'unsupported-font' }; // singular base CTM
  const snippet = `q ${ctmPrefix}BT /${escapedName} 1 Tf ${fmtNum(r)} ${fmtNum(g)} ${fmtNum(b)} rg `
    + `${a} ${bC} ${c} ${d} ${x} ${y} Tm (${literal}) Tj ET Q`;

  return { ok: true, snippet, width };
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

  // Branch on the font dict's ACTUAL shape (not just whether the program
  // parsed): a simple /Subtype /TrueType font (the Word shape — see module
  // header) needs the byte-encoded path below, not v1's hex-glyph-id one.
  // `fontObj` can't be null here — extractFontProgram just proved this exact
  // walk resolves — but the guard stays because "can't happen" is still a
  // decline, not an assumption, on this file's own discipline.
  const { PDFName, PDFRef } = PDFLib;
  const context = page.doc.context;
  const res = (v) => resolve(context, PDFRef, v);
  const fontObj = lookupFontObject(page, PDFLib, insert.fontName);
  if (!fontObj) return { ok: false, reason: 'unsupported-font' };
  const subtype = res(fontObj.get(PDFName.of('Subtype')));
  const subtypeName = subtype instanceof PDFName ? subtype.toString() : '';

  if (subtypeName === '/TrueType') {
    return planSimpleTrueTypeInsert(fontObj, context, PDFLib, fontkit, extracted, insert, color, text);
  }

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
    if (!glyphPaints(font, ch.codePointAt(0))) return { ok: false, reason: 'missing-glyph' };
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

  const ctmPrefix = neutralizeCTMPrefix(insert.baseCTM);
  if (ctmPrefix === null) return { ok: false, reason: 'unsupported-font' }; // singular base CTM
  const snippet = `q ${ctmPrefix}BT /${escapedName} 1 Tf ${fmtNum(r)} ${fmtNum(g)} ${fmtNum(b)} rg `
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
