# CLAUDE.MD - PDFLokal Project Guide

This file helps AI assistants understand and work with the PDFLokal project effectively.

## Project Overview

**PDFLokal** is a 100% client-side PDF and image manipulation tool designed for Indonesian users. All processing happens in the browser - no files are ever uploaded to a server.

- **Language**: Indonesian (UI text, documentation, copy)
- **Target Users**: Indonesian users who need privacy-focused PDF/image tools
- **Key Principle**: Privacy first - everything runs client-side
- **Tech Philosophy**: Vanilla JS, minimal dependencies, no build step

## Core Architecture

### Technology Stack

- **Vanilla HTML/CSS/JavaScript** - No frameworks, no build process
- **pdf-lib** - PDF manipulation (merge, split, edit, etc.)
- **PDF.js** (Mozilla) - PDF rendering and thumbnail generation
- **Signature Pad** - Digital signature capture
- **Canvas API** - Image processing and manipulation

### File Structure

```
pdflokal/
├── index.html          # Main application - all PDF/image tools
├── dukung.html         # Donation/support page
├── privasi.html        # Privacy policy page (Indonesian)
├── style.css           # All application styles (includes @font-face declarations)
├── vercel.json         # Vercel configuration (security headers, CSP, rewrites)
├── security.txt        # Security contact info (served at /.well-known/security.txt)
├── humans.txt          # Team credits
├── js/                 # Native ES modules (no build step, no bundler)
│   ├── init.js               # Main entry point — bootstrap, dropzone, tool cards, setupFileInput factory
│   ├── keyboard.js           # Keyboard shortcuts + shortcuts modal
│   ├── mobile-ui.js          # Mobile navigation, page picker, tools dropdown
│   ├── changelog.js          # Changelog notification system
│   ├── theme.js              # Theme toggle (light/dark)
│   ├── image-tools.js        # Image processing tools (compress, resize, convert, etc.)
│   ├── lib/                  # Shared foundations (no cross-deps)
│   │   ├── state.js          # All state objects + constants (CSS_FONT_MAP, UNDO_STACK_LIMIT, etc.)
│   │   ├── utils.js          # showToast, downloadBlob, makeWhiteTransparent, setupCanvasDPR, etc.
│   │   └── navigation.js     # showHome, showTool, pushState, closeAllModals
│   ├── editor/               # Unified Editor (~14 modules, from unified-editor.js)
│   │   ├── index.js          # Barrel re-exports + window bridges
│   │   ├── canvas-utils.js   # ueGetCurrentCanvas, ueGetCoords, ueGetResizeHandle
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
│   ├── pdf-tools/            # PDF tool modals (~7 modules, from pdf-tools.js)
│   │   ├── index.js          # Barrel re-exports + window bridges
│   │   ├── signature-modal.js
│   │   ├── text-modal.js
│   │   ├── watermark-modal.js
│   │   ├── pagenum-modal.js
│   │   ├── standalone-tools.js  # PDF-to-Image, Compress PDF, Protect PDF only (~250 lines)
│   │   └── drag-reorder.js      # enableDragReorder utility
│   └── vendor/               # Self-hosted libraries (2.6 MB) for offline support
│       ├── pdf-lib.min.js
│       ├── fontkit.umd.min.js
│       ├── pdf.min.js
│       ├── pdf.worker.min.js
│       ├── signature_pad.umd.min.js
│       └── pdf-encrypt-lite.min.js  # Unused local copy (app loads from CDN instead)
├── docs/               # Design documentation
│   └── editor-redesign.md
├── fonts/              # Self-hosted fonts (268KB, Latin charset)
│   ├── montserrat-*.woff2
│   ├── carlito-*.woff2
│   └── plusjakartasans-*.woff2
├── images/             # UI assets and icons
└── README.md           # User-facing documentation
```

### Single-Page Architecture

The entire application is in `index.html`. Features are organized as:
- Separate sections/modals for each tool
- JavaScript organized as native ES modules with explicit imports/exports
- Single entry point `js/init.js` imports all other modules
- All styles in single `style.css` file

**JavaScript Loading** (in index.html):
```html
<!-- Vendor libraries (global scripts, loaded first) -->
<script src="js/vendor/pdf-lib.min.js"></script>
<script src="js/vendor/fontkit.umd.min.js"></script>
<script src="js/vendor/pdf.worker.min.js"></script>
<script src="js/vendor/pdf.min.js"></script>
<script>pdfjsLib.GlobalWorkerOptions.workerSrc = '';</script>
<script src="js/vendor/signature_pad.umd.min.js"></script>

<!-- Single ES module entry point (imports everything) -->
<script type="module" src="js/init.js"></script>
```

**ES Module Architecture:**
- All app code uses native `import`/`export` — no bundler needed
- `js/init.js` is the root that imports all modules transitively
- Each module directory has a barrel file (`index.js`) with re-exports + window bridges
- Window bridges (`window.fn = fn`) are used for HTML `onclick` handlers
- Vendor libraries remain as global `<script>` tags, accessed via `window.*` in modules

### State Management

The app uses several state objects for different tools:

