/*
 * PDFLokal — core/font-style.js  (BOLD/ITALIC detection — Edit Teks Asli)
 * ============================================================================
 * WHY this module exists: a founder field test on a real Word-made PDF (bold
 * Arial headings) found that Ganti Teks NEVER adopted bold/italic — the
 * replacement always re-rendered regular. Root cause, verified by reading
 * pdf.js's own vendored worker bundle directly (js/vendor/pdf.worker.min.js):
 * the PUBLIC getTextContent() API exposes only
 * `styles[item.fontName] = { fontFamily: font.fallbackName, ascent, descent,
 * vertical }` — and `fallbackName` is pdf.js's OWN generic CSS collapse
 * ('monospace' | 'serif' | 'sans-serif'), computed by testing the font's
 * flags/name INTERNALLY and never handing the real name back out. The ascii
 * PostScript name that would actually say "Bold"/"Italic" never survives to
 * the main thread — text-runs.js's `fontFamily` field was never going to
 * carry it, no matter how it was read.
 *
 * The document's own /Font resource dict DOES carry it: the /BaseFont name
 * (PostScript convention — 'Arial-BoldMT', 'TimesNewRomanPS-BoldItalicMT')
 * and, for embedded fonts, the FontDescriptor's /Flags (PDF 32000 Table 123,
 * bit 7 = Italic, bit 19 = ForceBold) and /FontWeight. Same PDFLib-adapter
 * discipline as core/redact.js / core/doc-fonts.js: PDFLib is injected by the
 * caller, zero vendor imports here, every read degrades to "unknown" rather
 * than throwing or guessing.
 */

// PostScript-name convention — the baseline signal (works for Word/
// LibreOffice/InDesign subset fonts, which name this way almost universally).
// Exported standalone so it's unit-testable with zero PDFLib/PDF fixture
// (tests/core/font-style.test.mjs).
export function parseStyleFromName(name) {
  const s = String(name || '');
  return {
    bold: /bold/i.test(s),
    italic: /italic|oblique/i.test(s),
  };
}

function resolve(context, PDFRef, value) {
  return value instanceof PDFRef ? context.lookup(value) : value;
}

// Read a page Resources font's /BaseFont name plus FontDescriptor /Flags +
// /FontWeight — corroborating signals alongside the name parse (task's
// "synthetic style flags... as corroboration" — here the CORROBORATION is
// the PDF's own FontDescriptor, since pdf.js itself hands back nothing
// usable, see module header). `fontName` is a page Resources /Font key (no
// leading '/'), the same shape core/doc-fonts.js's extractFontProgram takes —
// but UNLIKE that function this is not restricted to Type0/Identity-H: bold
// detection must work on ordinary simple (Type1/TrueType) fonts too, which
// is exactly the shape of an unembedded "Arial-BoldMT" heading.
// Returns { ok:true, baseFont, bold, italic } or { ok:false } — never throws
// into the caller (same decline discipline as every other redact.js/
// doc-fonts.js reader).
export function getFontStyleInfo(page, PDFLib, fontName) {
  try {
    const { PDFName, PDFDict, PDFRef } = PDFLib;
    const context = page.doc.context;
    const res = (v) => resolve(context, PDFRef, v);

    const resources = page.node.Resources();
    if (!resources) return { ok: false };
    const fontDictRaw = resources.get(PDFName.of('Font'));
    if (!fontDictRaw) return { ok: false };
    const fontDict = res(fontDictRaw);
    if (!(fontDict instanceof PDFDict)) return { ok: false };

    const fontObjRaw = fontDict.get(PDFName.of(fontName));
    if (!fontObjRaw) return { ok: false };
    const fontObj = res(fontObjRaw);

    // Type0 fonts carry /BaseFont on the WRAPPER; the FontDescriptor (Flags,
    // FontWeight) lives one level down on the DescendantFont — same
    // indirection core/redact.js's parseType0Font already navigates.
    const subtype = res(fontObj.get(PDFName.of('Subtype')));
    let fdOwner = fontObj;
    if (subtype instanceof PDFName && subtype.toString() === '/Type0') {
      const descendantsRaw = fontObj.get(PDFName.of('DescendantFonts'));
      const descendants = descendantsRaw ? res(descendantsRaw) : null;
      const desc0 = descendants ? res(descendants.asArray()[0]) : null;
      if (desc0) fdOwner = desc0;
    }

    const baseFontRaw = fontObj.get(PDFName.of('BaseFont'));
    const baseFont = baseFontRaw ? res(baseFontRaw).toString().replace(/^\//, '') : '';

    let italicFlag = false;
    let boldFlag = false;
    // embedded: does this font carry ANY program (FontFile/2/3)? A name-only
    // font (no FontDescriptor at all, or one without a program — the
    // standard-14 server-generator shape) has NO glyphs of its own: every
    // viewer substitutes. The honesty ruling (founder, 2026-07-20 evening)
    // keys on this: substituting for a font that never shipped outlines is
    // not a substitution worth announcing — there is nothing to be unfaithful
    // to. Exotic-but-embedded programs we merely fail to parse stay
    // embedded:true, so they keep the notice.
    let embedded = false;
    const fdRaw = fdOwner.get(PDFName.of('FontDescriptor'));
    if (fdRaw) {
      const fd = res(fdRaw);
      embedded = ['FontFile', 'FontFile2', 'FontFile3']
        .some((key) => !!fd.get(PDFName.of(key)));
      const flagsRaw = fd.get(PDFName.of('Flags'));
      if (flagsRaw) {
        const flags = res(flagsRaw).asNumber();
        italicFlag = !!(flags & 0x40);    // bit 7 (1-indexed) = Italic
        boldFlag = !!(flags & 0x40000);   // bit 19 = ForceBold
      }
      const weightRaw = fd.get(PDFName.of('FontWeight'));
      if (weightRaw) {
        const weight = res(weightRaw).asNumber();
        if (weight >= 600) boldFlag = true;
      }
    }

    const fromName = parseStyleFromName(baseFont);
    return {
      ok: true,
      baseFont,
      embedded,
      bold: fromName.bold || boldFlag,
      italic: fromName.italic || italicFlag,
    };
  } catch {
    return { ok: false };
  }
}
