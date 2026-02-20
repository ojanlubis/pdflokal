# CLAUDE.MD - PDFLokal Project Guide

## Project Overview

**PDFLokal** is a 100% client-side PDF and image manipulation tool for Indonesian users. All processing happens in the browser - no files are ever uploaded to a server.

- **Language**: Indonesian (UI text, all copy) - informal "kamu" tone
- **Key Principle**: Privacy first - everything client-side
- **Tech**: Vanilla JS, native ES modules, no build step, no frameworks
- **Libraries**: pdf-lib, PDF.js, Signature Pad, Canvas API (see [docs/security.md](docs/security.md) for versions/details)

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
│   ├── init.js               # Entry point: bootstrap, dropzone, tool cards, setupFileInput factory
│   ├── keyboard.js           # Keyboard shortcuts + modal
│   ├── mobile-ui.js          # Mobile nav, page picker, tools dropdown
│   ├── changelog.js          # Changelog notification system
│   ├── theme.js              # Theme toggle (light/dark)
│   ├── image-tools.js        # Image tools (compress, resize, convert, etc.)
│   ├── lib/
│   │   ├── state.js          # State objects, constants, SSOT helpers (createPageInfo, getDefaultUeState)
│   │   ├── utils.js          # showToast, downloadBlob, makeWhiteTransparent, setupCanvasDPR, etc.
│   │   └── navigation.js     # showHome, showTool, pushState, closeAllModals
│   ├── editor/               # Unified Editor (~14 modules)
│   │   ├── index.js          # Barrel re-exports + window bridges
│   │   ├── canvas-utils.js   # ueGetCurrentCanvas, ueGetCoords, ueGetResizeHandle, getThumbnailSource
│   │   ├── annotations.js    # ueRedrawAnnotations, draw helpers, hit testing
│   │   ├── canvas-events.js  # Mouse/touch event delegation on pages container
│   │   ├── file-loading.js   # ueAddFiles, handlePdfFile, handleImageFile
│   │   ├── lifecycle.js      # initUnifiedEditor, ueReset, signature hints
│   │   ├── page-manager.js   # Gabungkan modal (uePm* functions)
│   │   ├── page-rendering.js # Page slots, canvas rendering, IntersectionObserver, scroll sync
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
│   └── vendor/               # Self-hosted libs (2.6 MB) for offline support
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
- **`getThumbnailSource(pageIndex)`** (canvas-utils.js) — resolves best canvas for thumbnails. Used by sidebar, mobile picker, and Gabungkan modal.

Refer to `js/lib/state.js` for full shape and comments on each field.

## Key Features

### Unified Editor (Primary Tool)

The flagship multi-document PDF editor. When users drop a PDF on the homepage, it opens here.

**Architecture:** Multi-canvas continuous vertical scroll. Each page gets its own `<canvas>` in `#ue-pages-container`. Body scroll with IntersectionObserver (`root: null`) for lazy rendering. See [docs/patterns.md](docs/patterns.md) for full function reference.

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

1. Add annotation type to `ueState.annotations` (in `js/lib/state.js`)
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
3. Add JS: `ueOpen[Tool]Modal()`, `closeEditor[Tool]Modal()`, `applyEditor[Tool]()`
4. Dropdown uses `position: fixed` for overflow handling

### Common Helpers

| Helper | Location | Purpose |
|--------|----------|---------|
| `createPageInfo({...})` | state.js | **SSOT** factory for page objects — all page creation must use this |
| `getDefaultUeState()` | state.js | **SSOT** default state values — used by init + ueReset() |
| `getThumbnailSource(pageIndex)` | canvas-utils.js | **SSOT** resolve best canvas for thumbnail (rendered or thumbCanvas) |
| `ueGetCurrentCanvas()` | canvas-utils.js | Get selected page's canvas |
| `ueGetCoords(e, canvas, dpr)` | canvas-utils.js | Mouse/touch -> canvas coords |
| `getCanvasAndCoords(e)` | canvas-events.js | Event delegation helper |
| `makeWhiteTransparent(canvas, threshold)` | utils.js | White pixels -> transparent |
| `setupCanvasDPR(canvas)` | utils.js | Scale canvas for devicePixelRatio |
| `setupFileInput(inputId, opts)` | init.js | DRY file input handler factory |
| `safeLocalGet(key)` / `safeLocalSet(key, val)` | utils.js | Private browsing-safe localStorage |
| `trapFocus(modalEl)` / `releaseFocus(modalEl)` | utils.js | Modal focus trap + restore on close |
| `registerImage(dataUrl)` / `getRegisteredImage(id)` | state.js | Shared image registry (undo optimization) |
| `CSS_FONT_MAP` | state.js | Font-family mapping constant |

