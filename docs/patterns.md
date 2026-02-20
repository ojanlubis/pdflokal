# PDFLokal Code Patterns Reference

Detailed code examples for common development tasks. See [CLAUDE.md](../CLAUDE.md) for project overview and architecture.

## ES Module Patterns

### Import conventions

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

### Window bridge pattern (required for HTML `onclick` handlers)

```javascript
// In the module file
export function myFunction() { /* ... */ }

// In the barrel index.js
import { myFunction } from './my-module.js';
export { myFunction } from './my-module.js';  // re-export
window.myFunction = myFunction;               // bridge for onclick
```

### Circular dependency resolution

When two modules would import from each other, one direction uses `window.*` instead:
```javascript
// sidebar.js needs ueSelectPage from page-rendering.js
// page-rendering.js needs ueRenderThumbnails from sidebar.js
// Solution: sidebar.js uses window.ueSelectPage() to break the cycle
```

Key circular pairs resolved with `window.*`:
- sidebar <-> page-rendering (sidebar uses `window.*`)
- signatures <-> tools (signatures uses `window.ueSetTool()`)
- page-rendering <-> canvas-events (page-rendering uses `window.ueSetupCanvasEvents()`)
- page-rendering <-> undo-redo (page-rendering uses `window.ueSaveUndoState()`)

## File Picker Card Pattern (Like Merge/Split PDF)

To create tool cards that trigger file picker before opening workspace:

1. **Don't call `showTool()` from `initToolCards()`** - it immediately hides home-view
2. Create dedicated handler that creates hidden file input and calls `input.click()`
3. In the async `change` handler: convert FileList to Array, show loading overlay, load files, manually manage visibility

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

## FileList to Array Conversion

```javascript
const filesArray = Array.from(e.target.files);
input.value = ''; // Reset AFTER converting to array
await processFiles(filesArray); // FileList would be empty if reset before conversion
```

## Multi-Canvas Continuous Scroll Architecture

```html
<div id="ue-pages-container">
  <div class="ue-page-slot" data-page-index="0"><canvas class="ue-page-canvas"></canvas></div>
  <div class="ue-page-slot" data-page-index="1"><canvas class="ue-page-canvas"></canvas></div>
</div>
```

**Key functions:**
- `ueCreatePageSlots()` -- Builds DOM, sets placeholder dimensions, starts IntersectionObserver
- `ueRenderPageCanvas(index)` -- Renders one page to its canvas (called by observer)
- `ueRedrawPageAnnotations(index)` -- Restores page cache + draws annotations
- `ueRenderVisiblePages()` -- Re-renders all visible pages (rAF-throttled, for zoom/resize)
- `ueSetupIntersectionObserver()` -- Lazy render + memory management (`root: null` for viewport)
- `ueSetupScrollSync()` -- Window scroll -> selectedPage -> sidebar highlight (guarded by currentTool)
- `ueGetCurrentCanvas()` -- Returns selected page's canvas element
- `ueGetCoords(e, canvas, dpr)` -- Mouse/touch -> canvas coordinates
- `ueGetResizeHandle(anno, x, y)` -- Hit test for annotation resize handles
- `rebuildAnnotationMapping(oldPages)` -- Reference-based annotation/cache reindex after page reorder/delete
- `clearPdfDocCache()` -- Destroys cached PDF.js documents (called from ueReset)
- `ueRemoveScrollSync()` -- Cleans up window scroll listener (called from ueReset)

**Layout reflow guard:**
`ueAddFiles()` uses `await new Promise(resolve => requestAnimationFrame(resolve))` before `ueCreatePageSlots()` to ensure the browser has laid out the workspace (so `clientWidth` returns a real value, not 0).

**Event delegation pattern:**
Events attach to `#ue-pages-container`. Helper `getCanvasAndCoords(e)` returns `{ canvas, pageIndex, x, y }` from any mouse/touch event by finding the nearest `.ue-page-slot`.

## Modal CSS Pattern (Visibility + Opacity)

Preferred method for showing/hiding modals:

