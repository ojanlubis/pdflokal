# Backlog

Running list of UI/UX findings + small fixes to pick up later. Append new items at the top of **Open**; move to **Done** when shipped.

**Entry format:**
- `[severity] short title` — `file:line` or area
  - What the user saw
  - Suggested fix (optional, one line)

**Severities:** `crit` (blocks core flow) · `high` (visible UX regression) · `med` (nuisance) · `low` (polish).

---

## Open

- **[high]** User can't pick a font family for text annotations — [inline-editor.js](js/editor/inline-editor.js), [text-modal.js](js/pdf-tools/text-modal.js), [state.js CSS_FONT_MAP](js/lib/state.js)
  - User report (Jun 10): font dropdown is either not visible in the inline text editor flow, or the selection doesn't actually apply to the annotation. Options exist in state (Helvetica, Times Roman, Courier, Montserrat, Carlito — confirmed in DOM during Jun 9 prod test) so this is a wiring/UI bug, not a missing feature.
  - Investigation before fix: confirm whether the font picker is shown in BOTH the modal-first text creation AND the inline-text-on-first-click flow (PR #54). If only one path exposes it, that's the gap. Also check whether `applyEditorText` reads the font from the picker state at apply time.

- **[high]** User can't bold (or italic) text annotations — [inline-editor.js](js/editor/inline-editor.js), [text-modal.js](js/pdf-tools/text-modal.js), [annotations.js drawTextAnnotation](js/editor/annotations.js)
  - User report (Jun 10): bold/italic toggle is missing or non-functional. State factory `createTextAnnotation` supports `bold` + `italic` flags, and `buildCanvasFont` maps them to CSS, so the data model is ready — UI just isn't writing the flag, or render isn't reading it back at the right time.
  - Investigation before fix: check whether the inline editor exposes B/I controls at all (might be modal-only), and whether `_editing` flag handling preserves bold/italic across modal→inline transitions and undo/redo cycles.

- **[crit]** Ganti File regression: PDF.js doc cache stays stale, new file partially loads — [page-rendering.js _pdfDocCache](js/editor/page-rendering.js), [sidebar.js ueReplaceFiles](js/editor/sidebar.js)
  - User report (Jun 9, prod test on both): page count updates to new file, but main canvas shows OLD content (or blank), sidebar thumb stale. PR #64 fixed the `destroyPageRenderer` issue; this is a separate bug.
  - **AI exploratory repro on prod (Jun 9, 12:00 WIB) — STRONG EVIDENCE for hypothesis #2** (`_pdfDocCache` stale):
    - Loaded sample-2pages.pdf → Ganti File → uploaded distinct alt-1page.pdf (big red "ALT PDF" text + yellow rectangle, A4)
    - **State looked correct**: `ueState.pages.length=1`, `sourceFiles=['alt-1page.pdf']`, `pageCachesKeys=['0']`, page dimensions correct (1104×1562 = A4 at 1.85x)
    - **`page.thumbCanvas` (300×425) RENDERED CORRECTLY**: yellow rectangle pixels at y=170 (rgb 230,230,51). So PDF.js can read the new file — `handlePdfFile`'s pre-render works.
    - **Main canvas (1104×1562) was 100% blank**: all 81 sampled regions = pure white. PDF.js never drew into it after Ganti File. IntersectionObserver fired (page slot visible) but renderPageCanvas was no-op.
    - **Click → text tool → click on blank canvas → "Test Page 1" appeared** — that's content from the ORIGINAL sample-2pages.pdf. The render-on-interaction pulled from the STALE cached PDF.js doc, not the new one.
    - Positive control: fresh load of alt-1page.pdf (without Ganti File) → renders perfectly. The bug is specific to the Ganti File flow.
  - **Root cause (high confidence)**: PageRenderer's `_pdfDocCache` Map keys by source-file URL or by `pages[i]._docRef` — when Ganti File runs, `ueReset` does NOT call `clearPdfDocCache()`. Next render either skips (cache says "already have doc, no need to re-fetch") or hits the cached old doc.
  - Verification before fixing: add `console.log` in PageRenderer's renderPageCanvas to print `pageIndex`, `pages[i].sourceFile`, and `_pdfDocCache.has(key)`. Repro Ganti File and confirm cache key collision.
  - **Trivial fix candidate**: `clearPdfDocCache()` inside `ueReplaceFiles()` before `ueAddFiles()` runs. Plus invalidate `pageCaches` ImageData (PR #66's bitmap cache) since dimensions and content are now wrong for those keys.
  - **Real-flow test that catches this**: a Playwright test that uses `page.click('label[for=ue-replace-input]')` or actual mouse-driven menu navigation (NOT `setInputFiles` on the hidden input). The Jun 9 prod test caught this because user used the real picker; our scripted test bypassed it.

- **[high]** Mobile fast-scroll sometimes jumps the viewport to page 1 — [page-rendering.js setupScrollSync](js/editor/page-rendering.js)
  - User report (Jun 9, Android Chrome): during the brief restore-from-cache flash (PR #66), occasionally the scroll position snaps back to page 1.
  - Hypothesis (NOT confirmed by code reading): during fast scroll, the scroll-sync 150ms debounce reads `getBoundingClientRect` mid-momentum, computes the wrong "closest page" (possibly index 0), updates `ueState.selectedPage`, and some downstream consumer (mobile page indicator, mobile-ui.js update, or a `selectPage` call I missed) triggers `scrollIntoView(top)`. The scroll sync handler explicitly avoids calling `selectPage` for this reason, but a chained consumer may not.
  - Investigation: instrument the scroll-sync handler + any code that reads `selectedPage` and could scroll. Likely involves `ueMobileUpdatePageIndicator` (window bridge from mobile-ui.js) — read its behavior carefully.

- **[high]** Pinch-zoom flicker is severe on mobile — [page-rendering.js renderVisiblePages](js/editor/page-rendering.js), [zoom-rotate.js](js/editor/zoom-rotate.js)
  - User report (Jun 9, Android Chrome): pinch-to-zoom flickers very badly and uncontrollably.
  - Diagnosis (high confidence): zoom changes canvas dimensions → `pageCaches` entries become dimension-mismatched → `restoreCanvasFromCache` early-returns on the size guard → falls back to async PDF.js re-render via `renderVisiblePages` → produces visible blank-then-content states across all visible pages simultaneously. PR #66 doesn't help here by design.
  - Fix candidates (none cheap):
    - **(a) CSS scale during pinch**: apply `transform: scale(zoom)` to the page slots during pinch, only re-render the canvas buffer on pinch-end (the gesture itself is preview-quality, the commit is high-quality). Lower flicker risk; intermediate frames are scaled-pixel renders.
    - **(b) Double-buffer**: render to off-DOM canvas, swap when ready. Doubles memory during render.
    - **(c) Defer re-render**: only re-render once pinch settles (debounce). Final state is correct; during pinch, canvas stays at old zoom level visually until release. Trade-off: misleading "stale" state mid-gesture.
    - Author's lean: (a) — matches user expectation (pinch = preview, release = commit) and is the cheapest to ship.

- **[low]** Paraf "Konfirmasi" + delete buttons hidden behind canvas on mobile — [signatures.js ueShowConfirmButton](js/editor/signatures.js), [style.css](style.css) (`--z-canvas-ui: 20`)
  - User report (Jun 9, Android Chrome): after placing a paraf, the confirm/delete buttons render UNDER the canvas instead of on top of it.
  - Diagnosis: z-index ordering. The `signature-btn-wrapper` sits in `#ue-canvas-wrapper` which has its own stacking context on mobile. The current `--z-canvas-ui: 20` isn't winning against something else in the mobile layout.
  - Fix: bump `--z-canvas-ui` OR explicitly set `z-index: var(--z-canvas-ui)` on `.signature-btn-wrapper` + verify the stacking context. User noted this isn't critical to the app's function but it IS visibly broken.

- **[med]** Root cause for Sentry JAVASCRIPT-7 — `ueState.annotations[selectedPage]` was undefined when "Hapus Edit Halaman Ini" fired — [undo-redo.js:182](js/editor/undo-redo.js#L182) (defensive guard shipped in PR #67)
  - Crash repro hypothesis: user selected a page, then deleted/reordered pages (Gabungkan modal or page-manager). `selectedPage` index was carried over but the per-page annotations bucket wasn't reseated to match. Same fingerprint as the existing stale-selectedAnnotation backlog item — both symptoms of "index map didn't follow page mutation."
  - True fix: ensure every page-array mutation (splice, reorder, delete) re-keys `ueState.annotations` and `ueState.selectedAnnotation` atomically. Probably wrap in a single helper `mutatePages(fn)` that handles the rebind. Same helper would close the stale selection item below.

- **[med]** Root cause for Sentry JAVASCRIPT-8 — a page in `ueState.pages` had no `.canvas` placeholder after drag-reorder, crashed `ueRenderThumbnails` — [sidebar.js:93](js/editor/sidebar.js#L93) (defensive guard shipped in PR #67)
  - Crash repro hypothesis: some code path creates a page object via direct push or restore that bypasses `createPageInfo()` (the SSOT factory that seats the `canvas: {width, height}` placeholder). Suspects: undo restore (undo-redo.js `ueRestorePages`), Gabungkan modal split/extract (`uePmConfirmExtract`), or any path that builds a page after a PDF re-load.
  - Investigation: `grep -rn "ueState.pages.push\|ueState.pages\\[" js/editor/` and check each push site — every one MUST go through `createPageInfo(...)`. Add a dev-mode invariant: in renderPageCanvas/ueRenderThumbnails, when `!page.canvas` log a Sentry breadcrumb so we can identify the offending path next time.

- **[high]** "Ganti File" doesn't open the file picker on Android Chrome (mobile) — [index.html:470](index.html#L470) and [sidebar.js:22-47](js/editor/sidebar.js#L22-L47) and [index.html:503-504](index.html#L503-L504)
  - User reports: on mobile, after a file is loaded, tapping "Ganti File" does nothing. The fix that just shipped (#64) made the REPLACEMENT work — this is a separate issue, the file picker itself never opens.
  - Likely cause: combination of `style="display:none"` on `#ue-replace-input` (line 503-504) PLUS the inline `onclick="ueReplaceFiles(); closeEditorFileMenu()"` on line 470 — `closeEditorFileMenu()` runs synchronously right after `input.click()`, mutating the DOM (removing the `.open` class on the dropdown) inside the same user-gesture tick. Mobile Chrome's hardened picker policy treats `.click()` on `display:none` inputs as suspicious, especially when the surrounding DOM mutates immediately. The home dropzone's `#ue-file-input` works because its trigger button doesn't have a follow-up DOM mutation.
  - Fix: (a) change the input's hiding from `style="display:none"` to a visually-hidden pattern — `position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; overflow: hidden;` — keeps it in the accessibility tree and layout. (b) In the onclick, REORDER to `closeEditorFileMenu(); ueReplaceFiles();` OR defer the close: `ueReplaceFiles(); setTimeout(closeEditorFileMenu, 0);`. Test on real Android Chrome (DevTools emulation won't repro). Same change should be applied to `#ue-file-input` (line 501-502) for safety even though it currently works.

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