```javascript
// Unified Editor state
ueState = {
  // Document data
  pages: [],                       // All loaded pages: [{ pageNum, sourceIndex, sourceName, rotation, canvas }]
  sourceFiles: [],                 // Source PDF files: [{ name, bytes }]
  selectedPage: -1,                // Index into pages[] of the currently visible page

  // Editing tools
  currentTool: null,               // Active annotation tool: 'select' | 'whiteout' | 'text' | 'signature' | null
  annotations: {},                 // Per-page annotations: { pageIndex: [annotation, ...] }
  selectedAnnotation: null,        // Currently selected annotation: { pageIndex, index } or null
  pendingTextPosition: null,       // Where text will be placed: { x, y } or null

  // Undo/redo (two separate stacks: page ops vs annotations)
  undoStack: [],                   // Page operation history (reorder, delete, rotate)
  redoStack: [],                   // Page operation redo
  editUndoStack: [],               // Annotation edit history
  editRedoStack: [],               // Annotation edit redo

  // Rendering
  pageScales: {},                  // Per-page scale info: { pageIndex: { canvasWidth, canvasHeight, pdfWidth, pdfHeight, scale } }
  devicePixelRatio: 1,             // Window.devicePixelRatio at render time
  eventsSetup: false,              // Guard: true after event delegation is attached
  pageCanvases: [],                // [{ slot: HTMLElement, canvas: HTMLCanvasElement, rendered: bool }]
  pageCaches: {},                  // { pageIndex: ImageData } per-page cache for annotation redraw
  pageObserver: null,              // IntersectionObserver for lazy rendering
  scrollSyncEnabled: true,         // false during programmatic scrollIntoView
  zoomLevel: 1.0,                  // Current zoom multiplier (1.0 = fit width)

  // Guards (hardening)
  isRestoring: false,              // true during undo/redo page restoration (blocks scroll sync + nested undo)

  // Signature placement
  pendingSignature: false,         // true when signature is "attached to cursor"
  signaturePreviewPos: null,       // Cursor position for ghost preview: { x, y }
  resizeHandle: null,              // Corner handle being dragged: 'tl' | 'tr' | 'bl' | 'br' | null
  resizeStartInfo: null,           // Snapshot of annotation state when resize began

  // Touch & drag interaction
  isDragging: false,               // true while an annotation is being dragged
  isResizing: false,               // true while an annotation is being resized
  sidebarDropIndicator: null,      // DOM element for sidebar drag-drop indicator

  // UX
  lastLockedToastAnnotation: null  // Tracks last signature that showed "locked" toast (prevents spam)
}

// Gabungkan Modal state (for "Merge" button feature)
uePmState = {
  isOpen: false,
  extractMode: false,       // When true, enables "Split" mode
  selectedForExtract: [],   // Array of page indices for split/extraction
  draggedIndex: -1,
  dropIndicator: null
}
```

## Key Features

### PDF Tools

#### Unified Editor (Primary Tool)
The flagship multi-document PDF editor - **this is the main user flow**. When users drop a PDF on the homepage, it opens the Unified Editor.

**Architecture: Continuous Vertical Scroll (Multi-Canvas)**
- Each page gets its own `<canvas>` inside a `.ue-page-slot` wrapper in `#ue-pages-container`
- Pages stack vertically — user scrolls through all pages naturally (body scroll, not wrapper scroll)
- `body.editor-active` class hides site header/footer, breaks `.container` max-width constraint
- IntersectionObserver with `root: null` (viewport) lazy renders pages near viewport (200px buffer)
- Memory management: un-renders pages >3 away from viewport (PDFs >8 pages)
- Scroll sync: `window` scroll listener updates `selectedPage` and sidebar highlight (debounced 100ms, guarded by `state.currentTool === 'unified-editor'`)
- CSS scroll snap: `scroll-snap-type: y proximity` on body, `scroll-snap-align: center` on page slots
- Event delegation on `#ue-pages-container` — not individual canvases
- Mobile: sidebar hidden, floating toolbar icon-only + fixed, compact 36px header

Features:
- **Continuous scroll**: All pages visible, scrollable vertically
- **Multi-file support**: Load and merge multiple PDFs in one session
- **Page operations**: Reorder (drag-drop in sidebar AND modal), rotate, delete pages
- **Sidebar thumbnails**: Drag-drop reordering, visual rotation display
- **Gabungkan Modal**: "Merge" button (sidebar header) opens full-page management with drag-drop reorder, rotate, delete, add pages, and multi-select split
- **Split mode**: Multi-select pages to extract as separate PDFs
- **Annotations**: Whiteout, text, signatures
- **Text annotations**: Font family (Helvetica, Times, Courier, Montserrat, Carlito), bold/italic styling, custom font size (6-120pt), quick color presets
- **Signature upload**: Supports images for signatures AND stamps, with background removal option
- **Signature preview**: Position signatures before placing
- **Signature lock/unlock**: Auto-locks after placement (prevents accidental moves), double-click to unlock
- **Signature delete**: Delete button for removing signatures
- **Smart notifications**: Toast shows "Tanda tangan terkunci. Klik dua kali untuk membuka kunci" once per signature (no spam)
- **Zoom controls**: Scale view for precision editing
- **Rotate function**: Rotate current page 90° clockwise
- **Undo/Redo**: Separate stacks for page operations and annotations
- **Thumbnail navigation**: Visual page overview with rotation preview
- **Keyboard shortcuts**: Full keyboard support with floating "?" help button

**Keyboard Shortcuts:**
| Key | Action |
|-----|--------|
| V | Select/Edit tool |
| W | Whiteout tool |
| T | Text tool |
| S | Signature tool |
| R | Rotate current page 90° clockwise |
| Delete/Backspace | Delete selected annotation |
| Ctrl+Z | Undo |
| Ctrl+Y | Redo |
| Ctrl+S | Download PDF |
| Arrow Left/Right | Navigate pages |
| ? | Show keyboard shortcuts help |
| Escape | Close modals / Go home |

**Editor Layout:**
- **Editor header** (40px, sticky top:0, z-index:100): `[File v] PDFLokal ... [moon] [Download PDF]`
  - File dropdown: Tambah File, Ganti File
  - Brand link "PDFLokal" navigates home (with unsaved work warning)
- **Floating toolbar** (full-width, sticky top:40px, z-index:90, frosted glass): `[Sign | Text | Whiteout | Pilih | Rotate | More v]`
  - "Lainnya" dropdown: Watermark, Nomor Halaman, Kunci PDF, Undo, Redo, Hapus Semua
- **Compact sidebar** (160px, sticky, fills viewport height):
  - Header: "Kelola Halaman" button (opens Gabungkan modal)
  - Thumbnails: Drag-drop reorderable, visual rotation, click to navigate
