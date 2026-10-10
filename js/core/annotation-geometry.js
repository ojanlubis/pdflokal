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
 * and a move (operations.js moveAnnotation) carries block.disp with x/y
 * through withBlockFollowing.
 *
 * WHY a file of its own (2026-10-10): this contract used to be a comment in
 * export.js. operations.js did not know it, so merge normalisation resized
 * pages and left their annotations at their old numbers, and rotatePage turned
 * pages and left signatures off the bottom edge. A rule only a comment states is
 * a rule the next mutation path does not follow.
 *
 * ALSO in this frame, and moved with the cover: an edit cover's BIRTH rects,
 * replaceBox (Ganti/Hapus) and ocrBox (scan edits). page-surgery.js's
 * overlapsBirthBox compares the cover against replaceBox directly; moving one
 * without the other made every rotated or merge-rescaled edit look "dragged
 * away", surgery declined, and the original text stayed in the file under a
 * painted box (round-3 regression, 2026-10-10).
 *
 * NOT in this frame, and never moved here: replaceTargets and a block's
 * width/origin/leading/size. Those are in the source page's own PDF units,
 * read by surgery from the content stream; transforming them would send a
 * doubly transformed target to text-walk.js.
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
  for (const key of BIRTH_RECTS) {
    const r = out[key];
    if (r) out[key] = { x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k };
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

const BIRTH_RECTS = ['replaceBox', 'ocrBox'];

// One clockwise quarter turn of a rect in a frame whose displayed height is H.
const turnRect = (r, H) => ({ x: H - (r.y + r.h), y: r.x, w: r.h, h: r.w });

/**
 * The extent rotation reasons with. A text annotation stores no width/height
 * (the view sizes it from its text), and treating it as a point pivoted it on
 * its top-left corner and let the clamp pass it off the page. 0.6em per
 * character over-estimates most fonts, which errs toward staying on the page.
 * Export reuses it to find which source annotations a user object lies over
 * (core/export.js userObjectRects), where erring wide errs toward covering.
 */
export function extentOf(anno) {
  const w = Number.isFinite(anno.width) ? anno.width : null;
  const h = Number.isFinite(anno.height) ? anno.height : null;
  if (w !== null && h !== null) return { w, h };
  if (anno.type === 'text' && typeof anno.text === 'string') {
    const size = Number.isFinite(anno.fontSize) ? anno.fontSize : 16;
    const lines = anno.text.split('\n');
    return {
      w: w ?? Math.max(...lines.map((l) => l.length)) * size * 0.6,
      h: h ?? lines.length * size * 1.2,
    };
  }
  return { w: w ?? 0, h: h ?? 0 };
}

/**
 * `anno` after its page turns `steps` quarters clockwise (0-3; a -90 is 3).
 * `W`/`H` are the displayed size BEFORE the turn.
 *
 * The rule (2026-10-10, a behaviour call for the seat to judge;
 * tests/core/rotate-annotations.test.mjs):
 *   - a whiteout (Tip-Ex, or an edit cover) turns WITH the content it hides:
 *     its rect rotates, width and height swap, and its birth rects with it;
 *   - anything else (signature, text) keeps reading upright and follows the
 *     spot it marked: its centre moves with the content, its size stays, and
 *     it is clamped inside the page ONCE, in the final frame (clamping per
 *     quarter made a -90 three lossy moves instead of one).
 */
export function turnAnnotation(anno, steps, W, H) {
  const out = { ...anno };
  const isWhiteout = anno.type === 'whiteout';
  const ext = extentOf(anno);
  let rect = { x: anno.x || 0, y: anno.y || 0, w: ext.w, h: ext.h };
  let cx = rect.x + ext.w / 2;
  let cy = rect.y + ext.h / 2;
  const births = {};
  for (const key of BIRTH_RECTS) if (anno[key]) births[key] = { ...anno[key] };
  let dw = W;
  let dh = H;
  for (let i = 0; i < steps; i += 1) {
    if (isWhiteout) rect = turnRect(rect, dh);
    for (const key of Object.keys(births)) births[key] = turnRect(births[key], dh);
    [cx, cy] = [dh - cy, cx];
    [dw, dh] = [dh, dw];
  }
  Object.assign(out, births);
  if (isWhiteout) {
    out.x = rect.x;
    out.y = rect.y;
    if (steps % 2 === 1) { out.width = anno.height; out.height = anno.width; }
  } else {
    const clamp = (v, max) => Math.min(Math.max(v, 0), Math.max(max, 0));
    out.x = clamp(cx - ext.w / 2, dw - ext.w);
    out.y = clamp(cy - ext.h / 2, dh - ext.h);
  }
  return withBlockFollowing(out, anno);
}

/**
 * `moved` (a copy of `before` whose x/y changed) with its paragraph block's
 * display anchor carried by the same delta. block.disp is the block's first
 * baseline in the displayed frame and the file draws a declined block from it
 * (export.js drawBlockText), so an x/y change that leaves it behind is a drag
 * the screen shows and the download ignores. A NEW block object: history
 * snapshots share `block` by reference.
 */
export function withBlockFollowing(moved, before) {
  if (!before.block?.disp) return moved;
  const dx = (moved.x || 0) - (before.x || 0);
  const dy = (moved.y || 0) - (before.y || 0);
  if (!dx && !dy) return moved;
  const d = before.block.disp;
  return { ...moved, block: { ...before.block, disp: { x: d.x + dx, y: d.y + dy } } };
}
