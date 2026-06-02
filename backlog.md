# Backlog

Running list of UI/UX findings + small fixes to pick up later. Append new items at the top of **Open**; move to **Done** when shipped.

**Entry format:**
- `[severity] short title` — `file:line` or area
  - What the user saw
  - Suggested fix (optional, one line)

**Severities:** `crit` (blocks core flow) · `high` (visible UX regression) · `med` (nuisance) · `low` (polish).

---

## Open

- **[med]** `ueRemoveAnnotation` and `rebuildAnnotationMapping` leave `selectedAnnotation` stale — [annotations.js:134](js/editor/annotations.js#L134), [page-manager.js:323](js/editor/page-manager.js#L323)
  - Root cause behind Sentry JAVASCRIPT-4. `ueRemoveAnnotation` only clears selection on EXACT `(pageIndex, index)` match — so deleting annotation 0 with selection at index 1 leaves selection pointing to a now-shifted slot. `rebuildAnnotationMapping` (page reorder/delete) never touches selection at all.
  - Defensive guards in canvas-events.js + canvas-utils.js stop the crash (shipped). True fix: (a) `ueRemoveAnnotation` should decrement `selectedAnnotation.index` when removing an earlier sibling, and null when removing past-end; (b) `rebuildAnnotationMapping` should reindex selection through `oldPages.indexOf(pageRef)` like it does for annotations.

- **[med]** Sidebar page-number badge too large and too centered, covers thumbnail content — [style.css:2536-2547](style.css#L2536-L2547) (`.ue-thumbnail-number`)
  - Big dark rounded badges (1, 2, 3…) sit mid-thumbnail on a multi-page document. Current CSS: `bottom: var(--space-sm)` + `padding: 4px 10px` + `font-size: 0.75rem`. On short landscape thumbnails the badge dominates the visible area.
  - Fix candidates: shrink badge (font 0.65rem / padding 2px 6px), move to a corner (top-right), or fade out unless thumbnail is hovered/selected.

---

## Done

(none yet)
