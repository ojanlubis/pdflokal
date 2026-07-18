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

// Finger-sized minimum hit box (page-space px at zoom 1). Small print is a
// <10px-tall run — the ≥44px touch-target law is met by inflating the HIT box,
// never the visual one. Zoom shrinks/grows this with the page, which matches
// how every other annotation target behaves.
const MIN_HIT = 22;

export function createTextRunIndex({ getDoc }) {
  const docCache = new Map(); // sourceId -> Promise<pdf.js document>
  const runCache = new Map(); // page.id  -> Promise<Run[]>

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
      runs.push({
        str: item.str,
        x: Math.min(...xs) - pad,
        y: Math.min(...ys) - pad,
        w: (Math.max(...xs) - Math.min(...xs)) + pad * 2,
        h: (Math.max(...ys) - Math.min(...ys)) + pad * 2,
        size: fh,
        fontName: item.fontName,
        fontFamily: style.fontFamily || '',
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

    // The tap → run resolver. Inflates each run's box to a finger-sized target
    // and, when several candidates overlap, picks the nearest run center.
    async hitTest(pageId, x, y) {
      const runs = await this.getRuns(pageId);
      let best = null;
      let bestD = Infinity;
      for (const r of runs) {
        const growX = Math.max(0, (MIN_HIT - r.w) / 2);
        const growY = Math.max(0, (MIN_HIT - r.h) / 2);
        if (x < r.x - growX || x > r.x + r.w + growX) continue;
        if (y < r.y - growY || y > r.y + r.h + growY) continue;
        const d = Math.hypot(x - (r.x + r.w / 2), y - (r.y + r.h / 2));
        if (d < bestD) { best = r; bestD = d; }
      }
      return best;
    },

    // User-rotation changes the display frame → cached boxes are stale.
    invalidatePage(pageId) { runCache.delete(pageId); },

    // Page-manager operations (rotate/reorder/delete) don't say which pages
    // moved — re-extracting is cheap (docs stay cached), staleness is not.
    invalidateAll() { runCache.clear(); },

    async destroy() {
      for (const p of docCache.values()) { try { (await p).destroy(); } catch { /* already gone */ } }
      docCache.clear();
      runCache.clear();
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
