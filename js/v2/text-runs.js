/*
 * PDFLokal — v2/text-runs.js  (TEXT-RUN INTELLIGENCE — Edit Teks Asli, Rung A)
 * ============================================================================
 * Extracts the PRINTED text of a PDF page as tap-able runs: what the text says,
 * where it sits (page-space px == PDF points, top-left origin — the exact same
 * frame annotations live in), and what font paints it. This is the data layer
 * under "Ganti Teks" (smart replace): tap a printed run → cover + retype.
 *
 * WHY runs and not paragraphs: a PDF stores painting instructions, not
 * structure — reconstructing paragraphs is Rung D territory (see the seat's
 * spec-edit-teks-asli.md). A run is what the file actually knows.
 *
 * Mirrors createPageRasterizer's shape (core/import.js): pdf.js docs cached per
 * source, extraction cached per page.id, everything destroyed on "Buka Baru".
 * Proven first in /lab-edit.html (fase 1) before being wired here.
 */

import { getSource } from '../core/model.js';
import { ensurePdfJs } from '../core/vendor.js';
import { groupRunsIntoLines, resolveTap } from '../core/text-lines.js';
import { pageHasVisibleText } from '../core/text-visibility.js';
import { runsFromTextContent } from '../core/text-run-geometry.js';

// Finger-sized minimum hit box (page-space px at zoom 1). Small print is a
// <10px-tall run — the ≥44px touch-target law is met by inflating the HIT box,
// never the visual one. Zoom shrinks/grows this with the page, which matches
// how every other annotation target behaves.
// Exported: js/v2/app.js's re-edit detection (spec-live-surgery.md §5/§8.4,
// increment 4) reuses this SAME constant against a page's committed-edit
// boxes, via core/text-lines.js's resolveTap — one hit-box law for every tap
// in the editor, not a second guessed number.
export const MIN_HIT = 22;

