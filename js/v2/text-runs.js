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

// Finger-sized minimum hit box (page-space px at zoom 1). Small print is a
// <10px-tall run — the ≥44px touch-target law is met by inflating the HIT box,
// never the visual one. Zoom shrinks/grows this with the page, which matches
// how every other annotation target behaves.
// Exported: js/v2/app.js's re-edit detection (spec-live-surgery.md §5/§8.4,
// increment 4) reuses this SAME constant against a page's committed-edit
// boxes, via core/text-lines.js's resolveTap — one hit-box law for every tap
// in the editor, not a second guessed number.
export const MIN_HIT = 22;

// A zero-length baseline vector (degenerate transform) must not divide by
// zero into NaN — fall back to the "along +x" direction, same convention
// text-walk.js uses for its own normalize().
function normalize(x, y) {
  const len = Math.hypot(x, y);
  return len === 0 ? [1, 0] : [x / len, y / len];
}

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
    const vp = pdfPage.getViewport({ scale: 1, rotation });
    const tc = await pdfPage.getTextContent();

    const runs = [];
    for (const item of tc.items) {
      if (!item.str || !item.str.trim()) continue;
      const style = tc.styles[item.fontName] || {};
      const m = pdfjs.Util.transform(vp.transform, item.transform);
      const fh = Math.hypot(m[2], m[3]); // length of the em vector = font size on screen
      if (!fh || !item.width) continue;
      // item.width is USER-space (font size already baked in) — it must ride
      // the baseline DIRECTION of the matrix, never its scale, or every box
      // is fontSize× too wide. Height (the em vector) does come from the
      // matrix. Corners → axis-aligned bbox, valid at every page rotation.
      const dirLen = Math.hypot(m[0], m[1]) || 1;
      const adv = [(m[0] / dirLen) * item.width * vp.scale, (m[1] / dirLen) * item.width * vp.scale];
      // Corners span DESCENDER (-0.25em, where the g/j/y tails live — a cover
      // that stops at the baseline leaves tails peeking out under it) to ascent
      // (+1em), through the matrix so the box is right at every page rotation.
      const pDesc = pdfjs.Util.applyTransform([0, -0.25], m);
      const pTop = pdfjs.Util.applyTransform([0, 1], m);
      const corners = [
        pDesc,
        [pDesc[0] + adv[0], pDesc[1] + adv[1]],
        pTop,
        [pTop[0] + adv[0], pTop[1] + adv[1]],
      ];
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      const pad = fh * 0.06;
      // pdf: the RAW (unprojected) user-space geometry — content-stream frame,
      // viewport- and rotation-INDEPENDENT. This is what core/redact.js needs
      // (it walks the content stream directly, never the display viewport);
      // `m` above is the viewport-projected matrix and must never feed it.
      const [ux, uy] = normalize(item.transform[0], item.transform[1]);
      runs.push({
        str: item.str,
        x: Math.min(...xs) - pad,
        y: Math.min(...ys) - pad,
        w: (Math.max(...xs) - Math.min(...xs)) + pad * 2,
        h: (Math.max(...ys) - Math.min(...ys)) + pad * 2,
        size: fh,
        fontName: item.fontName,
        fontFamily: style.fontFamily || '',
        pdf: {
          x0: item.transform[4], y0: item.transform[5],
          ux, uy,
          len: item.width,
          size: Math.hypot(item.transform[2], item.transform[3]),
        },
      });
    }
    return runs;
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
