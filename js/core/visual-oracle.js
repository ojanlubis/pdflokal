/*
 * PDFLokal — core/visual-oracle.js  (Increment C — the visual oracle,
 * spec-edit-fidelity-instrumentation.md)
 * ============================================================================
 * At commit the editor already rebakes the edited page's raster (spec-live-
 * surgery.md §5/§8.3) — so BOTH renders exist for a moment: the page as it
 * was (the raster the rebake is about to replace) and as it is (the raster
 * the rebake just produced). This module crops the edited line's OWN region
 * out of each and compares them, purely as ink shapes — content-blind,
 * zero pixels ever leave the device, only a few bucketed numbers do.
 *
 * CORRECTED 2026-07-23 (decisions.md, before this module was built): a raw
 * pixel-diff is the WRONG measure — the text changed on purpose, so a diff
 * score can't separate the intended edit from an unintended mismatch. What's
 * diagnostic is CONTENT-NORMALIZED SHAPE ratios:
 *   - weight_ratio  — ink density within its OWN bounding box (ink area ÷
 *     that box's area) approximates stroke thickness, and is fairly
 *     content-independent for Latin text (a thin replacement over a bold
 *     original reads far below parity — this is the founder's own "T & PPGA"
 *     bug, turned into a number). Comparing density-within-own-bbox (not raw
 *     ink÷crop-area) is what makes the ratio survive the replacement having a
 *     different string length than the original.
 *   - height_ratio   — the ink's own glyph-band height, stamped ÷ pristine.
 *     Catches a font-SIZE mismatch — a different defect class than weight
 *     (validated separately, see this module's test file: a deliberate 40%
 *     size shrink reads as an unambiguous ~0.6 ratio, while a pure BOLD-vs-
 *     REGULAR weight swap of the SAME text barely moves height at all).
 *   - overflow       — does the stamped ink reach the crop region's own
 *     edge (the replaceBox is sized to the ORIGINAL text; ink touching its
 *     boundary means the new text needed more room than the box has).
 *
 * Both regions MUST be cropped to the exact same box (same coordinates, same
 * pixel dimensions) by the caller — this module only ever compares like-for-
 * like frames, never re-derives geometry.
 *
 * WHOSE JOB is "was the requested crop fully inside its source raster" (PM
 * question, 2026-07-26): this module only ever receives already-cropped
 * ImageData — it has no visibility into the source raster's own width/height
 * versus what was asked for, so it structurally CANNOT tell "legitimately no
 * ink here" apart from "this pixel was never part of the raster at all". The
 * ALPHA_MIN check below stops transparent padding from being MISREAD as ink
 * (the corruption bug), but a caller that hands this module a box which
 * spilled past the raster's own edge is asking a geometry question this
 * layer has no way to answer. That decline belongs at the crop site itself,
 * where the raster's real dimensions are known (js/v2/app.js's
 * cropRasterRegion/runVisualOracle) — see that call site's own bounds guard.
 *

 * Zero vendor imports (same discipline as every core/ sibling): this module
 * takes plain ImageData-shaped objects ({width, height, data} — a
 * Uint8ClampedArray/Uint8Array of RGBA bytes) so it's trivially testable
 * headlessly with a synthetic pixel buffer — no canvas, no DOM, no PDF.js.
 */

// A pixel counts as "ink" when it's meaningfully darker than a plain white/
// light page background — same idea as reading black text off a light page
// background regardless of exact color (a cover or a colored box behind the
// text still contrasts against dark glyph ink in the overwhelming majority
// of real documents). Not a claim about arbitrary art/photo content — this
// module is only ever pointed at a text-replacement's own small crop.
const DEFAULT_INK_THRESHOLD = 120;