- **Bottom bar** (30px, fixed bottom:0, z-index:100): `[Dukung Kami] ... [- Zoom +] Hal 2/5 [?]`

#### Other PDF Tools (Standalone Workspaces)
- **PDF to Image**: Convert pages to PNG/JPG with batch export
- **Compress PDF**: Compress embedded images within PDFs
- **Protect PDF**: Add password protection (also available in Unified Editor via "Kunci PDF")

**Removed Tools:**
- Crop PDF (removed)
- Unlock PDF / Buka Kunci (removed completely)
- Legacy Edit PDF (code removed — merged into Unified Editor)
- Legacy Kelola Halaman / Page Manager (code removed — merged into Unified Editor)
- Legacy Merge/Split/Rotate standalone workspaces (code removed from standalone-tools.js)
- Watermark standalone workspace (removed - now only in Unified Editor via "Lainnya")
- Page Numbers standalone workspace (removed - now only in Unified Editor via "Lainnya")

**Note:** All legacy standalone tool code (~1,400 lines) was removed in Feb 2026 cleanup. `standalone-tools.js` now only contains PDF-to-Image, Compress, and Protect functions. The signature-modal.js and text-modal.js no longer have legacy editor branches — they only target the Unified Editor.

### Image Tools
- **Compress Image**: Quality slider with live preview and savings percentage
- **Resize Image**: Dimension input with aspect ratio lock, percentage-based
- **Convert Format**: JPG ↔ PNG ↔ WebP conversion with quality control
- **Image to PDF**: Convert images to PDF with drag-drop reordering
- **Remove Background**: Remove white/near-white pixels (threshold-based) for transparent PNG output

### Homepage Layout
- Hero section with tagline and signature hint
- Main dropzone (opens Unified Editor for PDFs)
- PDF tool cards: **Editor PDF**, **Merge PDF**, **Split PDF**, PDF to Image, Compress PDF, Protect PDF
- Image tool cards: Compress, Resize, Convert Format, Image to PDF, Remove Background
- PDF and Image tool cards displayed **side by side** on desktop (stacked on mobile)
- **Merge PDF card**: Opens file picker → Loads files → Opens Unified Editor with Gabungkan modal
- **Split PDF card**: Opens file picker → Loads files → Opens Unified Editor with Gabungkan modal in Split mode
- Privacy badge below dropzone
- "Coming Soon" section for server-dependent features

### Navigation & UX
- **Editor chrome**: `body.editor-active` class hides site header/footer, removes `.container` max-width, shows editor-specific header/toolbar/bottombar
- **Browser back button support**: Uses History API to handle workspace/modal navigation
- **File size warnings**: Shows info toast for files >20MB, blocks files >100MB
- **Browser compatibility check**: Validates required features on page load
- **Loading states**: Spinner on buttons during processing (PDF download, protect, etc.)
- **Fullscreen loading overlay**: Used for async operations (Merge/Split cards) - home-view stays visible during file picking, overlay shows during PDF loading
- **File picker UX pattern**: Merge/Split cards use `handleEditorCardWithFilePicker('merge'|'split')` in `js/init.js` which bypasses `showTool()` to keep home-view visible until files are loaded. **Must manually add `body.editor-active`** since `showTool()` is bypassed.
- **Modal click-outside-to-close**: All modals close when clicking the backdrop area. Handled by a single delegated listener in `initModalBackdropClose()` (js/init.js) — maps modal IDs to close functions.
- **Changelog notification system**: Single morphing element that transitions between badge (collapsed) and full content (expanded) at bottom-right, controlled via `window.changelogAPI`

### Changelog Notification System

A smart, non-intrusive notification system for displaying app updates that only shows when there's NEW content.

**Architecture:**
- Single HTML element (`.changelog-notification`) with two views: collapsed badge and expanded content
- State management: `hidden`, `collapsed`, `expanded`
- localStorage persistence: `pdflokal_changelog_last_closed` (stores title of last closed changelog)
- Public API: `window.changelogAPI.open()`, `.minimize()`, `.close()`, `.hide()`, `.restore()`

**Smart Display Logic:**
- **First-time visitor**: Shows collapsed badge at bottom-right (not pushy)
- **Returning visitor (already closed)**: Badge stays hidden
- **NEW content available**: Badge reappears when developer adds new entry to top of array
- **Never auto-expands**: User must click badge to see content
- Click badge → Expands upward in place (smooth 0.25s transition)
- Mobile: Badge expands to full-screen modal

**Integration:**
- `hide()`: Called when leaving home-view (entering workspace)
- `restore()`: Called when returning to home-view
- Automatically hides when opening workspaces or modals

**Adding new changelog entries:**
Edit [js/changelog.js](js/changelog.js) `changelogData` array:
```javascript
const changelogData = [
  {
    title: "Judul Update yang Human-Friendly",  // Used for comparison
    description: "Deskripsi benefit untuk user, bukan jargon teknis",
    date: "DD MMMM YYYY"
  },
  // Add new entries at the beginning
];
```

**Writing Guidelines:**
- **Title**: User benefit, not technical feature ("File PDF Kamu Jadi Lebih Kecil" not "Optimasi Kompresi")
- **Description**: Explain what it means for users, use friendly language, emojis OK
- **Tone**: Show you care ("Kami terus bekerja untuk aplikasi yang kamu pakai gratis ini! 💪")
- **Credit contributors**: Use `<a href="https://github.com/username" target="_blank">@username</a>` for credits

### PDF File Size Optimization

PDFLokal implements smart optimizations to keep file sizes small without quality loss.

**Unmodified PDF Optimization** (editor/pdf-export.js):
- Detects when PDF has no edits (no rotations, reordering, annotations)
- Downloads original bytes directly, skipping pdf-lib re-encoding
- Prevents bloat: 200KB stays 200KB (not 700KB from re-encoding)
- Check: single file + pages in order + no rotation + no annotations = original bytes

