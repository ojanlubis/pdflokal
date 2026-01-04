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
├── index.html      # Main application - all PDF/image tools
├── dukung.html     # Donation/support page
├── style.css       # All application styles
├── app.js          # All application logic
├── images/         # UI assets and icons
└── README.md       # User-facing documentation
```

### Single-Page Architecture

The entire application is in `index.html`. Features are organized as:
- Separate sections/modals for each tool
- JavaScript in `app.js` handles all tool logic
- All styles in single `style.css` file

### State Management

The app uses several state objects for different tools:

```javascript
// Unified Editor state
ueState = {
  files: [],           // Loaded PDF files
  pages: [],           // All pages from all files
  annotations: {},     // Per-page annotations {pageId: [annotations]}
  undoStack: [],       // Page operation history
  redoStack: [],       // Page operation redo
  annotationUndo: {},  // Per-page annotation undo
  annotationRedo: {},  // Per-page annotation redo
  zoom: 1.0            // Current zoom level
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

Features:
- **Multi-file support**: Load and merge multiple PDFs in one session
- **Page operations**: Reorder (drag-drop in sidebar AND modal), rotate, delete pages
- **Sidebar thumbnails**: Drag-drop reordering, visual rotation display
- **Gabungkan Modal**: "Merge" button (sidebar header) opens full-page management with drag-drop reorder, rotate, delete, add pages, and multi-select split
- **Split mode**: Multi-select pages to extract as separate PDFs
- **Annotations**: Whiteout, text, signatures
- **Text annotations**: Font family (Helvetica, Times, Courier, Montserrat, Carlito), bold/italic styling, custom font size (6-120pt), quick color presets
- **Signature upload**: Supports images for signatures AND stamps, with background removal option
- **Signature preview**: Position signatures before placing
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

**Toolbar Structure (Two Lines):**
- Line 1: Signature button, secondary tools (Pilih, Whiteout, Teks), "Lainnya" dropdown (Watermark, Nomor Halaman, Kunci PDF)
- Line 2: Zoom controls, Rotate button, action buttons (Undo/Redo/Clear), Download PDF button
- Floating "?" button: Opens keyboard shortcuts help modal

**Sidebar Structure:**
- Header: "Merge" button (opens Gabungkan modal), close button
- Thumbnails: Drag-drop reorderable, visual rotation, click to navigate
- Footer: Page indicator (e.g., "1 / 5")

#### Other PDF Tools (Standalone Workspaces)
- **PDF to Image**: Convert pages to PNG/JPG with batch export
- **Compress PDF**: Compress embedded images within PDFs
- **Protect PDF**: Add password protection (also available in Unified Editor via "Kunci PDF")

**Removed Tools:**
- Crop PDF (removed)
- Unlock PDF / Buka Kunci (removed completely)
- Legacy Edit PDF (merged into Unified Editor)
- Legacy Kelola Halaman / Page Manager (merged into Unified Editor)
- Watermark standalone workspace (removed - now only in Unified Editor via "Lainnya")
- Page Numbers standalone workspace (removed - now only in Unified Editor via "Lainnya")

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
- **Browser back button support**: Uses History API to handle workspace/modal navigation
- **File size warnings**: Shows info toast for files >20MB, blocks files >100MB
- **Browser compatibility check**: Validates required features on page load
- **Loading states**: Spinner on buttons during processing (PDF download, protect, etc.)
- **Fullscreen loading overlay**: Used for async operations (Merge/Split cards) - home-view stays visible during file picking, overlay shows during PDF loading
- **File picker UX pattern**: Merge/Split cards use `handleMergePdfCard()` and `handleSplitPdfCard()` which bypass `showTool()` to keep home-view visible until files are loaded

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
- Use vanilla JavaScript (ES6+)
- Avoid adding new npm dependencies unless absolutely necessary
- Keep code simple and readable
- Maintain consistency with existing code style
- Comment complex logic in Indonesian or English

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

1. Add new annotation type to `ueState.annotations` structure
2. Add tool button in the editor toolbar (Line 1 for tools, or in "Lainnya" dropdown for less common tools)
3. Implement drawing/placement logic in `app.js`
4. Add rendering in the PDF export function (`ueBuildFinalPDF`)
5. Ensure undo/redo works for the new annotation type
6. Test across multiple pages and files

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

All loaded from CDN (no npm/build dependencies):

| Library | Version | Purpose |
|---------|---------|---------|
| **pdf-lib** | 1.17.1 | PDF manipulation (merge, split, edit, add pages, etc.) |
| **PDF.js** | 3.11.174 | PDF rendering and thumbnail generation |
| **Signature Pad** | 4.1.7 | Digital signature capture (canvas-based) |
| **Google Fonts** | - | Montserrat font (embedded in PDF via fetch) |
| **Vercel Insights** | - | Analytics (optional) |

### Custom Fonts
- **Montserrat**: Loaded from Google Fonts CDN, embedded in PDF on export
- **Carlito**: Open-source Calibri alternative, loaded from Google Fonts
- Standard PDF fonts (Helvetica, Times, Courier) don't require embedding

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

- Work on feature branches starting with `claude/`
- Write clear, descriptive commit messages
- Test thoroughly before pushing
- Keep commits focused and atomic

## Privacy and Security

**Critical Requirements**:
- Files must NEVER leave the user's device
- No analytics or tracking without explicit user consent
- No external API calls with user data
- Open source = users can verify privacy claims

## Support and Monetization

- Free to use, no login required
- Optional donations via `dukung.html`
- No paywalls or premium features
- Keep the tool accessible to everyone

## Quick Reference

### Main Files to Edit

- `index.html` - Add/modify tools UI
- `app.js` - Add/modify tool logic
- `style.css` - Update styles
- `README.md` - Update user documentation
- `dukung.html` - Donation page

### Don't Modify Without Good Reason

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
- **Benefits**: Home-view stays visible, loading overlay provides feedback, better UX

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

---

**Remember**: PDFLokal exists to give Indonesian users a private, free, easy-to-use PDF tool. Every change should support that mission.
