/*
 * PDFLokal — docx/convert.js  (THE ORCHESTRATOR: page loop, progress, cancel)
 * ============================================================================
 * PDF bytes in, .docx bytes out, entirely in the caller's process. Nothing is
 * uploaded, nothing is network. pdf.js and fflate are INJECTED (browser: the
 * vendored globals; node: the same files loaded as UMD) so this module imports
 * neither and runs headless in the gate.
 *
 *   convertPdfToDocx({ pdfjs, fflate, data, onProgress, maxPages, ocr, signal, options, modules })
 *     -> { docx: Uint8Array, stats, model }
 *   pdfToDocModel(...) -> { model, stats }       the same without the zip step
 *
 *   data        the PDF bytes (ArrayBuffer | Uint8Array)
 *   onProgress  (pageDone, pageTotal) after every page
 *   maxPages    stop after N pages (the gate uses 40)
 *   ocr         async ({ page, viewport, pageNumber }) -> OCR lines; the SHELL supplies it
 *   signal      an AbortSignal: checked between pages and between stages; aborting
 *               rejects with an AbortError and destroys the pdf.js document
 *   onPage      (page, pageNumber) after every page: the shell hands the Page to the
 *               streaming writer and DROPS it; model.pages then stays empty (this is
 *               what keeps a 700-page document out of memory; see docx/stream.js)
 *   onOpen      (pdf) once the document is open, before page 1: the shell checks numPages
 *               against its policy here and may throw; a returned { maxPages } narrows the run
 *   imageCache  a Map-shaped cache for encoded images (get/set/has). Default: an
 *               unbounded Map (the node gate); the stream passes a byte-capped one
 *   options     passed through to every module on ctx.options
 *   modules     replace any stage (tests, lane experiments):
 *               { images: { extractImages, imageAnchors }, color: { analyzeColor },
 *                 tables: { detectTables }, layout: { layoutPage } }
 *
 * THE PIPELINE, per page (each stage reads/writes the ctx documented in model.js):
 *   extract.readPage -> images.extractImages -> (kind refine: a text-less page with
 *   images is a 'scan') -> extract.applyOcr (scans, if `ocr`) -> color.analyzeColor
 *   -> extract.groupLines -> tables.detectTables -> layout.layoutPage
 *   -> Page { segments, anchors = images + colour shapes in paint (z) order }
 * A page that throws becomes an empty A4 page and an entry in stats.errors; the
 * rest of the document still converts.
 */

import * as extract from './extract.js';
import * as imagesMod from './images.js';
import * as colorMod from './color.js';
import * as tablesMod from './tables.js';
import * as layoutMod from './layout.js';
import { buildDocx } from './writer.js';
import { A4 } from './model.js';

export { buildDocx };

const NO_COLOR = { fillAt: () => null, anchors: [], background: null };

function abortError(signal) {
  if (signal && signal.reason) return signal.reason;
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}
const checkAbort = (signal) => { if (signal && signal.aborted) throw abortError(signal); };

// Anchors from different modules interleave by paint order (z = operator index).
function stackAnchors(...lists) {
  const all = lists.flat().map((a, k) => ({ a, k }));
  all.sort((x, y) => (x.a.z ?? Number.MAX_SAFE_INTEGER) - (y.a.z ?? Number.MAX_SAFE_INTEGER) || x.k - y.k);
  return all.map((e) => e.a);
}

export async function pdfToDocModel({ pdfjs, fflate, data, onProgress, onPage, onOpen, maxPages, ocr, signal, options, modules, imageCache }) {
  const mods = {
    images: (modules && modules.images) || imagesMod,
    color: (modules && modules.color) || colorMod,
    tables: (modules && modules.tables) || tablesMod,
    layout: (modules && modules.layout) || layoutMod,
  };
  checkAbort(signal);
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(data), disableFontFace: true, isEvalSupported: false, verbosity: 0, fontExtraProperties: true }).promise;
  try {
    const shared = { fflate, imageCache: imageCache || new Map() };
    const pages = [];
    const emit = async (pg, i) => { if (onPage) await onPage(pg, i); else pages.push(pg); };
    const stats = {
      pages: pdf.numPages,
      pageKinds: { text: 0, 'searchable-scan': 0, 'ocr-scan': 0, scan: 0, empty: 0 },
      ocrMs: 0, imageMasksSkipped: 0, imagesFailed: 0, anchored: 0, droppedBackground: 0, errors: [], lines: 0, columnBands: 0, tables: 0, shapes: 0,
    };
    const opened = onOpen ? await onOpen(pdf) : null;
    const cap = Math.min(maxPages || Infinity, (opened && opened.maxPages) || Infinity);
    const limit = Math.min(cap, pdf.numPages);
    for (let i = 1; i <= limit; i += 1) {
      checkAbort(signal);
      const page = await pdf.getPage(i);
      let built;
      try {
        const ctx = await extract.readPage({ pdfjs, page, pageNumber: i, shared, options });
        const { images, stats: istats } = await mods.images.extractImages(ctx);
        ctx.images = images;
        if (!ctx.hasTextItems && images.length) ctx.kind = 'scan';
        checkAbort(signal);
        if (ctx.kind === 'scan' && ocr) {
          const t0 = Date.now();
          await extract.applyOcr(ctx, ocr);
          stats.ocrMs += Date.now() - t0;
        }
        ctx.color = (await mods.color.analyzeColor(ctx)) || NO_COLOR;
        extract.groupLines(ctx);
        ctx.tables = (await mods.tables.detectTables(ctx)) || [];
        checkAbort(signal);
        const laid = mods.layout.layoutPage(ctx);
        const imgs = mods.images.imageAnchors(ctx);
        const shapes = ctx.color.anchors || [];
        stats.lines += ctx.lines.length;
        stats.pageKinds[ctx.kind] = (stats.pageKinds[ctx.kind] || 0) + 1;
        stats.imageMasksSkipped += istats.masks;
        stats.imagesFailed += istats.failed;
        stats.anchored += imgs.anchors.length;
        stats.droppedBackground += imgs.dropped;
        stats.columnBands += laid.stats.columnBands;
        stats.tables += laid.stats.tables || 0;
        stats.shapes += shapes.length;
        built = { widthPt: ctx.widthPt, heightPt: ctx.heightPt, segments: laid.segments, anchors: stackAnchors(shapes, imgs.anchors), kind: ctx.kind };
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        stats.errors.push(`p${i}: ${e && e.message}`);
        built = { widthPt: A4.widthPt, heightPt: A4.heightPt, segments: [{ cols: 1, space: 0, marginPt: { top: 36, right: 36, bottom: 18, left: 36 }, blocks: [] }], anchors: [], kind: 'error' };
      }
      page.cleanup();
      await emit(built, i); // outside the try: a sink failure is the caller's, not a page error
      if (onProgress) onProgress(i, limit);
    }
    return { model: { pages }, stats };
  } finally {
    await pdf.destroy();
  }
}

export async function convertPdfToDocx(args) {
  const { model, stats } = await pdfToDocModel(args);
  return { docx: buildDocx(model, { fflate: args.fflate }), stats, model };
}
