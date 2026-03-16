# CLAUDE.MD - PDFLokal Project Guide

## Project Overview

**PDFLokal** is a 100% client-side PDF and image manipulation tool for Indonesian users. All processing happens in the browser - no files are ever uploaded to a server.

- **Language**: Indonesian (UI text, all copy) - informal "kamu" tone
- **Key Principle**: Privacy first - everything client-side
- **Tech**: Vanilla JS, native ES modules, no build step, no frameworks
- **Libraries**: pdf-lib, PDF.js, Signature Pad, pdf-encrypt-lite, Canvas API — all self-hosted in `js/vendor/`, zero CDN deps (see [docs/security.md](docs/security.md))

## Reference Projects

Before making architectural decisions, check how mature open-source projects solve the same problem. Don't fly blind — learn from projects that have already solved similar challenges at scale.

- **Excalidraw** ([github.com/excalidraw/excalidraw](https://github.com/excalidraw/excalidraw)) — Canvas-based drawing app. Similar: canvas rendering, annotations, tools, undo/redo. React/TS, 103K lines. Patterns: actions-per-file, separate renderer module, extensive tests.
- **PDF.js** ([github.com/nicedoc/pdf.js](https://github.com/nicedoc/pdf.js)) — Mozilla's PDF renderer (we use it as a dep). Vanilla JS, Web Workers, canvas rendering. Patterns: viewer/core separation, worker-based processing.
- **tldraw** ([github.com/tldraw/tldraw](https://github.com/tldraw/tldraw)) — Another canvas drawing app. React/TS. Patterns: state machine for tools, command pattern for undo/redo.
- **Stirling-PDF** ([github.com/Stirling-Tools/Stirling-PDF](https://github.com/Stirling-Tools/Stirling-PDF)) — PDF manipulation tool (server-side Java, but similar feature set). Patterns: tool-per-module, clean separation of concerns.
- **pdf-lib** ([github.com/Hopding/pdf-lib](https://github.com/Hopding/pdf-lib)) — We use this as a dep. Pure JS, no native deps. Patterns: builder pattern, immutable document model.

When facing a design question ("how should we structure X?"), check how these projects handle it first.

## Planned Improvements

Read **[docs/strengths.md](docs/strengths.md)** first — explains WHY vanilla JS, WHY no framework, and WHY AI as primary developer is the core architectural decision.

See **[docs/future-architecture.md](docs/future-architecture.md)** before starting any major refactor.
Key ideas captured there:
1. **Reactive state layer** — COMPLETED (Mar 2026). `js/lib/events.js` pub/sub emitter
1b. **PageRenderer class** — COMPLETED (Mar 2026). Render pipeline encapsulated in `page-rendering.js`
2. **Web Workers** — offload PDF export + compression off the main thread (future)

## Core Architecture

### File Structure

```
pdflokal/
├── index.html          # Main application - all PDF/image tools
├── dukung.html         # Donation/support page
├── privasi.html        # Privacy policy page
├── style.css           # All styles (includes @font-face)
├── vercel.json         # Security headers, CSP, rewrites
├── js/
│   ├── init.js               # Entry point: bootstrap, compat check, mobile detection
│   ├── init-file-handling.js  # Dropzone, file inputs, paste handler, setupFileInput factory
│   ├── init-ui.js            # Tool cards, signature pads, modal backdrop close
│   ├── keyboard.js           # Keyboard shortcuts + modal
│   ├── mobile-ui.js          # Mobile nav, page picker, tools dropdown
│   ├── changelog.js          # Changelog notification system
│   ├── theme.js              # Theme toggle (light/dark)
│   ├── image-tools.js        # Image tools (compress, resize, convert, remove-bg)
│   ├── img-to-pdf.js         # Images-to-PDF tool (add, reorder, generate)
│   ├── lib/
│   │   ├── state.js          # State objects, constants, SSOT helpers, annotation factories
│   │   ├── utils.js          # showToast, downloadBlob, isPDF, isImage, loadPdfDocument, etc.
│   │   └── navigation.js     # showHome, showTool, openModal, closeModal, closeAllModals (MODAL_IDS array)
│   ├── editor/               # Unified Editor (~15 modules)
│   │   ├── index.js          # Barrel re-exports + window bridges
│   │   ├── canvas-utils.js   # ueGetCurrentCanvas, ueGetCoords, ueGetResizeHandle, getThumbnailSource, drawRotatedThumbnail
│   │   ├── annotations.js    # ueRedrawAnnotations, draw helpers, hit testing
│   │   ├── canvas-events.js  # Mouse/touch event delegation on pages container
│   │   ├── inline-editor.js  # Inline text editing overlay (double-click to edit)
│   │   ├── file-loading.js   # ueAddFiles, handlePdfFile, handleImageFile
│   │   ├── lifecycle.js      # initUnifiedEditor, ueReset, signature hints
│   │   ├── page-manager.js   # Gabungkan modal (uePm* functions)
│   │   ├── page-rendering.js # PageRenderer class — slots, rendering, observer, scroll sync
│   │   ├── pdf-export.js     # ueBuildFinalPDF, ueDownload, font embedding
│   │   ├── sidebar.js        # Thumbnails, drag-drop reorder, toggle
│   │   ├── signatures.js     # Signature placement, preview, confirm, delete
│   │   ├── tools.js          # ueSetTool, modal openers, more-tools dropdown
│   │   ├── undo-redo.js      # Both undo stacks (page ops + annotation edits)
│   │   └── zoom-rotate.js    # Zoom in/out/reset, rotate page
│   ├── pdf-tools/            # PDF tool modals (~7 modules)
│   │   ├── index.js          # Barrel re-exports + window bridges
│   │   ├── signature-modal.js
│   │   ├── text-modal.js
│   │   ├── watermark-modal.js
│   │   ├── pagenum-modal.js
│   │   ├── standalone-tools.js  # PDF-to-Image, Compress PDF, Protect PDF only
│   │   └── drag-reorder.js
│   └── vendor/               # Self-hosted libs (2.6 MB), zero CDN deps
├── fonts/              # Self-hosted fonts (268KB, Latin charset)
├── docs/               # Design + reference docs
│   ├── architecture.md # SSOT patterns diagram (scattered vs centralized)
│   ├── editor-redesign.md
│   ├── patterns.md     # Code patterns and examples
│   └── security.md     # Security headers, CSP, library details
└── images/
```

### Single-Page Architecture

Everything lives in `index.html`. Vendor libs load as global `<script>` tags, then a single `<script type="module" src="js/init.js">` imports all app modules. See [docs/security.md](docs/security.md) for library loading order.

### ES Module Architecture

- All app code uses native `import`/`export` - no bundler
- `js/init.js` is the root that imports everything transitively
- Each directory has a barrel `index.js` with re-exports + `window.*` bridges
- Window bridges are required for HTML `onclick` handlers
- Vendor libs accessed via `window.*` in modules
- Circular deps resolved by using `window.*` for one direction of each cycle

See [docs/patterns.md](docs/patterns.md) for import conventions, window bridge pattern, and circular dependency list.

### State Management

State objects live in `js/lib/state.js`. Key objects:

- **`ueState`** - Unified Editor state (pages, annotations, tools, undo stacks, rendering, guards)
- **`uePmState`** - Gabungkan Modal state (merge/split mode, selection, drag)

**SSOT helpers** (Single Source of Truth — see [docs/architecture.md](docs/architecture.md)):
- **`getDefaultUeState()`** (state.js) — returns all default ueState values. Used by initial definition + `ueReset()`. Adding a new field here automatically gets it reset.
- **`createPageInfo()`** (state.js) — factory for page objects. All code paths that create pages must use this (file-loading, undo-redo). Guarantees consistent shape.
- **`getThumbnailSource(pageIndex)`** (canvas-utils.js) — resolves best canvas for thumbnails. Used by sidebar and mobile picker. **Exception**: Gabungkan modal uses `page.thumbCanvas` directly (pageCanvases stale while modal open).
- **Annotation factories** (state.js) — `createWhiteoutAnnotation`, `createTextAnnotation`, `createSignatureAnnotation`, `createWatermarkAnnotation`, `createPageNumberAnnotation`. All annotation creation must use these.
- **`openModal(id)` / `closeModal(id, skipHistoryBack)`** (navigation.js) — standard modal open/close with history management. Use for all modals except signature-bg-modal (custom replaceState).
- **`isPDF(file)` / `isImage(file)`** (utils.js) — file type checks. Use instead of inline `file.type ===` comparisons.
- **`loadPdfDocument(bytes)`** (utils.js) — loads PDF.js document with defensive `.slice()`. Use instead of raw `pdfjsLib.getDocument()`.

Refer to `js/lib/state.js` for full shape and comments on each field.

## Key Features

### Unified Editor (Primary Tool)

The flagship multi-document PDF editor. When users drop a PDF on the homepage, it opens here.

**Architecture:** Multi-canvas continuous vertical scroll. Each page gets its own `<canvas>` in `#ue-pages-container`. Body scroll with IntersectionObserver (`root: null`) for lazy rendering. Render pipeline owned by `PageRenderer` class (singleton in `page-rendering.js`), created/destroyed by `lifecycle.js`. See [docs/patterns.md](docs/patterns.md) for full function reference.

**Editor Layout:**
- **Header** (40px, sticky top:0): `[File v] PDFLokal [moon] [Download PDF]`
- **Floating toolbar** (sticky top:40px, frosted glass): `[Sign | Text | Whiteout | Pilih | Rotate | More v]`
- **Sidebar** (160px, sticky): "Kelola Halaman" button + thumbnails (drag-drop reorderable)
- **Bottom bar** (30px, fixed bottom): `[Dukung Kami] ... [- Zoom +] Hal 2/5 [?]`
- **Mobile bottom bar** (60px, fixed bottom, <=900px): `[< Hal 2/5 >] [More v] [Zoom -/+] [Sign]`
- Mobile (<=900px): sidebar hidden, toolbar icon-only + fixed, header 36px, desktop bottom bar hidden, mobile bottom bar shown

**Features:** Multi-file merge, page reorder/rotate/delete, annotations (whiteout, text, signatures), Gabungkan modal with split mode, zoom, undo/redo (separate stacks for page ops vs annotations), keyboard shortcuts.

**Text annotations:** Font family (Helvetica, Times, Courier, Montserrat, Carlito), bold/italic, size 6-120pt, color presets.

**Signatures:** Upload images (with background removal), draw, auto-lock after placement, double-click to unlock, delete button.

**Paraf (Initials):** Draw-only modal (no upload tab), smaller default size (80px vs 150px signature). Uses `type: 'signature'` with `subtype: 'paraf'` — zero changes needed in annotations/export/undo. "Semua Hal." button copies paraf to all pages at same position. Functions in `signature-modal.js` (openParafModal, useParaf, etc.) + `signatures.js` (ueApplyToAllPages).

**Keyboard Shortcuts:**
| Key | Action |
|-----|--------|
| V | Select/Edit | W | Whiteout | T | Text | S | Signature |
| P | Paraf | R | Rotate 90 CW | Delete | Delete annotation |
| Ctrl+Z/Y | Undo/Redo | Ctrl+S | Download PDF |
| Arrow L/R | Navigate pages | ? | Shortcuts help | Escape | Close/Home |

### Other PDF Tools

- **PDF to Image** - Convert pages to PNG/JPG with batch export
- **Compress PDF** - Compress embedded images within PDFs
- **Protect PDF** - Add password protection (also in editor via "Kunci PDF")

Legacy standalone tools (Merge, Split, Rotate, Watermark, Page Numbers) were removed Feb 2026 - all consolidated into Unified Editor.

### Image Tools

Compress, Resize, Convert Format (JPG/PNG/WebP), Image to PDF, Remove Background.

### Homepage

Hero + dropzone (opens editor), PDF tool cards (Editor, Merge, Split, PDF-to-Image, Compress, Protect), Image tool cards. Merge/Split cards use file-picker-first pattern (see [docs/patterns.md](docs/patterns.md)).

### Navigation & UX

- `body.editor-active` class hides site chrome, removes `.container` max-width
- History API for back button support
- File size warnings: info toast >20MB, block >100MB
- Fullscreen loading overlay for async operations
- Modal click-outside-to-close via `initModalBackdropClose()` in `js/init.js`
- Changelog notification badge at bottom-right (see `js/changelog.js`)

### PDF File Size Optimization

- **Unmodified PDFs:** Detects no edits -> downloads original bytes (no re-encoding bloat)
- **Signatures:** `optimizeSignatureImage()` resizes >1500px, JPEG 85% for photos, PNG only for transparency
- **Export:** `useObjectStreams: true`, format-aware embedding (`embedJpg`/`embedPng`)

## Maintainability (MUST READ)

> Every Claude session starts with total amnesia. Maintainability = "can a future Claude with zero memory work on any file safely?"

**The 3-question test** (before modifying any file):
1. Can I understand it in one read?
2. If I modify one behavior, how much unrelated code must I understand?
3. Can I break something unrelated by touching it?

**Principles:**
1. **One rule, one home.** Search before creating. Mark with `// SINGLE SOURCE OF TRUTH` comment. Never reimplement inline what a helper already does.
2. **WHY comments, not WHAT.** Every non-obvious function gets a `// WHY:` comment explaining what breaks if changed and who decided. Future Claude can't ask "why is this here?" — the comment answers preemptively.
3. **Operation functions own mutation + sync.** Never mutate `ueState.pages` or `ueState.annotations` directly from UI code. Use SSOT operation helpers that bundle the mutation with all required render/sync calls. This prevents the class of bugs where a caller forgets to call `rebuildAnnotationMapping()` or `ueCreatePageSlots()`.
4. **Files are self-contained.** Imports for functionality: fine. Imports for understanding: problem. If you need to read 3 other files to understand one function, refactor.
5. **Parallel arrays are a liability.** `ueState.pages` and `ueState.pageCanvases` must stay in sync — any splice on one must be reflected in the other. Prefer structures that travel together (e.g., `thumbCanvas` on the page object) over parallel arrays.

## Development Guidelines

### Critical Rules

1. **All UI text in Indonesian** (Bahasa Indonesia, "kamu" not "anda")
2. **100% client-side** - never add server dependencies or external API calls with user data
3. **Vanilla JS ES6+** with native modules - no npm dependencies unless absolutely necessary
4. **New exports** must go in barrel `index.js` + `window.*` bridge if used in HTML `onclick`
5. **Privacy first** - files never leave the user's device (see [docs/security.md](docs/security.md))

### Performance

- Target: files up to 50MB comfortably
- Test on mobile + desktop browsers (Chrome, Firefox, Safari, Edge)
- Consider memory usage for batch operations

### Extending the Unified Editor

1. Add annotation factory to `js/lib/state.js` (e.g. `createMyAnnotation()`) and use it everywhere
2. Add tool button in toolbar or "Lainnya" dropdown
3. Implement logic in relevant `js/editor/` module (events delegated on `#ue-pages-container`)
4. Add rendering in `pdf-export.js` (`ueBuildFinalPDF`)
5. Ensure undo/redo works (`undo-redo.js`)
6. Export from module -> barrel `index.js` -> window bridge if needed
7. Test across multiple pages and files

**When adding new state fields:** Add to `getDefaultUeState()` in state.js — `ueReset()` will automatically clear it.

**When adding new page properties:** Add to `createPageInfo()` in state.js — all page creation paths get the field automatically.

**Multi-canvas notes:**
- Use `ueGetCurrentCanvas()` (never `getElementById('ue-canvas')`)
- Use `ueGetCoords(e, canvas, dpr)` for coordinate conversion
- Touch: only `preventDefault` when tool active or annotation hit (preserves scroll)

### Adding to "Lainnya" Dropdown

1. Add button in `#more-tools-dropdown` in index.html
2. Create modal HTML following `editor-*-modal` pattern
3. Add JS: use `openModal(id)` / `closeModal(id)` from navigation.js for open/close
4. Add `applyEditor[Tool]()` logic using annotation factories from state.js
5. Dropdown uses `position: fixed` for overflow handling

### Common Helpers

| Helper | Location | Purpose |
|--------|----------|---------|
| `createPageInfo({...})` | state.js | **SSOT** factory for page objects — all page creation must use this |
| `getDefaultUeState()` | state.js | **SSOT** default state values — used by init + ueReset() |
| `create*Annotation({...})` | state.js | **SSOT** annotation factories (Whiteout, Text, Signature, Watermark, PageNumber) |
| `getThumbnailSource(pageIndex)` | canvas-utils.js | **SSOT** resolve best canvas for thumbnail (rendered or thumbCanvas) |
| `drawRotatedThumbnail(src, rot)` | canvas-utils.js | Draw thumbnail with rotation baked in (swaps dimensions for 90/270°) — use instead of CSS `transform: rotate()` |
| `openModal(id)` / `closeModal(id)` | navigation.js | **SSOT** modal open/close with history management |
| `isPDF(file)` / `isImage(file)` | utils.js | **SSOT** file type validation |
| `loadPdfDocument(bytes)` | utils.js | **SSOT** PDF.js document loading with defensive .slice() |
| `ueAddAnnotation(pageIndex, anno)` | annotations.js | **SSOT** add annotation to page, returns index |
| `ueRemoveAnnotation(pageIndex, annoIndex)` | annotations.js | **SSOT** remove annotation + clear selection |
| `ueReorderPages(fromIndex, insertAt)` | page-manager.js | **SSOT** reorder pages with annotation mapping rebuild |
| `ueGetCurrentCanvas()` | canvas-utils.js | Get selected page's canvas |
| `ueGetCoords(e, canvas, dpr)` | canvas-utils.js | Mouse/touch -> canvas coords |
| `getCanvasAndCoords(e)` | canvas-events.js | Event delegation helper |
| `makeWhiteTransparent(canvas, threshold)` | utils.js | White pixels -> transparent |
| `setupCanvasDPR(canvas)` | utils.js | Scale canvas for devicePixelRatio |
| `createPageRenderer()` | page-rendering.js | **SSOT** create PageRenderer singleton (called by initUnifiedEditor) |
| `destroyPageRenderer()` | page-rendering.js | **SSOT** destroy PageRenderer + cleanup (called by ueReset) |
| `setupFileInput(inputId, opts)` | init.js | DRY file input handler factory |
| `safeLocalGet(key)` / `safeLocalSet(key, val)` | utils.js | Private browsing-safe localStorage |
| `trapFocus(modalEl)` / `releaseFocus(modalEl)` | utils.js | Modal focus trap + restore on close |
| `registerImage(dataUrl)` / `getRegisteredImage(id)` | state.js | Shared image registry (undo optimization) |
| `CSS_FONT_MAP` | state.js | Font-family mapping constant |

### Named Constants (js/lib/state.js)

`UNDO_STACK_LIMIT` (50), `SIGNATURE_DEFAULT_WIDTH` (150px), `PARAF_DEFAULT_WIDTH` (80px), `OBSERVER_ROOT_MARGIN` ('200px 0px'), `DOUBLE_TAP_DELAY` (300ms), `DOUBLE_TAP_DISTANCE` (30px), `MAX_CANVAS_DPR` (2 — clamps devicePixelRatio for canvas rendering, prevents GPU memory exhaustion at high zoom). `deviceCapability` object — `isTouch`, `isCoarsePointer`, `formFactor`, `maxCanvasPixels` (populated by init.js).

### Reliability Patterns

**Race condition guards:**
- `isLoadingFiles` (file-loading.js), `isDownloading` (pdf-export.js), `isRestoring` (ueState), `_renderingPages` Set (PageRenderer instance), `saved` closure (inline text editor), `isGenerating` (img-to-pdf.js), `isProcessingDrop` (init-file-handling.js)

**Resource lifecycle:**
- `_pdfDocCache` Map (PageRenderer) caches PDF.js docs, `.destroy()` on reset
- `imageRegistry` Map in state.js deduplicates base64 signature data across undo snapshots
- `ueRemoveScrollSync()` cleans up window scroll listener
- IntersectionObserver disconnected during Gabungkan modal, reconnected on close
- **No canvas eviction** — pages render once and stay. Eviction caused white flash flicker on mobile (canvas.width assignment clears content). Memory tradeoff: ~4MB per page stays allocated

**Accessibility:**
- All modals have `role="dialog" aria-modal="true"` + auto focus trap via MutationObserver in `initModalBackdropClose()`
- Tool cards: `tabindex="0" role="button"` with Enter/Space keyboard handlers
- Floating toolbar: `role="toolbar"`, dropdowns: `role="menu"`, signature tabs: `role="tablist"`
- Toast container: `aria-live="polite" role="status"`

**Performance:**
- PDF.js uses real Web Worker (`workerSrc` points to self-hosted file, falls back to fake worker offline)
- Page loading is lazy: `handlePdfFile` stores dimensions + pre-renders 300px thumbnail (`page.thumbCanvas`) for instant sidebar/modal previews. Full rendering via IntersectionObserver. Debounced `ueRenderThumbnails()` after each lazy render upgrades thumbnails to full-res
- Undo stack uses `imageRegistry` to avoid cloning base64 strings (stores `imageId` references)
- **Device capability detection:** `deviceCapability` object in state.js — `isTouch`, `isCoarsePointer`, `formFactor` ('phone'/'tablet'/'desktop'), `maxCanvasPixels` (5MP/10MP/16MP). Populated by `detectMobile()` in init.js. Foundation for future pixel-budget rendering.
- Pinch-to-zoom supported via 2-finger touch detection in `canvas-events.js`

**Key patterns:** `rebuildAnnotationMapping(oldPages)` for reference-based reindex, `requestAnimationFrame` guard before `ueCreatePageSlots()` for layout reflow. See [docs/patterns.md](docs/patterns.md) for code examples.

## Important Gotchas

- `npx serve` aggressively caches - always Cmd+Shift+R (macOS) / Ctrl+Shift+R (Windows) after changes
- Canvas `.width`/`.height` (buffer) vs `.style.width`/`.style.height` (display) - both must be set
- Touch events: blocking `preventDefault` breaks scroll on mobile
- `scrollIntoView` triggers scroll sync loops - use `scrollSyncEnabled` flag
- IntersectionObserver root is `null` (viewport), NOT the wrapper element
- Merge/Split card flow bypasses `showTool()` - must manually add `body.editor-active`
- Layout race condition: `showTool()` makes workspace visible but browser hasn't reflowed - use rAF
- **Lazy rendering**: `ueState.pages[i].canvas` is a `{width, height}` placeholder, NOT an HTMLCanvasElement. Real canvases live in `ueState.pageCanvases[i].canvas`. Pre-rendered thumbnails (300px) live in `page.thumbCanvas`. For sidebar/main thumbnails, use `getThumbnailSource(index)`. For Gabungkan modal, use `page.thumbCanvas` directly (pageCanvases stale during modal). Never access page.canvas directly for drawing
- **Mobile canvas flicker**: Mobile browsers silently purge offscreen canvas GPU backing stores. Canvas eviction was removed because the evict→re-render cycle caused worse flicker than keeping all canvases alive. **Do NOT re-add canvas eviction** — it was tried extensively in Mar 2026 and every approach (debounced eviction, background-image fallback, img sibling fallback) made things worse. See `memory/mobile-rendering.md` for full analysis.
- **Empty state flash**: `#ue-empty-state` must be hidden BEFORE `showTool()` when files are being loaded. Three code paths do this: `routeDroppedFile` (init-file-handling.js), `ueAddFiles` (file-loading.js), merge/split handler (init-ui.js). If `ueAddFiles` produces zero pages (corrupt PDF), empty state is restored.
- **Scroll sync must NOT call ueSelectPage()**: `ueSelectPage()` triggers `scrollIntoView()` which fights user momentum scroll on mobile. Scroll sync only updates highlight + page indicator.
- **Page selection border hidden on mobile**: `.ue-page-slot.selected canvas` outline only at `min-width: 901px`. `ueHighlightThumbnail()` skips DOM class toggling on mobile to avoid repaints.
- **Known limitation**: Edge-scroll flicker (overscroll recomposition) is a browser-level issue. Fix requires switching from body scroll to container scroll (`overflow-y: auto` + `overscroll-behavior: contain`).
- **`<dialog>` elements need explicit sizing**: Browser UA stylesheet sets `width: fit-content; height: fit-content; max-width: calc(100% - 2em)` on `<dialog>`. This overrides `right: 0; bottom: 0` stretch. All modal overlay classes (`.edit-modal`, `.signature-modal`, `.shortcuts-modal`) must set `width: 100%; height: 100%; max-width: none; max-height: none` to fill viewport. Without this, modals render top-left at content size instead of centered.
- **`showToast()` and `showFullscreenLoading()` use DOM construction, not innerHTML**: Prevents XSS from user-controlled filenames. Never revert to innerHTML for these functions.

## Changelog System

Edit `changelogData` array in `js/changelog.js`. Add new entries at the beginning.

```javascript
{ title: "User-Friendly Title", description: "Benefit for users in Indonesian", date: "DD MMMM YYYY" }
```

**Rules:** Indonesian, benefit-focused (not technical), casual "kamu" tone. Credit contributors with `<a href>` links.

## Git Workflow

- Feature branches from `main`, push for Vercel preview, merge when ready
- `main` auto-deploys to pdflokal.id
- Commit when complete, not after every edit
- Never commit without explicit user permission
- Server-dependent features (PDF<->Word, OCR) are out of scope

### AI Assistant Workflow for Major Changes

1. **Implement** on feature branch
2. **Document** (after user approves implementation): README.md -> changelog.js -> CLAUDE.md
3. **User reviews** all changes before commit
4. **Finalize** only after explicit user approval

## Quick Reference

**Main files:** `index.html`, `style.css`, `js/init.js`, `js/editor/*.js`, `js/pdf-tools/*.js`, `js/image-tools.js`, `js/lib/state.js`, `js/lib/utils.js`, `js/lib/navigation.js`

**Don't modify without good reason:** `vercel.json`, vendor libs, privacy promises, Indonesian UI language

**Detailed references:** [docs/patterns.md](docs/patterns.md) (code examples), [docs/security.md](docs/security.md) (CSP, headers, libraries), [docs/architecture.md](docs/architecture.md) (SSOT patterns)

---

**Remember**: PDFLokal exists to give Indonesian users a private, free, easy-to-use PDF tool. Every change should support that mission.
