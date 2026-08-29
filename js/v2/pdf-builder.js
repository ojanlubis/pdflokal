/*
 * PDFLokal — v2/pdf-builder.js  (BROWSER EDGE FOR PDF OUTPUT)
 *
 * SINGLE SOURCE OF TRUTH for loading the export vendors and preserving the
 * font-fallback witness. UI routes decide how to name/download/report the
 * result; they must not each rebuild this adapter around core/export.js.
 */
import { buildPdfBytes } from '../core/export.js';
import { ensurePdfLib } from '../core/vendor.js';

export async function buildPdfArtifact(doc, deps = {}) {
  const loadPdfLib = deps.loadPdfLib || ensurePdfLib;
  const buildPdf = deps.buildPdf || buildPdfBytes;
  const { PDFLib, fontkit } = await loadPdfLib();
  let fontFallback = false;
  const bytes = await buildPdf(doc, {
    PDFLib,
    fontkit,
    onFontFallback: () => { fontFallback = true; },
  });
  return { bytes, fontFallback };
}
