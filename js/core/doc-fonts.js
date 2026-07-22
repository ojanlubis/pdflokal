/*
 * PDFLokal — core/doc-fonts.js  (font DICT/PROGRAM reads shared by stamp.js + the editor)
 * ============================================================================
 * MOVED verbatim out of core/reinsert.js (spec-edit-rebuild-composite.md
 * increment 2, Path B founder-ruled 2026-07-22): reinsert.js's own write
 * mechanism (the hand-rolled content-stream snippet builder) retired whole,
 * but these two READERS didn't belong to that mechanism at all — they just
 * resolve a page Resources /Font entry down to its dict, and pull the raw
 * embedded font PROGRAM bytes back out of it. core/stamp.js's doc-subset rung
 * needs both to try embedding the document's own font; js/v2/app.js's live
 * FontFace preview (loadDocFont/prepareDocFont) needs both at draft-open time,
 * before any cut/insert ever happens. Two callers, one home — same "MOVE, not
 * a rewrite" discipline the spec's own inventory calls for.
 *
 * Same vendor-injection discipline as every core/ sibling: PDFLib is passed
 * in by the caller — this file has zero vendor imports.
 */

// Same ambiguity redact.js resolves: a dict/array VALUE is either a direct
// object or an indirect PDFRef — only a runtime check tells them apart.
function resolve(context, PDFRef, value) {
  return value instanceof PDFRef ? context.lookup(value) : value;
}

// Shared page/Resources/Font walk: resolve `fontName` (a page Resources
// /Font key, no leading '/') down to its font dict object, or `null` if
// anything along the way is missing/wrong-shaped. Both extractFontProgram
// (the embedded PROGRAM bytes) and (formerly) planNativeInsert's simple-
// TrueType guards (which need the DICT itself — /Subtype, /Encoding,
// /Widths) walk this same path; this is the one place that walk lives.
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
// Type0/Identity-H OR a simple /Subtype /TrueType font (the Word shape):
// either way, the FontDescriptor's FontFile2 (TrueType glyf) or FontFile3
// (CFF/OpenType-CFF) is a real program fontkit can parse. A simple font's
// FontDescriptor sits directly on the font dict; a Type0 font's sits one
// level down, on its sole DescendantFont. Anything else — standard-14 (no
// embedded program), a Type1 font's raw FontFile, any other /Subtype — is
// "unsupported-font": a genuine decline, not malformed input.
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