```css
.edit-modal {
  display: flex;
  align-items: center;
  justify-content: center;
  visibility: hidden;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease, visibility 0.2s ease;
}
.edit-modal.active {
  visibility: visible;
  opacity: 1;
  pointer-events: all;
}
```

**JS:** Use `openModal(id)` / `closeModal(id)` from `navigation.js` for standard modals — handles `.active` class + history management automatically. Don't use `modal.style.display = 'flex'` or toggle classes manually.

```javascript
import { openModal, closeModal } from '../lib/navigation.js';

openModal('editor-watermark-modal');   // adds .active + pushes history state
closeModal('editor-watermark-modal');  // removes .active + history.back()
closeModal('editor-watermark-modal', true);  // skip history.back() (for popstate handler)
```

**Click-outside-to-close:** Handled by `initModalBackdropClose()` in `js/init.js`. When adding a new modal, add its ID and close function to the `modalCloseMap` object.

## Visual Rotation Display

```javascript
if (page.rotation && page.rotation !== 0) {
  canvas.style.transform = `rotate(${page.rotation}deg)`;
}
```

## Page Reorder/Delete Pattern (Reference-Based)

```javascript
const oldPages = [...ueState.pages];        // snapshot BEFORE splice
ueState.pages.splice(draggedIndex, 1);      // mutate
ueState.pages.splice(insertAt, 0, movedPage);
rebuildAnnotationMapping(oldPages);          // uses indexOf() reference equality
```

## Annotation Factory Pattern (SSOT)

All annotation creation uses factories from `js/lib/state.js`. Never construct annotation objects inline.

```javascript
import {
  createWhiteoutAnnotation,
  createTextAnnotation,
  createSignatureAnnotation,
  createWatermarkAnnotation,
  createPageNumberAnnotation
} from '../lib/state.js';

// Whiteout
const anno = createWhiteoutAnnotation({ x, y, width, height });

// Text (bold/italic default to false)
const anno = createTextAnnotation({ text, x, y, fontSize, color, fontFamily, bold: true });

// Signature (subtype optional: 'paraf' for initials)
const anno = createSignatureAnnotation({
  image, imageId, x, y, width, height, cachedImg, locked: false, subtype: 'paraf'
});

// Watermark
const anno = createWatermarkAnnotation({ text, fontSize, color, opacity, rotation, x, y });

// Page numbers
const anno = createPageNumberAnnotation({ text, fontSize, color, x, y, position });
```

## Image Registry Pattern (Undo Optimization)

Signature images are deduplicated via a shared registry in `js/lib/state.js`. The undo stack stores `imageId` references instead of raw base64 strings.

```javascript
import { registerImage, getRegisteredImage, clearImageRegistry } from '../lib/state.js';

// When placing a signature
const imageId = registerImage(signatureBase64);  // returns existing ID if duplicate
anno.imageId = imageId;

// When restoring from undo
const base64 = getRegisteredImage(anno.imageId);

// On editor reset
clearImageRegistry();
```

`cloneAnnotations()` in `undo-redo.js` strips `cachedImg` and `image` fields from signature annotations, keeping only the lightweight `imageId` reference.

## PDF Document Loading (SSOT)

Always use `loadPdfDocument()` instead of raw `pdfjsLib.getDocument()`:

```javascript
import { loadPdfDocument } from '../lib/utils.js';

const pdf = await loadPdfDocument(bytes);  // defensive .slice() included
```

## File Type Validation (SSOT)

Always use `isPDF()` / `isImage()` instead of inline `file.type ===` checks:

```javascript
import { isPDF, isImage } from '../lib/utils.js';

if (isPDF(file)) { /* ... */ }
if (isImage(file)) { /* ... */ }
```

## Signature Image Optimization

```javascript
function optimizeSignatureImage(sourceCanvas) {
  // Resize if >1500px (prevents 5000x5000 photos)
  // Detect transparency in alpha channel
  // Use JPEG 85% quality for photos (10-20x compression)
  // Use PNG only when transparency detected
  // Result: 2.5MB signature -> 300-400KB
}
```