// PM-flagged 2026-07-26: a pixel must be sufficiently OPAQUE, not just dark,
// before it counts as ink. WHY this matters — a crop rect that extends past
// its source raster's own edge (a line near a page border, or a replaceBox
// whose width pushes past the right margin) gets padded with TRANSPARENT
// BLACK: `createImageBitmap`'s crop overload pads out-of-bounds pixels with
// alpha 0 / rgb (0,0,0) per spec, and a freshly-created untouched canvas (the
// Image+drawImage fallback path) starts fully transparent too — which is
// ALSO rgb (0,0,0). Reading luminance alone can't tell "real black ink" from
// "nothing was ever drawn here" — both read as maximally dark. Without this
// check, that padding scores as a solid ink block: inkCount inflated, the
// bbox blown out to the full crop, and density (this module's entire reason
// for existing) becomes noise — SILENTLY, with a confident-looking bucket
// still emitted. Never simplify this back out to "just luminance".
const ALPHA_MIN = 128;

function luminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

// Scans one ImageData-shaped region and returns its own ink footprint: how
// many pixels are "ink", and the tight bounding box around them. Returns
// null when the region carries NO ink at all (a blank crop — nothing to
// measure a ratio against, and the honest answer is "can't compare", not a
// divide-by-zero pretending to be a number). A region that is ENTIRELY
// transparent (e.g. a crop that landed fully outside its source raster)
// correctly falls into this same null/no-ink case, never "100% ink".
export function analyzeInkRegion(imageData, opts = {}) {
  const threshold = opts.threshold ?? DEFAULT_INK_THRESHOLD;
  const { width, height, data } = imageData;
  let inkCount = 0;
  let minX = Infinity; let maxX = -Infinity;
  let minY = Infinity; let maxY = -Infinity;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const idx = (width * y + x) * 4;
      if (data[idx + 3] >= ALPHA_MIN && luminance(data[idx], data[idx + 1], data[idx + 2]) < threshold) {
        inkCount += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (inkCount === 0) return null;
  const bboxW = maxX - minX + 1;
  const bboxH = maxY - minY + 1;
  return {
    inkCount, bboxW, bboxH,
    density: inkCount / (bboxW * bboxH), // ink ÷ ITS OWN bbox — the content-normalized weight proxy
    minX, maxX, minY, maxY,
  };
}

// WHY a margin, not an exact touch: the crop's own edge pixels can carry a
// stray anti-aliased sliver from an adjacent glyph/rule even when nothing
// truly overflowed — a couple of forgiving pixels avoids flagging that noise
// as a real too-long-line defect.
const OVERFLOW_EDGE_MARGIN_PX = 2;

function touchesEdge(region, width, height) {
  return region.minX <= OVERFLOW_EDGE_MARGIN_PX
    || region.minY <= OVERFLOW_EDGE_MARGIN_PX
    || region.maxX >= width - 1 - OVERFLOW_EDGE_MARGIN_PX
    || region.maxY >= height - 1 - OVERFLOW_EDGE_MARGIN_PX;
}

// The one entry point callers need: pristine + stamped crops of the SAME
// box (same pixel dimensions) -> raw ratios (floats — the CALLER buckets
// them via telemetry-schema.js before it ever reaches tel(), same
// string-free-law discipline as every other event). Returns null when either
// region has no ink to measure (nothing to compare against — never a fake
// ratio) or the two regions aren't the same size (a caller bug — this module
// never re-derives or coerces geometry it wasn't given). NEVER throws.
export function compareRegions(pristineImageData, stampedImageData, opts = {}) {
  try {
    if (!pristineImageData || !stampedImageData) return null;
    if (pristineImageData.width !== stampedImageData.width
      || pristineImageData.height !== stampedImageData.height) return null;

    const pristine = analyzeInkRegion(pristineImageData, opts);
    const stamped = analyzeInkRegion(stampedImageData, opts);
    if (!pristine || !stamped) return null;

    return {
      weightRatio: stamped.density / pristine.density,
      heightRatio: stamped.bboxH / pristine.bboxH,
      overflow: touchesEdge(stamped, stampedImageData.width, stampedImageData.height),
    };
  } catch {
    // Never a hard failure (same discipline as page-surgery.js/stamp.js) —
    // a malformed/unreadable region just means "no signal this time".
    return null;
  }
}
