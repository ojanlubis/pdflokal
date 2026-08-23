/*
 * PDFLokal — v2/ocr-runs.js  (SCAN LADDER RUNG S2 — the tap index for a scan)
 * ============================================================================
 * The scan-side twin of js/v2/text-runs.js. Where that module asks pdf.js what
 * a page's text objects say, this one RECOGNISES what a page's pixels say, and
 * hands back the SAME Line shape — {str, x, y, w, h, size} in page-space px —
 * so "tap a line → cover it → retype" is the code that already ships.
 *
 * THE ROUTER, restated because it is the whole architecture (seat
 * decisions.md 2026-07-18, two ladders): a page with visible text objects
 * belongs to text-runs.js and Edit Teks Asli; a page with none is a scan and
 * belongs here. text-runs.js returning an empty array IS that signal, and it
 * already returns empty for both a bare image page and a searchable scan
 * (whose text layer is painted invisible over the pixels that carry the
 * words). Both land here correctly.
 *
 * WHAT THIS DELIBERATELY IS NOT. Rung S2 is a COVER-AND-RETYPE, not the pixel
 * surgery of rung S3: the original word is erased by painting over it, not by
 * inpainting the paper, and the replacement is set in an ESTIMATED font
 * because a scan carries no embedded font program to prove one right. On white
 * paper that reads as editing the photo; on a textured or shadowed phone photo
 * it will read as a patch. That fidelity line is Fauzan's to draw from the
 * live artifact — the seat's job was to put the artifact in front of him, not
 * to pre-empt it with a ruling of our own.
 *
 * WHY IT NEVER TOUCHES THE EXPORT PATH, and this is the load-bearing
 * difference from its born-digital twin. A Ganti Teks cover carries
 * `replaceTargets` + `replaceBox`, which is the SURGERY INTENT
 * core/page-surgery.js keys on to cut the original show-ops out of the content
 * stream. A scan has no show-ops to cut — the words are pixels. So the pair
 * this module creates carries NEITHER field (js/v2/app.js's ocrReplace), and
 * every filter in page-surgery.js and export.js is written as
 * `type === 'whiteout' && replaceTargets?.length && replaceBox`, so an S2 pair
 * is invisible to all of it and exports as exactly what it is: a filled rect
 * and a text object. Rung S2 therefore ships without touching the export path
 * at all — which is also why it does not fall under the low-risk list's
 * export-path condition.
 */

import { ocrLinesToPageLines, ocrScaleFor } from '../core/ocr-lines.js';
import { resolveTap } from '../core/text-lines.js';
import { MIN_HIT } from './text-runs.js';
import { recognizeCanvas, ensureOcrEngine, ocrEngineLoaded } from './ocr-engine.js';

export { ensureOcrEngine, ocrEngineLoaded };

export function createOcrIndex({ getDoc, rasterizer }) {
  // page.id -> Line[]  (present ⇒ this page has been recognised)
  const lineCache = new Map();
  // page.id -> Promise<Line[]>  (in flight; a second tap must join, not
  // start a second recognition of the same pixels on a phone)
  const inFlight = new Map();

  function pageOf(pageId) {
    return getDoc().pages.find((p) => p.id === pageId) || null;
  }

  async function recognise(page, onProgress) {
    // The page's own display width, not its native size: a merged page's
    // frame is normalised (core/operations.js normalizePageWidths) and every
    // coordinate this module produces is a view coordinate. renderCanvas
    // applies that same factor, so scale stays the single px↔page-space
    // relationship — see core/ocr-lines.js's header.
    const rotated = (page.rotation || 0) % 180 !== 0;
    const widthPt = rotated ? page.height : page.width;
    const scale = ocrScaleFor(widthPt);
    const canvas = await rasterizer.renderCanvas(page, { scale });
    const data = await recognizeCanvas(canvas, { onProgress });
    return ocrLinesToPageLines(data, scale);
  }

  return {
    /** Has this page already been recognised in this session? */
    hasLines(pageId) { return lineCache.has(pageId); },

    /** Is a recognition for this page in flight right now? */
    isRunning(pageId) { return inFlight.has(pageId); },

    /** Recognised lines for a page, or [] if it has not been run. Synchronous. */
    getLines(pageId) { return lineCache.get(pageId) || []; },

    /**
     * Recognise `pageId`, or join the run already in flight for it. Resolves
     * to the Line[] (possibly empty — a blank or unreadable page is a real
     * outcome, not an error). REJECTS only when the engine itself could not
     * load or run, so the caller can tell "nothing found" from "it broke":
     * those need different things said to the user, and collapsing them is
     * how a broken download comes out as "this page has no text".
     */
    run(pageId, { onProgress } = {}) {
      if (lineCache.has(pageId)) return Promise.resolve(lineCache.get(pageId));
      if (inFlight.has(pageId)) return inFlight.get(pageId);
      const page = pageOf(pageId);
      if (!page) return Promise.resolve([]);
      const job = recognise(page, onProgress)
        .then((lines) => {
          // Only cache if the page is still around AND nothing invalidated it
          // mid-run (a rotate while OCR was working would otherwise install
          // boxes measured in the previous frame).
          if (inFlight.get(pageId) === job) lineCache.set(pageId, lines);
          return lines;
        })
        .finally(() => { if (inFlight.get(pageId) === job) inFlight.delete(pageId); });
      inFlight.set(pageId, job);
      return job;
    },

    /** The tap → line resolver. Same clamped, finger-sized hit box as every
     *  other tap in the editor (core/text-lines.js's resolveTap, MIN_HIT). */
    hitTest(pageId, x, y) {
      return resolveTap(lineCache.get(pageId) || [], x, y, MIN_HIT);
    },

    /**
     * User-rotation changes the display frame, so every cached box is stale.
     * DROPS them rather than re-running: recognition is seconds and a 5 MB
     * engine, and silently re-spending that because someone rotated a page is
     * worse than making the next tap ask again. Any run in flight is orphaned
     * here too — its `.then` checks the map before installing.
     */
    invalidatePage(pageId) { lineCache.delete(pageId); inFlight.delete(pageId); },

    /** Page-manager operations don't say which pages moved. Same reasoning as
     *  js/v2/text-runs.js's own invalidateAll: staleness is the expensive one. */
    invalidateAll() { lineCache.clear(); inFlight.clear(); },
  };
}
