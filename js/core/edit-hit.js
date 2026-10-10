/*
 * PDFLokal — core/edit-hit.js  (WHICH COMMITTED EDIT DOES A TAP LAND ON)
 * ============================================================================
 * Moved headless (2026-10-10) out of js/v2/app.js, where these could only be
 * reached through a browser. Pure: the page model in, an edit (or null) out.
 * The two things that are DOM or app policy are injected, not imported:
 *   - `measure(textAnno)`: the painted width of a text annotation (the app
 *     passes render/page-view.js measureTextAnnoWidth, the overlay's own font
 *     stack, so the target matches what the user sees);
 *   - `minHit`: the finger-sized minimum (js/v2/text-runs.js MIN_HIT), one
 *     hit-box law for every tap in the editor.
 */
import { pageEdits } from './page-surgery.js';
import { blockExtent } from './block-edit.js';
import { resolveTap } from './text-lines.js';

// spec-live-surgery.md §5 Decision 3 (increment 4 — re-edit): does `x, y`
// land inside a committed edit's OWN box? Scoped to page.annotations (the
// live model — never the pristine source), so this is orthogonal to
// textRuns.hitTest, which only ever knows about the ORIGINAL bytes and would
// have no idea an edit exists at all. Boxes come from each edit's cover's
// replaceBox — the pristine-source line geometry captured at the edit's
// BIRTH, not the cover's current x/y/width/height — because that birth box
// is the one guaranteed to still be the honest target (a committed edit
// never drags, spec Decision 1, but anchoring to replaceBox rather than
// "wherever the cover currently sits" is the same defensive discipline
// core/page-surgery.js's own overlapsBirthBox already applies at export/bake
// time). Reuses core/text-lines.js's resolveTap (same clamped, finger-sized
// inflation as every other tap) scoped to just this page's edited lines, so
// a tap that's a few px off a small edited line still resolves the same way
// a fresh line tap would.
export function hitTestEditedLine(page, x, y, { measure, minHit }) {
  const edits = pageEdits(page);
  if (edits.length === 0) return null;
  const boxes = edits.map((edit) => {
    const b = edit.cover.replaceBox;
    // RUNG D: a committed paragraph paints as its block — box width, one
    // leading per painted line — not as one long line of its whole text.
    const blk = edit.replacement?.block;
    if (blk && Array.isArray(blk.lines)) {
      const e = blockExtent(blk, edit.replacement.y);
      const x0 = Math.min(b.x, e.x);
      const y0 = Math.min(b.y, e.y);
      return { x: x0, y: y0, w: Math.max(b.x + b.w, e.x + e.w) - x0, h: Math.max(b.y + b.h, e.y + e.h) - y0, edit };
    }
    // FIELD REPORT 2026-08-26: the birth box ALONE is not the whole target.
    // Everything above is still true — the box is the honest ANCHOR, and a
    // committed edit never drags — but the REPLACEMENT is free to be longer
    // than the words it replaced, and then it paints past the box that
    // birthed it. Hit-testing the anchor alone left the visible overflow
    // dead: a tap there missed here, then fell through to the fresh
    // textRuns.hitTest against the PRISTINE source, where the original line
    // had already ended — so neither branch matched and the tap did nothing
    // at all. A user with a replacement wider than its original simply could
    // not reopen their own edit ("tidak bisa di edit lagi"), with no toast
    // and nothing in the rail to say so.
    //
    // So: anchor UNION painted extent. Union, never replace — the box stays
    // the floor, so this can only ever grow the target, never move or shrink
    // one that already worked. Width comes from `measure` (the app passes
    // render/page-view.js's own measurer, i.e. the same font stack the overlay
    // paints with), because the region has to match what the user SEES.
    const painted = measure(edit.replacement);
    if (!painted) return { x: b.x, y: b.y, w: b.w, h: b.h, edit };
    const r = edit.replacement;
    // 1.2 is renderAnnotationEl's own line-height for a text annotation.
    const rh = (r.fontSize || 24) * 1.2;
    const x0 = Math.min(b.x, r.x);
    const y0 = Math.min(b.y, r.y);
    const x1 = Math.max(b.x + b.w, r.x + painted);
    const y1 = Math.max(b.y + b.h, r.y + rh);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, edit };
  });
  const hit = resolveTap(boxes, x, y, minHit);
  return hit ? hit.edit : null;
}


// A tap inside an already-committed S2 edit. Mirrors hitTestEditedLine one
// ladder over, including anchoring to the BIRTH box rather than to wherever
// the cover currently sits.
export function hitTestOcrEdit(page, x, y, minHit) {
  const covers = page.annotations.filter((a) => a.type === 'whiteout' && a.ocrBox);
  if (covers.length === 0) return null;
  const hit = resolveTap(
    covers.map((c) => ({ x: c.ocrBox.x, y: c.ocrBox.y, w: c.ocrBox.w, h: c.ocrBox.h, cover: c })),
    x, y, minHit,
  );
  if (!hit) return null;
  return {
    cover: hit.cover,
    replacement: page.annotations.find((a) => a.type === 'text' && a.ocrCoverId === hit.cover.id) || null,
  };
}


// Which committed edit OWNS a printed line: the one whose BIRTH box holds the
// line's centre. Geometric, never inflated: a deleted line has no ink to show
// where its box ends, so the finger-sized inflation hitTestEditedLine applies
// would swallow taps meant for the line beside it (Hapus, 2026-10-02).
export function editOwningLine(page, line) {
  const cx = line.x + line.w / 2;
  const cy = line.y + line.h / 2;
  return pageEdits(page).find(({ cover }) => {
    const b = cover.replaceBox;
    return cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
  }) || null;
}
