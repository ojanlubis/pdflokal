/*
 * PDFLokal — render/sharpen.js  (RENDER LAYER — raster resolution policy)
 * ============================================================================
 * PURE. No DOM, no globals, no imports — so `npm run test:core` can prove the
 * arithmetic headless (tests/core/sharpen-scale.test.mjs).
 *
 * THE PROBLEM this exists to answer
 * ---------------------------------
 * Pages are `<img>`, not live `<canvas>` (page-view.js's header: an `<img>`
 * survives the mobile GPU backing-store purge that blanks a canvas), and zoom
 * is ONE CSS transform on the stage (app.js's applyZoom) — atomic, GPU
 * composited, exact annotation registration at any zoom, no re-render, no
 * flicker. All three of those are load-bearing and none of them change here.
 *
 * The cost of them is that a raster baked at `RASTER_BASE` and then stretched
 * by `scale(3)` is showing 6× the page size out of 2× the pixels. The paper
 * goes soft. (The EXPORT is unaffected and must stay that way — export.js uses
 * copyPages, the content stream comes across verbatim, the download is vector.
 * We preview lossily; we never ship lossily.)
 *
 * THE POLICY
 * ----------
 * `sharpenScale` answers ONE question: at this zoom, on this screen, for this
 * page, what raster scale is honest? Callers apply it to the ONE page under the
 * viewport midline and nothing else — the fleet stays at RASTER_BASE, so the
 * memory bound tests/mobile/bigdoc-stress.spec.js measures is untouched.
 *
 * WHY dpr IS CAPPED AT 2 INSIDE THE FORMULA (`DPR_CAP`)
 * -----------------------------------------------------
 * It makes `want <= RASTER_BASE` at zoom 1 on EVERY device, which means the
 * sharpen can never fire without the user zooming. That is not a tuning
 * preference, it is the safety property: the streaming/memory behaviour of a
 * document nobody zoomed is bit-for-bit what it was before this module existed.
 * The residual — a dPR-3 phone is under-sampled at zoom 1 — is real, and the
 * fix for it is raising RASTER_BASE fleet-wide, which is a separate decision
 * with a real memory cost and needs the bigdoc heap number re-measured first.
 */

// The fleet baseline. SINGLE SOURCE OF TRUTH for the scale every page that is
// not the focused one is rastered at — app.js imports this rather than
// re-typing `2`, which is how it got hardcoded in two places to begin with.
export const RASTER_BASE = 2;

// Sharpen only when the deficit is worth a re-render. 1.2 means we tolerate
// ~20% under-sampling (invisible) and act past it. Below this the re-render
// costs a raster and buys nothing you can see.
export const SHARPEN_RATIO = 1.2;

// Hard ceiling on the scale factor regardless of page size or zoom. Zoom tops
// out at 3 (app.js) and DPR_CAP is 2, so `want` can reach 6 — this is the belt
// to the pixel budget's braces, and it is what stops a future zoom-limit change
// from silently multiplying the raster cost.
export const SHARPEN_MAX_SCALE = 6;

// See the header. Capping the device-pixel-ratio term at the baseline keeps
// zoom the ONLY thing that can arm a sharpen.
export const DPR_CAP = 2;

// Raster megapixel budget, by device class. Same numbers, same reasoning as the
// old wing's `deviceCapability.maxCanvasPixels` (js/init.js) — 5MP is PDF.js's
// own mobile canvas cap and iOS Safari's ~384MB canvas ceiling is what sets it.
// Duplicated as a value, not imported: js/init.js is the OLD WING and dies at
// demolition; the render layer must not depend on it.
export const MAX_PIXELS = {
  phone: 5_242_880,    // 5MP
  tablet: 10_000_000,  // 10MP
  desktop: 16_777_216, // 16MP
};

// deviceClass string (app.js's deviceClass(): 'phone' | 'tablet' | 'desktop')
// → megapixel budget. Unknown values get the phone budget: if we cannot tell
// what we are on, assume the weakest thing we ship to.
export function maxPixelsFor(deviceClass) {
  return MAX_PIXELS[deviceClass] || MAX_PIXELS.phone;
}

// Quantize to half-steps so a continuous pinch does not issue a fresh render
// for every 1% of finger travel. UP when we are choosing how sharp to go (round
// toward "sharp enough"), DOWN when the pixel budget is choosing (round toward
// "inside the cap").
function halfUp(n) { return Math.ceil(n * 2) / 2; }
function halfDown(n) { return Math.floor(n * 2) / 2; }

/**
 * The raster scale the FOCUSED page should be baked at right now.
 *
 * @param {object}  o
 * @param {number}  o.pageWidth   page width in points (unrotated — area is
 *                                rotation-invariant, so either frame is fine)
 * @param {number}  o.pageHeight  page height in points
 * @param {number}  o.zoom        the CSS transform scale currently applied
 * @param {number}  o.dpr         window.devicePixelRatio
 * @param {number}  o.maxPixels   raster pixel budget (see maxPixelsFor)
 * @returns {number} a scale >= RASTER_BASE. Exactly RASTER_BASE means
 *                   "no sharpening needed" — callers treat that as the
 *                   downgrade target, so this function never returns less.
 */
export function sharpenScale({ pageWidth, pageHeight, zoom = 1, dpr = 1, maxPixels = MAX_PIXELS.phone } = {}) {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  // Device pixels the browser is actually painting per page point.
  const want = z * Math.min(Math.max(d, 1), DPR_CAP);
  if (!(want > RASTER_BASE * SHARPEN_RATIO)) return RASTER_BASE;

  let scale = halfUp(Math.min(want, SHARPEN_MAX_SCALE));

  // PIXEL BUDGET — the cap that is page-size aware. A poster-sized page hits
  // the canvas ceiling at a scale an A4 sails through, and a canvas that
  // exceeds the browser's limit does not degrade, it comes back BLANK.
  const area = (Number(pageWidth) || 0) * (Number(pageHeight) || 0);
  if (area > 0 && Number.isFinite(maxPixels) && maxPixels > 0) {
    const affordable = Math.sqrt(maxPixels / area);
    if (affordable < scale) scale = halfDown(affordable);
  }

  // Never go BELOW the fleet baseline. If a page is so large that even
  // RASTER_BASE blows the budget, that is the existing streaming behaviour and
  // not this module's call to change.
  return scale > RASTER_BASE ? scale : RASTER_BASE;
}
