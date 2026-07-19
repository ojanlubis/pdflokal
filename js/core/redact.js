/*
 * PDFLokal — core/redact.js  (RUNG B production — pdf-lib ADAPTER)
 * ============================================================================
 * text-walk.js is headless: it takes a content-stream string + a font-metrics
 * Map and returns which show ops to cut. Something still has to (a) read the
 * font widths OUT of the PDF's own font dictionaries and (b) read/write the
 * content stream bytes. That's this file — the pdf-lib touchpoint, following
 * the vendor-injection pattern of export.js: NO vendor imports, `PDFLib` is
 * passed in by the caller (browser globals via core/vendor.js).
 *
 * WHY font widths live in the PDF, not in text-walk.js: the walk needs to know
 * how far each show op ADVANCES to trust the position of the NEXT op (see
 * text-walk.js's posValid). Those advances come from the font's declared
 * glyph widths — Type0/CID fonts keep them in the DescendantFont's /W array
 * (CID-keyed), simple fonts (Type1/TrueType) in /FirstChar + /Widths
 * (code-keyed). Getting this wrong doesn't crash — it silently trusts a wrong
 * position — so every font that isn't a clean, fully-declared case degrades to
 * `widths: null` (opaque/unknown) rather than guessing. text-walk.js already
 * treats unknown as "stop trusting positions"; this adapter's whole job is to
 * classify each font into a metrics shape it understands, or admit it can't.
 */

import { planRunRemoval } from './text-walk.js';

// PDF dict/array values are direct objects OR indirect references (PDFRef) —
// there is no way to tell which without checking, and every getter below can
// hit either shape depending on how the producing tool wrote the file. This
// is the ONE place that ambiguity gets resolved.
function resolve(context, PDFRef, value) {
  return value instanceof PDFRef ? context.lookup(value) : value;
}

// /W grammar (PDF 32000 9.7.4.3): two forms interleaved freely —
//   c [w1 w2 …]   → cids c, c+1, … get the listed widths
//   cFirst cLast w → every cid in the range gets ONE width
function parseWArray(wArray, context, PDFLib) {
  const { PDFArray } = PDFLib;
  const res = (v) => resolve(context, PDFLib.PDFRef, v);
  const widths = new Map();
  const items = wArray.asArray();
  let i = 0;
  while (i < items.length) {
    const first = res(items[i]).asNumber();
    const next = res(items[i + 1]);
    if (next instanceof PDFArray) {
      const list = next.asArray();
      list.forEach((w, k) => widths.set(first + k, res(w).asNumber()));
      i += 2;
    } else {
      const last = next.asNumber();
      const w = res(items[i + 2]).asNumber();
      for (let cid = first; cid <= last; cid += 1) widths.set(cid, w);
      i += 3;
    }
  }
  return widths;
}

const OPAQUE_1BYTE = { bytesPerCode: 1, widths: null, defaultWidth: 0 };
const OPAQUE_2BYTE = { bytesPerCode: 2, widths: null, defaultWidth: 0 };

// Type0/Identity-H: the DescendantFonts array's first (only, per spec) element
// carries /DW (default width, 1000 if absent) and /W (per-cid widths).
function parseType0Font(fontObj, context, PDFLib) {
  const { PDFName, PDFRef } = PDFLib;
  const res = (v) => resolve(context, PDFRef, v);
  const encoding = res(fontObj.get(PDFName.of('Encoding')));
  // Anything but the NAME /Identity-H (Identity-V, an embedded CMap stream,
  // …) is a shape we don't decode — opaque, safe decline, never guess.
  const isIdentityH = encoding instanceof PDFName && encoding.toString() === '/Identity-H';
  if (!isIdentityH) return OPAQUE_2BYTE;

  const descendants = res(fontObj.get(PDFName.of('DescendantFonts')));
  const desc0 = res(descendants.asArray()[0]);

  const dwRaw = desc0.get(PDFName.of('DW'));
  const defaultWidth = dwRaw ? res(dwRaw).asNumber() : 1000;

  const wRaw = desc0.get(PDFName.of('W'));
  const widths = wRaw ? parseWArray(res(wRaw), context, PDFLib) : new Map();

  return { bytesPerCode: 2, widths, defaultWidth };
}

