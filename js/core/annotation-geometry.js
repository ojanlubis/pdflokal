/*
 * PDFLokal — core/annotation-geometry.js  (THE FRAME ANNOTATIONS LIVE IN)
 * ============================================================================
 * SINGLE SOURCE OF TRUTH for how an annotation's geometry moves when its page's
 * frame changes.
 *
 * THE CONTRACT: an annotation's x / y / width / height / fontSize (and a
 * paragraph block's display mapping: k, disp, below) are in the page's
 * DISPLAYED frame: the page as the user sees it, after its rotation and after
 * any merge normalisation (page.width / page.baseWidth). Everything that
 * changes that frame must carry the annotations with it, through this file:
 *   - merge normalisation scales the frame  → scaleAnnotationGeometry
 *   - export draws in the NATIVE frame      → scaleAnnotationGeometry(1 / k)
 *   - a page turn rotates the frame         → quarterTurnAnnotation
 *
 * WHY a file of its own (2026-10-10): this contract used to be a comment in
 * export.js. operations.js did not know it, so merge normalisation resized
 * pages and left their annotations at their old numbers, and rotatePage turned
 * pages and left signatures off the bottom edge. A rule only a comment states is
 * a rule the next mutation path does not follow.
 *
 * NOT in this frame, and never moved here: the doc-bound surgery inputs
 * (replaceBox, replaceTargets, a block's width/origin/leading/size), which are
 * in the source page's own PDF units, read by surgery from the content stream.
 * Scaling them would send a doubly transformed target to text-walk.js.
 *
 * Pure: always returns a NEW object (history snapshots share nested fields such
 * as `block` by reference, so nothing here may mutate its input).
 */

/**
 * `anno` with its displayed-frame geometry scaled by `k`. Undefined fields stay
 * undefined: drawSignature derives a missing height from the image's own ratio,
 * and multiplying undefined would make it NaN and drop the signature.
 */
export function scaleAnnotationGeometry(anno, k) {
  const out = { ...anno };
  for (const key of ['x', 'y', 'width', 'height', 'fontSize']) {
    if (Number.isFinite(out[key])) out[key] *= k;
  }
  if (out.block) {
    const b = { ...out.block };
    if (Number.isFinite(b.k)) b.k *= k;
    if (Number.isFinite(b.below)) b.below *= k;
    if (b.disp) b.disp = { x: b.disp.x * k, y: b.disp.y * k };
    out.block = b;
  }
  return out;
}

/**
 * `anno` after its page turns one quarter clockwise. `H` is the displayed
 * height BEFORE the turn; `newW`/`newH` the displayed size after it.
 *
 * The rule (2026-10-10, a behaviour call for the seat to judge;
 * tests/core/rotate-annotations.test.mjs):
 *   - a whiteout (Tip-Ex, or an edit cover) turns WITH the content it hides:
 *     its rect rotates, width and height swap;
 *   - anything else (signature, text) keeps reading upright and follows the
 *     spot it marked: its centre moves with the content, its size stays, and
 *     it is clamped inside the page.
 */
export function quarterTurnAnnotation(anno, H, newW, newH) {
  const w = Number.isFinite(anno.width) ? anno.width : 0;
  const h = Number.isFinite(anno.height) ? anno.height : 0;
  if (anno.type === 'whiteout') {
    return { ...anno, x: H - (anno.y + h), y: anno.x, width: h, height: w };
  }
  const cx = H - (anno.y + h / 2);
  const cy = anno.x + w / 2;
  const clamp = (v, max) => Math.min(Math.max(v, 0), Math.max(max, 0));
  return { ...anno, x: clamp(cx - w / 2, newW - w), y: clamp(cy - h / 2, newH - h) };
}