**Signature Image Optimization** (pdf-tools/signature-modal.js):
```javascript
function optimizeSignatureImage(sourceCanvas) {
  // Resize if >1500px (prevents 5000x5000 photos)
  // Detect transparency in alpha channel
  // Use JPEG 85% quality for photos (10-20x compression)
  // Use PNG only when transparency detected
  // Result: 2.5MB signature → 300-400KB
}
```

**PDF Compression** (editor/pdf-export.js):
```javascript
const pdfBytes = await newDoc.save({
  useObjectStreams: true,  // Enable object streams for better compression
  addDefaultPage: false     // Don't add blank page if empty
});
```

**Format-Aware Embedding**:
- Auto-detect image format from data URL (`data:image/jpeg` vs `data:image/png`)
- Use `embedJpg()` for JPEG, `embedPng()` for PNG
- Prevents double-compression and format mismatches

**Results:**
- Unmodified PDF: 200KB → 200KB ✅
- PDF + photo signature: 200KB → 300-400KB (was 2.5MB) ✅
- PDF + drawn signature: 200KB → ~250KB ✅

## Development Guidelines

### 1. Language and Localization
- **All UI text MUST be in Indonesian** (Bahasa Indonesia)
- Use informal, friendly tone ("kamu" not "anda")
- Follow existing terminology in the codebase
- Error messages should be clear and in Indonesian

### 2. Client-Side Only Rule
- **CRITICAL**: All features must run 100% in the browser
- Never add server-side dependencies
- File processing must use browser APIs and existing libraries
- No external API calls for core functionality

### 3. Code Style
- Use vanilla JavaScript (ES6+) with native ES modules (`import`/`export`)
- Avoid adding new npm dependencies unless absolutely necessary
- Keep code simple and readable
- Maintain consistency with existing code style
- Comment complex logic in Indonesian or English
- New functions must be exported from their module AND added to the barrel `index.js` with a `window.*` bridge if called from HTML `onclick` handlers

### 4. Performance Considerations
- Target file sizes: up to 50MB comfortably
- Optimize for mobile and desktop browsers
- Test with large files before committing
- Consider memory usage for batch operations

### 5. Browser Compatibility
- Support modern browsers (Chrome, Firefox, Safari, Edge)
- Minimum ES6+ support required
- Test responsive design on mobile viewports
- Gracefully handle browser limitations

## Common Development Tasks

### Extending the Unified Editor

The Unified Editor is the primary tool. New PDF features should be added here:

1. Add new annotation type to `ueState.annotations` structure (in `js/lib/state.js`)
2. Add tool button in the editor toolbar (Line 1 for tools, or in "Lainnya" dropdown for less common tools)
3. Implement drawing/placement logic in the relevant `js/editor/` module (events are delegated on `#ue-pages-container`)
4. Add rendering in `js/editor/pdf-export.js` (`ueBuildFinalPDF`)
5. Ensure undo/redo works for the new annotation type (`js/editor/undo-redo.js`)
6. Export new functions from module → re-export in `js/editor/index.js` → add `window.*` bridge if needed
7. Test across multiple pages and files — annotations are per-page

**Multi-canvas architecture notes:**
- Use `ueGetCurrentCanvas()` to get the selected page's canvas (never `getElementById('ue-canvas')`)
- Use `ueGetCoords(e, canvas, dpr)` for mouse/touch coordinate conversion
- Annotations draw on per-page canvases via `ueRedrawPageAnnotations(index)`
- `ueRenderVisiblePages()` re-renders all visible pages (used after zoom/resize)
- Touch events: only `preventDefault` when a tool is active or annotation was hit (preserves scroll)

### Adding Sidebar Drag-Drop Functionality

To enable drag-drop reordering in the sidebar (or similar vertical lists):

1. Add `draggable="true"` and `data-index` attributes to items in render function
2. Create setup function mirroring `uePmEnableDragReorder()` but adapted for vertical layout:
   - Use `clientY` instead of `clientX` for drop position calculation
   - Use `rect.top + rect.height / 2` instead of `rect.left + rect.width / 2` for midpoint
3. Add drop indicator state to relevant state object (e.g., `sidebarDropIndicator`)
4. Add CSS for `.dragging` and drop indicator styles
5. Call setup function after rendering items

### Adding to "Lainnya" Dropdown

For rarely-used tools, add them to the "Lainnya" (More Tools) dropdown:
1. Add button in `#more-tools-dropdown` in index.html
2. Create modal HTML following existing pattern (`editor-*-modal`)
3. Add JS functions: `ueOpen[Tool]Modal()`, `closeEditor[Tool]Modal()`, `applyEditor[Tool]()`
4. The dropdown uses `position: fixed` for proper overflow handling

### Creating File Picker Cards (Like Merge/Split PDF)

To create tool cards that trigger file picker before opening workspace:

1. **Don't call `showTool()` from `initToolCards()`** - `showTool()` immediately hides home-view
2. Create dedicated handler function (e.g., `handleMergePdfCard()`) that:
   - Creates hidden file input element (or reuses existing one)
   - Attaches `change` event listener with async handler
   - Calls `input.click()` to trigger file picker