export function createTextRunIndex({ getDoc }) {
  const docCache = new Map(); // sourceId -> Promise<pdf.js document>
  const runCache = new Map(); // page.id  -> Promise<Run[]>
  // Lines are runs grouped by geometry (core/text-lines.js) — same lifecycle
  // as runCache (invalidated together), computed lazily from the cached runs
  // rather than re-extracting, so hit-testing/hints never re-touch pdf.js.
  const lineCache = new Map(); // page.id  -> Promise<Line[]>

  function getPdf(sourceId) {
    if (!docCache.has(sourceId)) {
      const source = getSource(getDoc(), sourceId);
      docCache.set(
        sourceId,
        ensurePdfJs().then((lib) => lib.getDocument({ data: source.bytes.slice() }).promise),
      );
    }
    return docCache.get(sourceId);
  }

  async function extract(page) {
    // An image page has no text objects at all — that's the scan ladder's job
    // (spec-edit-dokumen-foto.md, S1). Empty here IS the router signal.
    if (page.isFromImage) return [];
    const pdfjs = await ensurePdfJs();
    const pdf = await getPdf(page.sourceId);
    const pdfPage = await pdf.getPage(page.sourcePageNum + 1);
    // Same absolute-rotation rule as the rasterizer: the runs must land in the
    // ROTATED frame the raster (and every annotation coordinate) lives in.
    const rotation = ((page.baseRotation || 0) + (page.rotation || 0)) % 360;
    // MERGE WIDTH NORMALISATION (core/operations.js normalizePageWidths): a
    // merged page's view frame is no longer its native point size, and these
    // boxes ARE view coordinates (they become cover/overlay rects). Project
    // through the same factor the raster and the page div use, or every hit
    // box on a merged page sits at the wrong scale. The `pdf:` field below is
    // read straight off item.transform — raw, unprojected, content-stream
    // space — so it stays native, which is exactly what redact.js/text-walk.js
    // need. Do not "fix" that to match.
    const vp = pdfPage.getViewport({ scale: page.baseWidth > 0 ? page.width / page.baseWidth : 1, rotation });
    const tc = await pdfPage.getTextContent();

    // A SEARCHABLE SCAN IS STILL A SCAN. Its text layer is painted in render
    // mode 3 — invisible — over the image that carries the actual words. Left
    // unchecked, those items become runs, Edit opens on them, cuts show-ops
    // nobody could see, and stamps the replacement beside an untouched image
    // (tests/ocr-layer.spec.js). Empty here IS the router signal, exactly as it
    // is for a bare scan above, so this lands in the scan offer.
    //
    // ORDER IS DELIBERATE, and it is a phone-performance decision.
    // getTextContent parses text operators only; getOperatorList builds the
    // WHOLE page including decoding its images. A bare scan is one big JPEG
    // and no text — the most expensive page to walk and the one with nothing
    // to qualify — so it must exit on the cheap test, never the dear one.
    if (!tc.items.some((it) => it.str && it.str.trim())) return [];
    if (!(await pageHasVisibleText(pdfPage, pdfjs))) return [];

    // The per-item arithmetic (box, baseline origin, raw content-stream frame) is
    // shared with the PDF -> Word extractor: core/text-run-geometry.js.
    return runsFromTextContent({ pdfjs, tc, vp });
  }

  return {
    // Runs for a page, extracted once and cached. Safe to call repeatedly.
    getRuns(pageId) {
      if (!runCache.has(pageId)) {
        const page = getDoc().pages.find((p) => p.id === pageId);
        if (!page) return Promise.resolve([]);
        runCache.set(pageId, extract(page).catch((err) => {
          // A page whose text layer fails to parse behaves like a scan: the
          // overlay tools still work, only smart replace declines. Never throw
          // into the tap path.
          console.warn('Ekstraksi teks gagal:', err);
          return [];
        }));
      }
      return runCache.get(pageId);
    },

    // Lines for a page — runs clustered by geometry (founder ruling
    // 2026-07-19: the LINE is the editing primitive for Ganti Teks). Grouped
    // from the same cached runs, so a single-fragment-per-line document (every
    // pre-line fixture) yields one Line per Run, byte-identical in shape.
    async getLines(pageId) {
      if (!lineCache.has(pageId)) {
        lineCache.set(pageId, this.getRuns(pageId).then((runs) => {
          const lines = groupRunsIntoLines(runs);
          // core/text-lines.js is DELIBERATELY paint-order-independent (its own
          // docstring: "paint-order scrambling doesn't change the result") —
          // correct for clustering, but it means the returned Line[] order is
          // an artifact of the clustering's internal geometry sort, not the
          // page's reading order. Hints/hitTest must keep PAINT order (what
          // getRuns already returns, what every existing index-based caller —
          // including this suite's own paint-order test pins — assumes), so
          // re-sort lines by their earliest constituent run's original index.
          const indexOf = new Map(runs.map((r, i) => [r, i]));
          lines.sort((a, b) => Math.min(...a.runs.map((r) => indexOf.get(r)))
            - Math.min(...b.runs.map((r) => indexOf.get(r))));
          return lines;
        }));
      }
      return lineCache.get(pageId);
    },

    // The tap → line resolver. Delegates to core/text-lines.js's resolveTap:
    // per-side clamped inflation toward MIN_HIT (stops at the neighbor
    // instead of overlapping it on dense text) + nearest-box (not
    // nearest-center) resolution among candidates. See that module's
    // docstring for the founder field report this fixed (2026-07-19).
    async hitTest(pageId, x, y) {
      const lines = await this.getLines(pageId);
      return resolveTap(lines, x, y, MIN_HIT);
    },

    // User-rotation changes the display frame → cached boxes are stale.
    invalidatePage(pageId) { runCache.delete(pageId); lineCache.delete(pageId); },

    // Page-manager operations (rotate/reorder/delete) don't say which pages
    // moved — re-extracting is cheap (docs stay cached), staleness is not.
    invalidateAll() { runCache.clear(); lineCache.clear(); },

    async destroy() {
      for (const p of docCache.values()) { try { (await p).destroy(); } catch { /* already gone */ } }
      docCache.clear();
      runCache.clear();
      lineCache.clear();
    },
  };
}

// The run's real font → the closest of our five embeddable families. Metric
// twins where they exist (Calibri→Carlito is exactly why Carlito is in the
// kit); the honest default is Helvetica. Rung C replaces this guess with
// fontkit subset-coverage matching — see the seat spec.
export function mapRunFont(fontFamily, fontName) {
  const s = `${fontFamily} ${fontName}`.toLowerCase();
  if (s.includes('courier') || s.includes('mono')) return 'Courier';
  if (s.includes('calibri') || s.includes('carlito')) return 'Carlito';
  if (s.includes('montserrat')) return 'Montserrat';
  if (s.includes('times') || (s.includes('serif') && !s.includes('sans'))) return 'Times-Roman';
  return 'Helvetica';
}