// Type1/TrueType/MMType1: /FirstChar + /Widths (code-keyed, NOT cid-keyed —
// simple fonts have no CID layer). Standard-14 fonts (pdf-lib's StandardFonts,
// e.g. Helvetica with no embedded program) carry no /Widths at all — that's
// not malformed, it's the normal shape for a font the reader is expected to
// know already, so it degrades to unknown rather than being treated as bad.
function parseSimpleFont(fontObj, context, PDFLib) {
  const { PDFName, PDFRef } = PDFLib;
  const res = (v) => resolve(context, PDFRef, v);
  const widthsRaw = fontObj.get(PDFName.of('Widths'));
  if (!widthsRaw) return OPAQUE_1BYTE;

  const firstChar = res(fontObj.get(PDFName.of('FirstChar'))).asNumber();
  const widthsArr = res(widthsRaw).asArray();
  const widths = new Map();
  widthsArr.forEach((w, i) => widths.set(firstChar + i, res(w).asNumber()));

  let defaultWidth = 0;
  const fdRaw = fontObj.get(PDFName.of('FontDescriptor'));
  if (fdRaw) {
    const fd = res(fdRaw);
    const mwRaw = fd.get(PDFName.of('MissingWidth'));
    if (mwRaw) defaultWidth = res(mwRaw).asNumber();
  }

  return { bytesPerCode: 1, widths, defaultWidth };
}

// Read every font in a page's /Resources /Font dict into the FontMetrics shape
// text-walk.js's stringAdvance/computeAdvance consume. Returns
// Map<resourceFontName, FontMetrics> — resourceFontName is the key WITHOUT the
// leading '/', matching what the content-stream tokenizer yields for Tf's name
// operand (see content-stream.js's decodeName).
export function extractFontMetrics(page, PDFLib) {
  const { PDFName, PDFDict, PDFRef } = PDFLib;
  const context = page.doc.context;
  const res = (v) => resolve(context, PDFRef, v);

  const metrics = new Map();
  const resources = page.node.Resources();
  if (!resources) return metrics;

  const fontDictRaw = resources.get(PDFName.of('Font'));
  if (!fontDictRaw) return metrics;
  const fontDict = res(fontDictRaw);
  if (!(fontDict instanceof PDFDict)) return metrics;

  for (const key of fontDict.keys()) {
    const name = key.toString().slice(1); // '/F1' -> 'F1'
    // subtypeName is captured OUTSIDE the risky parse calls below so the
    // catch can still pick the right-shaped opaque fallback (2-byte for a
    // Type0 font whose W-array parsing chokes, 1-byte otherwise) — it's inert
    // either way (computeAdvance in text-walk.js short-circuits on
    // widths===null before bytesPerCode is ever read), but a wrong-shaped
    // fallback would be a landmine for whoever reads this next.
    let subtypeName = '';
    // WHY the blanket try/catch: one font with an unexpected/malformed shape
    // must not kill metrics extraction for every OTHER font on the page — it
    // becomes opaque (unknown) instead, same as a font we didn't recognize.
    try {
      const fontObj = res(fontDict.get(key));
      const subtype = res(fontObj.get(PDFName.of('Subtype')));
      subtypeName = subtype instanceof PDFName ? subtype.toString() : '';

      if (subtypeName === '/Type0') {
        metrics.set(name, parseType0Font(fontObj, context, PDFLib));
      } else if (subtypeName === '/Type1' || subtypeName === '/TrueType' || subtypeName === '/MMType1') {
        metrics.set(name, parseSimpleFont(fontObj, context, PDFLib));
      } else {
        metrics.set(name, OPAQUE_1BYTE); // Type3 or anything unrecognized
      }
    } catch {
      metrics.set(name, subtypeName === '/Type0' ? OPAQUE_2BYTE : OPAQUE_1BYTE);
    }
  }
  return metrics;
}

// Remove show-text ops matching `targets` (user-space run geometries) from a
// pdf-lib PDFPage's content stream(s), writing the result back onto the page.
// Returns { removed, results } — results[i] mirrors planRunRemoval's per-
// target { matched, ops }. Caller (lab-edit.js) still owns doc.save().
export function removeRunsFromPdfPage(page, PDFLib, targets) {
  const { PDFArray, PDFName, PDFRawStream, decodePDFRawStream } = PDFLib;
  const context = page.doc.context;

  // Contents may be one stream or an array of streams — decode ALL, join (the
  // spec treats multiple streams as logically one), operate, write back as
  // one. Same read shape as the fase-2 lab code this replaces.
  const contents = page.node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  const latin1 = (u8) => Array.from(u8, (b) => String.fromCharCode(b)).join('');
  const parts = refs.map((r) => {
    const s = context.lookup(r);
    return latin1(s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents());
  });
  const joined = parts.join('\n');

  const fonts = extractFontMetrics(page, PDFLib);
  const { content, removed, results } = planRunRemoval(joined, fonts, targets);

  if (removed > 0) {
    const bytesOf = (str) => Uint8Array.from(str, (c) => c.charCodeAt(0));
    const newStream = context.flateStream(bytesOf(content));
    page.node.set(PDFName.of('Contents'), context.register(newStream));
  }

  return { removed, results };
}
