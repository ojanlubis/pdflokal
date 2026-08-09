/*
 * PDFLokal — core/annotation-order.js  (PAINT ORDER — SINGLE SOURCE OF TRUTH)
 * ============================================================================
 * Tip-Ex is a GROUND, not a layer. Founder ruling 2026-08-09, verbatim:
 *
 *   "it should be default that the layer order on the canvas is tipex at the
 *    bottom and teks at top. by definition. we're not photoshop. we're
 *    pdflokal. on text file, people use tipex to either erase a printed text,
 *    or to write over those. if they want to erase what they wrote using teks
 *    tool, they just got to delete the text, no need to tipeks it."
 *
 * WHY THIS MODULE EXISTS AT ALL, rather than a sort at each draw point: there
 * are TWO painters — js/render/page-view.js (the screen) and js/core/export.js
 * (the file) — and before this ruling neither had any notion of order, so both
 * simply walked `page.annotations` in creation order. Two orderings maintained
 * separately is how the screen and the file come to disagree, which is the
 * exact class of bug the /Rotate discard (same day) turned out to be. One
 * constant, imported by both.
 *
 * ⚠️ THE ARRAY IS NEVER MUTATED. `orderedForPaint()` returns a COPY.
 * `js/core/page-surgery.js`'s applyPageSurgery is handed the SAME annotation
 * array and pairs each Ganti cover to its replacement text by walking it in
 * CREATION order — reordering in place would silently re-pair covers to the
 * wrong text and break the edit engine. That is avoided by construction here,
 * not by a test downstream.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: invent an order he did not ask for.
 * He ruled Tip-Ex to the bottom, full stop. Everything else shares one rank
 * and keeps creation order among itself — so a signature laid over text still
 * covers it, exactly as it does today.
 */

// Rank 0 paints FIRST (bottom). Anything unlisted is DEFAULT_RANK.
// WHY whiteout alone: it is the only annotation whose PURPOSE is to be
// underneath — it erases the printed page so something else can sit on the
// cleared ground. Every other type is content the user put on top.
export const ANNOTATION_RANK = Object.freeze({ whiteout: 0 });
export const DEFAULT_RANK = 1;

export function annotationRank(anno) {
  const r = ANNOTATION_RANK[anno?.type];
  return Number.isInteger(r) ? r : DEFAULT_RANK;
}

// Annotations in PAINT order: rank ascending, creation order within a rank.
//
// Returns a NEW array — see the mutation warning above. The index tiebreak is
// explicit rather than leaning on Array#sort's specified stability: the
// guarantee is what this function IS, so it should be visible in it.
export function orderedForPaint(annotations) {
  return (annotations || [])
    .map((anno, i) => ({ anno, i }))
    .sort((a, b) => (annotationRank(a.anno) - annotationRank(b.anno)) || (a.i - b.i))
    .map(({ anno }) => anno);
}

// The screen's z-index for one annotation. SELECTED IS TOP-OF-ITS-OWN-BAND,
// never top of everything: page-view.js used to give the held annotation
// z-index 1000 outright, so a Tip-Ex you were dragging LOOKED like it was
// above your text and dropped behind the moment you let go. The screen lied
// during editing, and the file was the honest one. A buried whiteout still
// lifts above its neighbours (so it stays grabbable) and still never floats
// above text.
//
// Band arithmetic: rank r occupies [r*100, r*100+99]. Within a band, 10 for a
// normal annotation and 50 for the selected one; DOM order (already paint
// order, because the caller appends via orderedForPaint) breaks the remaining
// ties, which is what keeps the screen and the file agreeing.
export function annotationZIndex(anno, { selected = false } = {}) {
  return annotationRank(anno) * 100 + (selected ? 50 : 10);
}
