# Backlog

Running list of UI/UX findings + small fixes to pick up later. Append new items at the top of **Open**; move to **Done** when shipped.

**Entry format:**
- `[severity] short title` — `file:line` or area
  - What the user saw
  - Suggested fix (optional, one line)

**Severities:** `crit` (blocks core flow) · `high` (visible UX regression) · `med` (nuisance) · `low` (polish).

---

## Open

- **[high]** REVERT auto-switch-to-Pilih for whiteout (PR #60) — [canvas-events.js:425-433](js/editor/canvas-events.js#L425-L433)
  - PR #60 made whiteout switch back to Pilih after every drag. In practice that's wrong for whiteout — covering multiple secrets / redacting a page is a multi-stamp workflow, and forcing the user to re-click Whiteout between every box is more friction than the original "sticky" complaint. The auto-switch IS still right for text (one annotation per click → wants to move it) and signature/paraf (already auto-switched pre-#60). Whiteout is the outlier.
  - Fix: delete the `window.ueSetTool('select')` call inside the whiteout success branch added by #60. Update the two whiteout regression tests (`whiteout: tool switches to select after a valid drag` + `whiteout: tiny no-op drag does NOT switch tool`) to assert `tool === 'whiteout'` after a valid drag instead. Leave the text-inline and signature/paraf auto-switch paths untouched.

- **[med]** Drag-and-drop file onto sidebar should APPEND pages to current document — [sidebar.js:193](js/editor/sidebar.js#L193) (drop currently only handles thumbnail reorder, not file drops) and [navigation.js:208-236](js/lib/navigation.js#L208-L236) (workspace-level drop replaces the file)
  - Today the only way to add more pages is the "Tambah File" button in the sidebar dropdown. Dropping a PDF on the editor canvas REPLACES via `loadPDFForTool` (Gabung tool path), and dropping on the sidebar gets eaten by the reorder handler. User intent is obvious: drop on the page list = "add these to my doc".
  - Fix: in `setupSidebarDragDrop` (sidebar.js:162), add a `drop` branch that detects `e.dataTransfer.files.length > 0` (file drop vs internal reorder which uses `e.dataTransfer.getData('text/plain')`). On file drop, call `ueAddFiles(Array.from(e.dataTransfer.files))` — same path as the dropzone-on-homepage flow. Also add visible drop-hover styling on `#ue-thumbnails` so users see the drop target.

- **[med]** Signature upload tab should accept Ctrl/Cmd+V (paste image from clipboard) — [init-file-handling.js:319-340](js/init-file-handling.js#L319-L340) (existing paste handler doesn't branch on signature modal)
  - Today users have to download a signature image, save it, then upload from disk — three round-trips for what's already on their clipboard (screenshot from another app, image copied from chat, etc.). The global `handlePaste` already routes images for img-tools but ignores them when the signature/paraf modal is open.
  - Fix: in `handlePaste`, before the existing img-tool branches, check `document.getElementById('signature-modal')?.classList.contains('active')`; if so, call `loadSignatureImage(file)` (already exported from pdf-tools/index.js, same one the file-input uses at init-file-handling.js:131). Same branch for `paraf-modal` if/when paraf gets an upload tab. Bonus: auto-switch to the "Upload Foto" tab if user pastes while on the "Gambar" tab.

- **[high]** Arrow keys when a text annotation is selected should nudge it 1px (Shift+arrow = 10px) for precise placement — [keyboard.js:73-74](js/keyboard.js#L73-L74)
  - Right now ArrowLeft/Right always navigate pages, even when the user has a text annotation selected and is trying to fine-tune position. Power users (and anyone filling forms) reach for arrows expecting the standard nudge behavior. Today the only way to move 1px is mouse drag with a steady hand — frustrating on trackpads, impossible on mobile.
  - Fix: in `keyboard.js` arrow handlers, if `ueState.selectedAnnotation` resolves to a non-locked annotation, nudge `anno.x` / `anno.y` by 1 (or 10 with `e.shiftKey`) and call `ueRedrawAnnotations()` + `ueUpdateConfirmButtonPosition(anno)`. Skip page navigation in that case. Save undo state once at the start of a nudge run (debounce 500ms so a burst of taps is one undo entry, not 30).

- **[med]** Mixed page sizes survive merge — exported PDF keeps each page at its source size — [pdf-export.js:164-167](js/editor/pdf-export.js#L164-L167) (no normalization option)
  - User merges an A4 PDF with a phone-camera image and a Letter-size receipt; the output keeps three different page sizes. GF complained — looks unprofessional, hard to print. Today there's no UI to choose "fit all to A4" vs "keep original sizes".
  - Fix: add a toggle in the editor Download dialog or the Gabungkan modal: `[ ] Samakan ukuran semua halaman ke A4`. When checked, before `pdfDoc.addPage(pageSize)` in `ueBuildFinalPDF`, override `pageSize` to A4 (portrait) and scale the source canvas to fit. Annotations need to rescale too — track ratio per page and multiply anno coords. Default OFF to preserve current behavior. Bonus: detect when sizes differ and surface the toggle prominently with a hint toast.

- **[high]** Ctrl/Cmd+Z while drawing a signature undoes a document annotation instead of the signature stroke — [keyboard.js:112-115](js/keyboard.js#L112-L115)
  - User draws a signature in the signature/paraf modal; Ctrl+Z fires the global editor undo (`ueUndo()`) and rolls back an annotation on the PDF underneath instead of erasing the last pen stroke. Worse: nothing in the signature canvas changes, so user thinks the shortcut is broken and keeps pressing it — eating multiple undos.
  - Fix: in `keyboard.js`'s modifier-combo branch, check whether `signature-modal` or `paraf-modal` has `.active`; if so, route to `state.signaturePad.fromData(state.signaturePad.toData().slice(0, -1))` (SignaturePad has no native `undo()` but supports the data-rewind pattern). Same for `state.parafPad`. Bonus: extend to `inline-text-editor` open state — Ctrl+Z there should let contentEditable's native undo run.

- **[med]** `ueRemoveAnnotation` and `rebuildAnnotationMapping` leave `selectedAnnotation` stale — [annotations.js:134](js/editor/annotations.js#L134), [page-manager.js:323](js/editor/page-manager.js#L323)
  - Root cause behind Sentry JAVASCRIPT-4. `ueRemoveAnnotation` only clears selection on EXACT `(pageIndex, index)` match — so deleting annotation 0 with selection at index 1 leaves selection pointing to a now-shifted slot. `rebuildAnnotationMapping` (page reorder/delete) never touches selection at all.
  - Defensive guards in canvas-events.js + canvas-utils.js stop the crash (shipped). True fix: (a) `ueRemoveAnnotation` should decrement `selectedAnnotation.index` when removing an earlier sibling, and null when removing past-end; (b) `rebuildAnnotationMapping` should reindex selection through `oldPages.indexOf(pageRef)` like it does for annotations.

- **[med]** Sidebar page-number badge too large and too centered, covers thumbnail content — [style.css:2536-2547](style.css#L2536-L2547) (`.ue-thumbnail-number`)
  - Big dark rounded badges (1, 2, 3…) sit mid-thumbnail on a multi-page document. Current CSS: `bottom: var(--space-sm)` + `padding: 4px 10px` + `font-size: 0.75rem`. On short landscape thumbnails the badge dominates the visible area.
  - Fix candidates: shrink badge (font 0.65rem / padding 2px 6px), move to a corner (top-right), or fade out unless thumbnail is hovered/selected.

---

## Done

(none yet)
