/*
 * PDFLokal — core/text-visibility.js  (IS THIS TEXT ACTUALLY ON THE PAGE?)
 * ============================================================================
 * SINGLE SOURCE OF TRUTH for "does this page carry text a human can SEE".
 *
 * WHY THIS EXISTS. A searchable scan — anything out of Adobe Scan, CamScanner,
 * Google Drive's "make searchable", any ABBYY export — is an image with an
 * INVISIBLE text layer painted over it in render mode 3: neither fill nor
 * stroke. The words you see are pixels in the image. The text objects exist so
 * the document can be selected and searched, and for no other reason.
 *
 * Every text API we had read that as "this document has text":
 *   core/import.js  probeTextLayer   → any item with a non-empty string
 *   v2/text-runs.js extract          → the same filter — and that one is the
 *                                      ROUTER: runs.length === 0 is what sends
 *                                      a scan to the scan offer instead of
 *                                      into Edit Teks Asli
 *
 * So Edit opened on a searchable scan, cut show-ops that were never visible
 * (no visible change — they were invisible), and stamped the replacement over
 * an untouched image. The original stayed exactly where it was and the new text
 * landed beside it: `: Pondok Sapi, : Cibeber,`, the live incident of
 * 2026-07-28, reachable through a second door. tests/ocr-layer.spec.js holds
 * the reproduction and a screenshot of it happening.
 *
 * ⚠️ WHY NOT getTextContent(). It cannot answer this. Measured 2026-07-28
 * against a fixture pair that is byte-identical except the operand of Tr: the
 * two files produce text items with the SAME str, width, height and transform,
 * and there is no render-mode field on the item at all. pdf.js returns
 * invisible text on purpose — its own viewer needs it to make a scan
 * selectable. The signal exists ONLY in the operator list, which is why this
 * module walks that instead of doing the cheap thing.
 *
 * WHY THE GRAPHICS STACK IS TRACKED. Render mode is graphics state, so `q`/`Q`
 * save and restore it. A page that sets mode 3 inside a q…Q block and paints
 * real text after the Q is an ordinary document; ignoring the stack would
 * declare it a scan and send a perfectly editable file to the scan offer.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it is a PAGE-level verdict, not a
 * per-run one. A page that mixes visible text with an invisible OCR layer
 * answers `true` — correctly, it does have visible text — and a tap on one of
 * its invisible runs would still edit something nobody can see. That case needs
 * per-run render mode, which means routing text-runs through our own walker
 * (core/text-walk.js, which is equally Tr-blind today). Not built: it is a
 * bigger change than this one and it deserves a ruling, not a quiet extension.
 * The population this DOES cover is the one that actually exists in users'
 * hands — a phone-scanner PDF is invisible text over an image, end to end.
 */

// PDF 32000-1 Table 106. Modes 3 (neither fill nor stroke) and 7 (add to clip
// path, paint nothing) put no marks on the page. 4/5/6 also clip, but they
// fill or stroke as well, so they ARE visible.
export const INVISIBLE_RENDER_MODES = new Set([3, 7]);

// A show-op whose glyphs are all whitespace paints nothing a user can tap —
// the same reason every text path here filters on `str.trim()`.
function hasInk(glyphs) {
  if (!Array.isArray(glyphs)) return false;
  return glyphs.some((g) => g && typeof g === 'object' && typeof g.unicode === 'string' && g.unicode.trim() !== '');
}

/**
 * Does this page paint any text a human can see?
 * @param {object} pdfPage  a pdf.js page proxy
 * @param {object} pdfjsLib the pdf.js namespace (for OPS)
 * @returns {Promise<boolean>}
 */
export async function pageHasVisibleText(pdfPage, pdfjsLib) {
  const { OPS } = pdfjsLib;
  const list = await pdfPage.getOperatorList();
  const stack = [];
  let mode = 0; // PDF default: fill

  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    if (fn === OPS.save) { stack.push(mode); continue; }
    if (fn === OPS.restore) { if (stack.length) mode = stack.pop(); continue; }
    if (fn === OPS.setTextRenderingMode) { mode = list.argsArray[i][0]; continue; }
    // pdf.js decomposes ' and " into nextLine + showText, so these two ops are
    // the whole surface — there is no third way to paint a glyph.
    if (fn === OPS.showText || fn === OPS.showSpacedText) {
      if (INVISIBLE_RENDER_MODES.has(mode)) continue;
      if (hasInk(list.argsArray[i][0])) return true;
    }
  }
  return false;
}
