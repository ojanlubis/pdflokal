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
 *   - a page turn rotates the frame         → turnAnnotation
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

// The objects drawn turned (render/page-view.js applyTurn, core/export.js
// objectPoint). A whiteout turns as a rect instead (turnAnnotation).
const TURNS_WITH_PAGE = new Set(['text', 'signature']);

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
 * The quarter turn an object's content carries, clockwise in the displayed
 * frame: 0, 90, 180 or 270. Absent (every object never turned) is 0.
 */
export function turnOf(anno) {
  const t = anno && anno.turn;
  return t === 90 || t === 180 || t === 270 ? t : 0;
}

/**
 * A vector (px, py) in the object's OWN frame (as if unturned) expressed in
 * the displayed frame. The displayed frame is y-down, so one clockwise quarter
 * maps (px, py) to (-py, px): right becomes down. CSS rotate(90deg) applies
 * the same matrix, which is why page-view.js can draw a turn with it.
 */
export function turnVector(turn, px, py) {
  switch (turn) {
    case 90: return { x: -py, y: px };
    case 180: return { x: -px, y: -py };
    case 270: return { x: py, y: -px };
    default: return { x: px, y: py };
  }
}

/**
 * The axis-aligned box the screen shows for `anno` whose own (unturned)
 * extent is `ext`: the box {0, 0, w, h} turned about the object's origin
 * (x, y). 0 -> [x, y, w, h]; 90 -> [x - h, y, h, w]; 180 -> [x - w, y - h,
 * w, h]; 270 -> [x, y - w, h, w].
 */
export function displayedBox(anno, ext) {
  return displayedRect(anno, 0, 0, ext.w, ext.h);
}

/**
 * The same, for a rect at own-frame offset (ox, oy) from the origin: a
 * paragraph's painted block, say, which does not start at the origin.
 */
export function displayedRect(anno, ox, oy, w, h) {
  const turn = turnOf(anno);
  const pts = [[ox, oy], [ox + w, oy], [ox, oy + h], [ox + w, oy + h]].map(([px, py]) => turnVector(turn, px, py));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  return { x: (anno.x || 0) + x0, y: (anno.y || 0) + y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 };
}

/**
 * A screen-frame drag (dx, dy) expressed in `anno`'s own unturned frame: the
 * delta a resize handle means. On an object turned 90, dragging DOWN grows its
 * own width.
 */
export function ownDelta(anno, dx, dy) {
  return turnVector((360 - turnOf(anno)) % 360, dx, dy);
}

/**
 * `anno` after its page turns `steps` quarters clockwise (0-3; a -90 is 3).
 * `W`/`H` are the displayed size BEFORE the turn.
 *
 * THE RULE, FOUNDER RULING 2026-10-11 (seat decisions.md, "semua harus ngikut
 * rotasi"): EVERYTHING on a page turns with it, like ink on paper. It
 * overrules the 2026-10-10 call that kept signatures and text upright and
 * moved only their spot. Two shapes, one motion:
 *   - a whiteout (Tip-Ex, or an edit cover) is a plain rect: it rotates as a
 *     rect, width and height swap, its birth rects with it. It carries no
 *     `turn`, because page-surgery.js reads those rects as axis-aligned boxes.
 *   - anything else (signature, text) keeps its OWN size and gains `turn`
 *     (turnOf: 0/90/180/270 clockwise). x/y are the object's ORIGIN (text: the
 *     top-left of its first line in its own reading frame; signature: the
 *     image's own top-left), and an origin is a point: one quarter maps it
 *     (x, y) -> (H - y, x). No extent enters the move, so text needs no width
 *     estimate, nothing needs a clamp (a rigid turn maps the page onto the
 *     page), and four quarters are exactly the identity.
 * The screen draws the turn as a CSS rotate about the origin
 * (render/page-view.js applyTurn) and the file as pdf-lib's rotate about the
 * same point (core/export.js); displayedBox above is the box both show.
 */
export function turnAnnotation(anno, steps, W, H) {
  const out = { ...anno };
  const isWhiteout = anno.type === 'whiteout';
  const ext = extentOf(anno);
  let rect = { x: anno.x || 0, y: anno.y || 0, w: ext.w, h: ext.h };
  let x = anno.x || 0;
  let y = anno.y || 0;
  const births = {};
  for (const key of BIRTH_RECTS) if (anno[key]) births[key] = { ...anno[key] };
  let dw = W;
  let dh = H;
  for (let i = 0; i < steps; i += 1) {
    if (isWhiteout) rect = turnRect(rect, dh);
    for (const key of Object.keys(births)) births[key] = turnRect(births[key], dh);
    [x, y] = [dh - y, x];
    [dw, dh] = [dh, dw];
  }
  Object.assign(out, births);
  if (isWhiteout) {
    out.x = rect.x;
    out.y = rect.y;
    if (steps % 2 === 1) { out.width = anno.height; out.height = anno.width; }
  } else {
    out.x = x;
    out.y = y;
    // Only what the screen and the file draw turned carries a turn; a
    // watermark/pageNumber (unreachable from v2) just has its spot moved.
    if (TURNS_WITH_PAGE.has(anno.type)) {
      const turn = (turnOf(anno) + 90 * steps) % 360;
      if (turn) out.turn = turn;
      else delete out.turn;
    }
  }
  return withBlockFollowing(out, anno);
}

/**
 * `moved` (a copy of `before` whose x/y changed) with its paragraph block's
 * display anchor carried by the same delta. block.disp is the block's first
 * baseline, and the file draws a declined block from it (export.js
 * drawBlockText), so an x/y change that leaves it behind is a drag the screen
 * shows and the download ignores. A NEW block object: history snapshots share
 * `block` by reference.
 *
 * On a turned block (turnOf > 0) disp is NOT the baseline's displayed point:
 * a turn translates it with x/y, so `disp - (x, y)` stays the offset in the
 * block's OWN unturned frame. That is the frame renderBlockRows lays rows out
 * in (inside an element rotated about x/y) and the one drawBlockText turns
 * through turnVector, so both stay exact.
 */
export function withBlockFollowing(moved, before) {
  if (!before.block?.disp) return moved;
  const dx = (moved.x || 0) - (before.x || 0);
  const dy = (moved.y || 0) - (before.y || 0);
  if (!dx && !dy) return moved;
  const d = before.block.disp;
  return { ...moved, block: { ...before.block, disp: { x: d.x + dx, y: d.y + dy } } };
}