### Named Constants (js/lib/state.js)

`UNDO_STACK_LIMIT` (50), `SIGNATURE_DEFAULT_WIDTH` (150px), `PARAF_DEFAULT_WIDTH` (80px), `OBSERVER_ROOT_MARGIN` ('200px 0px'), `DOUBLE_TAP_DELAY` (300ms), `DOUBLE_TAP_DISTANCE` (30px).

### Reliability Patterns

**Race condition guards:**
- `isLoadingFiles` (file-loading.js), `isDownloading` (pdf-export.js), `isRestoring` (ueState), `ueRenderingPages` Set (page-rendering.js), `saved` closure (inline text editor)

**Resource lifecycle:**
- `pdfDocCache` Map caches PDF.js docs, `.destroy()` on reset
- `imageRegistry` Map in state.js deduplicates base64 signature data across undo snapshots
- `ueRemoveScrollSync()` cleans up window scroll listener
- IntersectionObserver disconnected during Gabungkan modal, reconnected on close
- Page cache cleanup threshold: 4 pages (offscreen canvases cleared when >4 pages loaded)

**Accessibility:**
- All modals have `role="dialog" aria-modal="true"` + auto focus trap via MutationObserver in `initModalBackdropClose()`
- Tool cards: `tabindex="0" role="button"` with Enter/Space keyboard handlers
- Floating toolbar: `role="toolbar"`, dropdowns: `role="menu"`, signature tabs: `role="tablist"`
- Toast container: `aria-live="polite" role="status"`

**Performance:**
- PDF.js uses real Web Worker (`workerSrc` points to self-hosted file, falls back to fake worker offline)
- Page loading is lazy: `handlePdfFile` stores dimensions + pre-renders 150px thumbnail (`page.thumbCanvas`) for instant sidebar previews. Full rendering via IntersectionObserver. Debounced `ueRenderThumbnails()` after each lazy render upgrades thumbnails to full-res
- Undo stack uses `imageRegistry` to avoid cloning base64 strings (stores `imageId` references)
- Pinch-to-zoom supported via 2-finger touch detection in `canvas-events.js`

**Key patterns:** `rebuildAnnotationMapping(oldPages)` for reference-based reindex, `requestAnimationFrame` guard before `ueCreatePageSlots()` for layout reflow. See [docs/patterns.md](docs/patterns.md) for code examples.

## Important Gotchas

- `npx serve` aggressively caches - always Ctrl+Shift+R after changes
- Canvas `.width`/`.height` (buffer) vs `.style.width`/`.style.height` (display) - both must be set
- Touch events: blocking `preventDefault` breaks scroll on mobile
- `scrollIntoView` triggers scroll sync loops - use `scrollSyncEnabled` flag
- IntersectionObserver root is `null` (viewport), NOT the wrapper element
- Merge/Split card flow bypasses `showTool()` - must manually add `body.editor-active`
- Layout race condition: `showTool()` makes workspace visible but browser hasn't reflowed - use rAF
- **Lazy rendering**: `ueState.pages[i].canvas` is a `{width, height}` placeholder, NOT an HTMLCanvasElement. Real canvases live in `ueState.pageCanvases[i].canvas`. Pre-rendered thumbnails (150px) live in `page.thumbCanvas`. For thumbnail rendering, always use `getThumbnailSource(index)` — never access page.canvas directly for drawing

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