3. In the async `change` handler:
   - Convert FileList to Array: `const filesArray = Array.from(e.target.files)`
   - Reset input immediately: `input.value = ''` (so same files can be selected again)
   - Show fullscreen loading overlay: `showFullscreenLoading('Memuat PDF...')`
   - Load files and initialize workspace manually (don't use `showTool()`)
   - Manually hide home-view and show workspace after files are loaded
   - Hide loading overlay when ready
4. This pattern keeps home-view visible during file picking, provides loading feedback, and prevents blank screen

**Example:**
```javascript
function handleMergePdfCard() {
  let input = document.getElementById('merge-pdf-input');
  if (!input) {
    input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.pdf';
    input.addEventListener('change', async (e) => {
      const filesArray = Array.from(e.target.files);
      input.value = '';
      showFullscreenLoading('Memuat PDF...');
      await loadFiles(filesArray);
      document.getElementById('home-view').style.display = 'none';
      document.body.classList.add('editor-active'); // CRITICAL: must add manually
      // ... show workspace ...
      hideFullscreenLoading();
    });
    document.body.appendChild(input);
  }
  input.click();
}
```

### Adding Image Processing Feature

1. Use Canvas API for processing
2. Maintain quality/compression controls
3. Support drag & drop and file selection
4. Show previews where appropriate
5. Test with different image formats

## Important Notes

### File Processing Limitations

- **PDF Compression**: Only compresses images within PDFs, not PDF structure
- **Large Files**: Files >50MB may be slow or crash on some devices
- **Complex PDFs**: Encrypted PDFs or special fonts may not process correctly
- **Browser Memory**: Client-side processing is limited by browser memory

### Future Features (Require Server)

These features are **NOT** currently in scope (need server-side processing):
- PDF ↔ Word conversion
- PDF ↔ Excel conversion
- OCR (text recognition)

Do not implement these without discussing server architecture first.

## Libraries and Dependencies

### Self-Hosted Libraries (2.6 MB total)

**IMPORTANT**: Core libraries are self-hosted in `/js/vendor/` for:
- ✅ **Offline support** - PDFLokal works without internet connection
- ✅ **Firewall compatibility** - Works in restricted networks (corporate, government, educational)
- ✅ **No CDN dependencies** - No external requests for core functionality
- ✅ **True "LOKAL" experience** - Everything runs locally

| Library | Version | Size | Location | Purpose |
|---------|---------|------|----------|---------|
| **pdf-lib** | 1.17.1 | 513 KB | `js/vendor/` | PDF manipulation (merge, split, edit, add pages, etc.) |
| **fontkit** | 1.1.1 | 741 KB | `js/vendor/` | Custom font embedding support for pdf-lib |
| **PDF.js** | 3.11.174 | 313 KB | `js/vendor/` | PDF rendering and thumbnail generation |
| **PDF.js Worker** | 3.11.174 | 1.1 MB | `js/vendor/` | PDF processing (loaded before pdf.min.js for offline fake worker) |
| **Signature Pad** | 4.1.7 | 12 KB | `js/vendor/` | Digital signature capture (canvas-based) |
| **pdf-encrypt-lite** | 1.0.1 | ~12 KB | CDN (esm.sh) | PDF password encryption (ES module - requires internet) |
| **Vercel Insights** | - | - | CDN | Analytics (optional) |

**Library Loading Order** (in index.html):
```html
<!-- Self-hosted libraries -->
<script src="js/vendor/pdf-lib.min.js"></script>
<script src="js/vendor/fontkit.umd.min.js"></script>
<script src="js/vendor/pdf.worker.min.js"></script>  <!-- BEFORE pdf.min.js! -->
<script src="js/vendor/pdf.min.js"></script>
<script>
  pdfjsLib.GlobalWorkerOptions.workerSrc = '';  // Use fake worker (code already loaded)
</script>
<script src="js/vendor/signature_pad.umd.min.js"></script>

<!-- CDN (requires internet) -->
<script type="module">
  import { encryptPDF } from 'https://esm.sh/@pdfsmaller/pdf-encrypt-lite@1.0.1';
  window.encryptPDF = encryptPDF;
</script>
```

**Why pdf-encrypt-lite stays on CDN:**
- ES module with complex dependency tree
- Only used for "Protect PDF" feature (optional)
- Bundling would require build tooling (against project philosophy)

### Self-Hosted Fonts (268KB total, Latin charset only)

**IMPORTANT**: All fonts are self-hosted in the `/fonts/` directory for:
- ✅ Offline support and privacy
- ✅ Works in restricted networks (corporate, government, educational)
- ✅ No external CDN dependencies
- ✅ True "LOKAL" experience

Fonts are loaded via `@font-face` in `style.css` for UI rendering, and fetched as ArrayBuffer from `/fonts/` for PDF embedding.

**Available fonts:**
- **Montserrat** (4 variants: regular, bold, italic, bold-italic) - 77KB
- **Carlito** (4 variants: regular, bold, italic, bold-italic) - 122KB - Open-source Calibri alternative
- **Plus Jakarta Sans** (4 weights: 400, 500, 600, 700) - 49KB - Used for UI only
- **Standard PDF fonts**: Helvetica, Times-Roman, Courier (built into pdf-lib, no embedding needed)

**Implementation:**
- UI rendering: CSS `font-family` mapped via `CSS_FONT_MAP` constant in `js/lib/state.js`
- PDF embedding: Fonts fetched via `fetch()` in `getFont()` (`js/editor/pdf-export.js`)
- fontkit registered with PDFDocument for custom font support

### Canvas API
- Native browser API for all image processing
- Used for: compression, resize, format conversion, background removal
- No external library needed

## Testing Checklist

Before committing changes:

- [ ] Test in Chrome, Firefox, and Safari
- [ ] Test on mobile viewport (responsive design)
- [ ] Test with small files (<1MB)
- [ ] Test with medium files (5-10MB)
- [ ] Test with large files (30-50MB)
- [ ] Verify all UI text is in Indonesian
- [ ] Check error handling works
- [ ] Ensure no console errors
- [ ] Verify files don't upload anywhere (check Network tab)

## Git Workflow

**Recommended Development Flow** (using Vercel preview deployments):

1. **Create feature branch** from `main`:
   ```bash
   git checkout main
   git pull
   git checkout -b feature-name  # e.g., self-hosted-fonts, fix-signature-bug
   ```

2. **Develop and commit**:
   - Make changes
   - **IMPORTANT: Only commit when a feature or fix is COMPLETE**
   - Don't commit after every single edit - it clutters GitHub history
   - Commit when: feature works, bug is fixed, or logical unit is done
   - Write clear, descriptive commit messages
   - Keep commits focused and atomic (one feature/fix per commit)
   - Push branch to GitHub: `git push -u origin feature-name`

3. **Test on Vercel preview**:
   - Vercel auto-deploys every branch push
   - Get preview URL from Vercel dashboard or GitHub PR
   - Test thoroughly on preview (not local dev server)
   - Preview URL example: `pdflokal-git-feature-name-username.vercel.app`

4. **Merge to main** when ready:
   ```bash
   git checkout main
   git pull
   git merge feature-name -m "Descriptive merge message"
   git push origin main
   ```

5. **Production deployment**:
   - `main` branch auto-deploys to https://www.pdflokal.id/
   - Usually deploys within 1-2 minutes

**Why this workflow?**
- ✅ Safe testing on real Vercel infrastructure (not local)
- ✅ No CORS issues, no file:// protocol problems
- ✅ Can share preview URL for feedback/testing
- ✅ `main` stays clean and production-ready
- ✅ Easy rollback if needed (revert merge commit)

**Optional: Development Branch** (for larger teams or multiple parallel features):
- Create a `dev` branch as staging environment
- Feature branches merge to `dev` first for integration testing
- `dev` merges to `main` for production releases
- Currently **not needed** for solo/small team development

**Branch naming conventions:**
- Features: `feature-name` or `add-feature-name`
- Bug fixes: `fix-bug-name`
- Experiments: `experiment-name` or `test-feature-name`
- AI assistant work: `claude/feature-name` (optional)

**When working directly on `main` branch:**
- Sometimes you'll work directly on main for quick fixes or iterations
- **Still follow the "commit when complete" rule** - no micro-commits!
- Example of good commit timing:
  - ✅ Feature complete: "Add signature lock/unlock functionality"
  - ✅ Bug fixed: "Fix PDF file size optimization"
  - ✅ Multiple related changes: "Update changelog with user-friendly content"
  - ❌ Too early: "Add state variable" (wait until feature works)
  - ❌ Too granular: "Fix typo in comment" (batch with actual work)

### Standardized Workflow for Major Changes (AI Assistants)

When making significant changes (new features, architecture changes, library updates), follow this workflow:

**Phase 1: Implementation**
1. Create feature branch from `main`
2. Implement changes on feature branch
3. Push to branch for Vercel preview
4. User tests on Vercel preview
5. Get user approval that implementation works

**Phase 2: Documentation (after implementation approved)**
Once the user confirms the implementation works, update these files IN THIS ORDER:

1. **README.md** - Update user-facing documentation
   - Add to "Update Terbaru" section if it's a notable change
   - Update Tech Stack if libraries changed
   - Update Project Structure if file structure changed

2. **js/changelog.js** - Add entry for user notification
   - Add new entry at the BEGINNING of `changelogData` array
   - Follow the changelog writing guidelines below

3. **CLAUDE.md** - Update technical documentation
   - Update relevant sections (file structure, libraries, patterns, etc.)
   - Keep this file accurate for future AI assistants

**Phase 3: User Review (CRITICAL - DO NOT SKIP)**

⚠️ **NEVER commit without explicit user permission!**

After making all edits:
1. **STOP** and inform the user what files were changed
2. List the files modified (e.g., "I've updated README.md, changelog.js, and CLAUDE.md")
3. **Wait** for user to review changes in their IDE
4. User will either:
   - **Commit themselves** after reviewing, OR
   - **Ask you to commit** after they've checked

**DO NOT** proceed to commit until user explicitly says so.

**Phase 4: Finalize (only after user approval to commit)**
1. Commit changes (if user asked you to)
2. Push to feature branch
3. Merge to main (after user approval)

### Writing Changelog Entries

The changelog is displayed to end users via a notification badge. Write entries that are:

**Tone & Style:**
- **User-friendly** - Write for non-technical Indonesian users
- **Benefit-focused** - Explain what it means for THEM, not what you did technically
- **Casual & friendly** - Use "kamu" not "anda", emojis are OK
- **Bahasa Indonesia** - All text in Indonesian

**Structure:**
```javascript
{
  title: "Judul yang Menarik! 📴",  // Short, catchy, benefit-focused
  description: "Penjelasan yang lebih detail tentang apa manfaatnya buat user. Gunakan bahasa yang santai dan mudah dimengerti. Boleh pakai emoji.",
  date: "DD MMMM YYYY"  // e.g., "18 Januari 2026"
}
```

**Good Examples:**
- ✅ Title: "Bisa Dipakai Tanpa Internet! 📴"
- ✅ Description: "PDFLokal sekarang bisa dipakai offline! Edit PDF, gabung, pisah - semua bisa tanpa koneksi internet."
- ❌ Title: "Self-hosted libraries for offline support" (too technical)
- ❌ Description: "Implemented fake worker mode for PDF.js" (user doesn't care)

**Credit Contributors:**
```javascript
description: "... Terima kasih <a href=\"https://github.com/username\" target=\"_blank\">@username</a>! 🙏"
```

## Privacy and Security

**Critical Requirements**:
- Files must NEVER leave the user's device
- No analytics or tracking without explicit user consent
- No external API calls with user data
- Open source = users can verify privacy claims

### Security Headers (vercel.json)

PDFLokal implements security headers via `vercel.json`:

| Header | Value | Purpose |
|--------|-------|---------|
| X-Content-Type-Options | nosniff | Prevent MIME-type sniffing |
| X-Frame-Options | DENY | Prevent clickjacking |
| X-XSS-Protection | 1; mode=block | XSS filter (legacy browsers) |
| Referrer-Policy | strict-origin-when-cross-origin | Limit referrer info |
| Permissions-Policy | camera=(), microphone=(), geolocation=(), payment=() | Disable unused APIs |
| Content-Security-Policy | (see below) | Control resource loading |

### Content Security Policy (CSP)

The CSP is configured to allow PDFLokal's specific requirements:

```
default-src 'self';
script-src 'self' 'unsafe-inline' 'unsafe-eval' https://esm.sh blob:;
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self';
connect-src 'self' https://esm.sh;
frame-ancestors 'none';
base-uri 'self';
form-action 'self';
object-src 'none'
```

**Why 'unsafe-inline' and 'unsafe-eval':**
- `'unsafe-inline'` for scripts: Required for theme flash prevention, JSON-LD schema, Vercel analytics init, pdfjsLib config
- `'unsafe-eval'`: Required by PDF.js and fontkit libraries for dynamic code execution
- `'unsafe-inline'` for styles: Inline styles in HTML and dynamic style manipulation
- Nonces would require server-side rendering or build step (against project philosophy)

**If adding new features that require external resources:**
1. Test on Vercel preview first
2. Check browser console for CSP violations
3. Update CSP in vercel.json if needed
4. Document the change in this section

### Security Files

| File | URL | Purpose |
|------|-----|---------|
| security.txt | /.well-known/security.txt | Security contact for vulnerability reports |
| humans.txt | /humans.txt | Team and contributor credits |
| privasi.html | /privasi.html | Privacy policy in Indonesian |

The `security.txt` file is served at `/.well-known/security.txt` via a rewrite rule in `vercel.json`.

## Support and Monetization

- Free to use, no login required
- Optional donations via `dukung.html`
- No paywalls or premium features
- Keep the tool accessible to everyone

## Quick Reference

### Main Files to Edit

- `index.html` - Add/modify tools UI (HTML structure)
- `js/init.js` - App bootstrap, dropzone, tool cards, file handling
- `js/keyboard.js` - Keyboard shortcuts
- `js/mobile-ui.js` - Mobile navigation and UI
- `js/editor/*.js` - Unified editor modules (see file structure above)
- `js/pdf-tools/*.js` - PDF tool modal modules
- `js/image-tools.js` - Image processing tools
- `js/lib/state.js` - All state objects and constants
- `js/lib/utils.js` - Shared utility functions
- `js/lib/navigation.js` - Workspace/modal navigation
- `js/changelog.js` - Changelog notification system
- `style.css` - Update styles
- `README.md` - Update user documentation

### Don't Modify Without Good Reason

- `vercel.json` - Security headers and CSP (test thoroughly on Vercel preview!)
- Library CDN links (unless updating versions)
- Core privacy promises (client-side only)
- Indonesian language UI (don't translate to English)

## Questions to Ask Before Making Changes

1. Does this maintain client-side only processing?
2. Is the UI text in Indonesian?
3. Will this work on mobile browsers?
4. Have I tested with large files?
5. Is this consistent with existing code style?
6. Does this introduce new dependencies unnecessarily?

## Key Technical Patterns

### ES Module Patterns

**Import conventions:**
```javascript
// Import from shared foundations
import { state, ueState } from './lib/state.js';
import { showToast } from './lib/utils.js';

// Import from barrel files (preferred for cross-package imports)
import { ueSelectPage, ueRedrawAnnotations } from './editor/index.js';
import { openSignatureModal } from './pdf-tools/index.js';

// Import from specific sub-modules (within same package)
import { ueGetCurrentCanvas } from './canvas-utils.js';

// Vendor globals (loaded as <script> tags before modules)
const { PDFDocument } = window.PDFLib;
```

**Window bridge pattern** (required for HTML `onclick` handlers):
```javascript
// In the module file
export function myFunction() { /* ... */ }

// In the barrel index.js
import { myFunction } from './my-module.js';
export { myFunction } from './my-module.js';  // re-export
window.myFunction = myFunction;               // bridge for onclick
```

**Circular dependency resolution:**
When two modules would import from each other, one direction uses `window.*` instead:
```javascript
// sidebar.js needs ueSelectPage from page-rendering.js
// page-rendering.js needs ueRenderThumbnails from sidebar.js
// Solution: sidebar.js uses window.ueSelectPage() to break the cycle
```

Key circular pairs resolved with `window.*`:
- sidebar ↔ page-rendering (sidebar uses `window.*`)
- signatures ↔ tools (signatures uses `window.ueSetTool()`)
- page-rendering ↔ canvas-events (page-rendering uses `window.ueSetupCanvasEvents()`)
- page-rendering ↔ undo-redo (page-rendering uses `window.ueSaveUndoState()`)

### FileList to Array Conversion
When handling file inputs with async operations:
```javascript
const filesArray = Array.from(e.target.files);
input.value = ''; // Reset AFTER converting to array
await processFiles(filesArray); // FileList would be empty if reset before conversion
```

### Drag-Drop Reordering Patterns
- **Horizontal lists** (like Page Manager): Use `clientX` and `rect.left + rect.width / 2`
- **Vertical lists** (like sidebar): Use `clientY` and `rect.top + rect.height / 2`
- Always use event delegation for dynamically created elements
- Store drop indicator element in state for cleanup

### Home-View Visibility Pattern
- **Problem**: `showTool()` immediately hides home-view, causing blank screen during file picking
- **Solution**: Bypass `showTool()` for file-picker-first flows, manually manage workspace visibility after files load
- **Critical**: When bypassing `showTool()`, must manually add `document.body.classList.add('editor-active')` for the editor to display correctly (hides site chrome, removes container max-width)
- **Benefits**: Home-view stays visible, loading overlay provides feedback, better UX

### Multi-Canvas Continuous Scroll Architecture

The unified editor uses one `<canvas>` per page inside `#ue-pages-container`:

```html
<div id="ue-pages-container">
  <div class="ue-page-slot" data-page-index="0"><canvas class="ue-page-canvas"></canvas></div>
  <div class="ue-page-slot" data-page-index="1"><canvas class="ue-page-canvas"></canvas></div>
</div>
```

**Key functions:**
- `ueCreatePageSlots()` — Builds DOM, sets placeholder dimensions, starts IntersectionObserver
- `ueRenderPageCanvas(index)` — Renders one page to its canvas (called by observer)
- `ueRedrawPageAnnotations(index)` — Restores page cache + draws annotations
- `ueRenderVisiblePages()` — Re-renders all visible pages (rAF-throttled, for zoom/resize)
- `ueSetupIntersectionObserver()` — Lazy render + memory management (`root: null` for viewport)
- `ueSetupScrollSync()` — Window scroll → selectedPage → sidebar highlight (guarded by currentTool)
- `ueSetWrapperHeight()` — No-op (body scroll, no fixed wrapper height needed)
- `ueGetCurrentCanvas()` — Returns selected page's canvas element
- `ueGetCoords(e, canvas, dpr)` — Mouse/touch → canvas coordinates
- `ueGetResizeHandle(anno, x, y)` — Hit test for annotation resize handles
- `rebuildAnnotationMapping(oldPages)` — Reference-based annotation/cache reindex after page reorder/delete
- `clearPdfDocCache()` — Destroys cached PDF.js documents (called from ueReset)
- `ueRemoveScrollSync()` — Cleans up window scroll listener (called from ueReset)

**Layout reflow guard:**
`ueAddFiles()` uses `await new Promise(resolve => requestAnimationFrame(resolve))` before `ueCreatePageSlots()` to ensure the browser has laid out the workspace (so `clientWidth` returns a real value, not 0).

**Event delegation pattern:**
Events attach to `#ue-pages-container`. Helper `getCanvasAndCoords(e)` returns `{ canvas, pageIndex, x, y }` from any mouse/touch event by finding the nearest `.ue-page-slot`.

### Visual Rotation Display
Apply CSS transforms to match page rotation state:
```javascript
if (page.rotation && page.rotation !== 0) {
  canvas.style.transform = `rotate(${page.rotation}deg)`;
}
```

### Fullscreen Loading Overlay
Use for async operations where workspace isn't ready yet:
- Shows spinner and message
- Keeps previous view visible behind semi-transparent overlay
- Better UX than blank screen or immediate transition

### Modal CSS Pattern (Visibility + Opacity)
**Preferred method** for showing/hiding modals (more reliable than `display: none/flex`):

```css
/* Modal base state - always flex layout, but hidden */
.edit-modal {
  display: flex;
  align-items: center;
  justify-content: center;
  visibility: hidden;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease, visibility 0.2s ease;
}

/* Modal active state */
.edit-modal.active {
  visibility: visible;
  opacity: 1;
  pointer-events: all;
}
```

**Benefits:**
- No need for inline `modal.style.display = 'flex'` workarounds
- Smooth transitions work reliably
- Flexbox layout always calculated (no layout thrashing)
- Clean JavaScript: just toggle `.active` class

**JavaScript usage:**
```javascript
// Open modal
modal.classList.add('active');

// Close modal
modal.classList.remove('active');
```

**Click-outside-to-close:**
All modals automatically close when clicking the backdrop. This is handled by a single delegated listener in `initModalBackdropClose()` (`js/init.js`) that maps modal IDs to their close functions. When adding a new modal, add its ID and close function name to the `modalCloseMap` object.

**Avoid:**
```javascript
// DON'T do this anymore
modal.style.display = 'flex';  // Workaround for old CSS pattern
modal.style.display = '';      // Cleanup
```

### Shared Utilities (js/lib/utils.js)

Common canvas operations extracted to avoid duplication across modules:

- **`makeWhiteTransparent(canvas, threshold)`** — Pixel-loop that sets white/near-white pixels transparent. Used in: image-tools.js (Remove Background), signature-modal.js (draw + upload paths).
- **`setupCanvasDPR(canvas)`** — Scales canvas buffer for devicePixelRatio, returns ratio. Used in: init.js (signature pad), signature-modal.js (draw tab setup).

### Named Constants (js/lib/state.js)

Magic numbers extracted to named constants for maintainability:

```javascript
export const UNDO_STACK_LIMIT = 50;        // Max undo/redo stack size
export const SIGNATURE_DEFAULT_WIDTH = 150; // Default signature placement width (px)
export const OBSERVER_ROOT_MARGIN = '200px 0px'; // IntersectionObserver buffer
export const DOUBLE_TAP_DELAY = 300;        // Max ms between taps for double-tap
export const DOUBLE_TAP_DISTANCE = 30;      // Max px drift for double-tap
```

### File Input Handler Factory (js/init.js)

`setupFileInput(inputId, { loadingMsg, errorMsg, handler, allFiles })` — DRY factory for file input `change` handlers. Wraps loading overlay, error handling, and input reset. All 9 file inputs use this pattern.

### Reliability & Hardening Patterns

**Race condition guards:**
- `isLoadingFiles` flag in `file-loading.js` prevents concurrent `ueAddFiles()` calls
- `isDownloading` flag in `pdf-export.js` prevents double-click downloads
- `isRestoring` flag in `ueState` blocks scroll sync and nested undo/redo during restore
- `ueRenderingPages` Set in `page-rendering.js` prevents concurrent renders of same page
- `saved` closure flag in inline text editor prevents blur+Enter double-save

**Page reorder/delete pattern (reference-based):**
```javascript
const oldPages = [...ueState.pages];        // snapshot BEFORE splice
ueState.pages.splice(draggedIndex, 1);      // mutate
ueState.pages.splice(insertAt, 0, movedPage);
rebuildAnnotationMapping(oldPages);          // uses indexOf() reference equality
```

**Resource lifecycle:**
- `pdfDocCache` (Map in page-rendering.js) caches PDF.js documents, `.destroy()` on reset
- `ueRemoveScrollSync()` cleans up window scroll listener on reset
- `clearPdfDocCache()` destroys all cached PDF documents on reset
- IntersectionObserver disconnected during Gabungkan modal, reconnected on close

**Safe localStorage:**
- Use `safeLocalGet(key)` / `safeLocalSet(key, val)` from `utils.js` — wraps in try/catch for private browsing

---

**Remember**: PDFLokal exists to give Indonesian users a private, free, easy-to-use PDF tool. Every change should support that mission.
