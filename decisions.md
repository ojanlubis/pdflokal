# `app/` — bench decisions (code-level WHY)

Founder rulings and product judgment live at the seat: `../decisions.md`. This file holds only
code-level WHY that has no other home — the reasoning behind an implementation shape, so that
`CLAUDE.md` can state the resulting law in one line without arguing for it.

Append-only. Newest at the bottom.

---

## 2026-07-30 — relocated out of `CLAUDE.md` during the prune

`CLAUDE.md` was pruned from 42 kB to a law-only file. Everything relocated below was checked against
`../decisions.md` and the bench memory bank first; only the items with no existing home were written
here. (Already-recorded whys — the push-authority ruling and its history, the 2026-07-28 gate/SEO
half-ship incident, the SEO generator blank-pages incident, the canvas-eviction history, the
`CLAUDE.md`-contradicts-itself audit finding — were deleted rather than copied.)

### Why the Edit engine is cut + stamp, and not hand-written glyph operators

A PDF has no text, only instructions to paint glyphs. So editing text that is already printed means
**cut + stamp**: `js/core/text-walk.js` interprets the content stream to find and remove the original
show-ops, then `js/core/stamp.js` picks a font it can *prove* is right (the document's own embedded
program → a bundled metric clone → a generic twin) and lets **pdf-lib** lay the replacement out.

The alternative was built, shipped, and then deleted: hand-writing the glyph operators ourselves,
**−1118 LOC**. It was not removed because it failed a test — it was removed because its bug class was
**unbounded**. Every document encoding, every subset, every CID mapping was a new way for the output
to be subtly wrong, and there was no finite set of cases to cover. Delegating layout to pdf-lib
bounds the problem to font selection.

Two laws came out of that deletion, and both now live in `CLAUDE.md` as instructions:

1. **Read the artifact, not its label.** A font wrapper claiming `CIDFont+F1` can *be* `Arial-BoldMT`.
   Names in a PDF are hints written by whatever produced the file; the program is the truth.
2. **The export path derives from the document, never inherits from UI state that may not have
   loaded.** State that exists on screen is not state that exists at export time.

### Why `docs/legacy/future-architecture.md`'s numbered plan is no longer tracked in `CLAUDE.md`

Items 1 (reactive state layer, `js/lib/events.js` pub/sub) and 1b (`PageRenderer` class in
`page-rendering.js`) were **completed in March 2026**; a completed plan item read as an open one for
four months. Item 2 (Web Workers for PDF export + compression) is still future work and belongs in
the seat's queue, not in a code-guidance file. The document itself remains at
`docs/legacy/future-architecture.md` for anyone starting a major refactor.
