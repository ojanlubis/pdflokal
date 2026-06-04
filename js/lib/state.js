/*
 * ============================================================
 * PDFLokal - js/lib/state.js
 * Shared State Objects
 * ============================================================
 *
 * All mutable state objects live here so every module can import
 * the same reference. JS objects are pass-by-reference, so
 * mutations are visible everywhere.
 *
 * LOAD ORDER: Must be the FIRST module loaded (no dependencies).
 * ============================================================
 */

// ============================================================
// APP STATE (shared across all tools)
// ============================================================

export const state = {
  // --- Active workspace ---
  currentTool: null,            // Which workspace is showing ('unified-editor', 'compress-pdf', etc.)

  // --- PDF loading (standalone tools: compress, protect, pdf-to-img) ---
  currentPDF: null,             // pdfjsLib document object for the loaded PDF
  currentPDFBytes: null,        // Raw ArrayBuffer of the loaded PDF file
  currentPDFName: null,         // Filename of the currently loaded PDF (set on load)
  originalPDFName: null,        // Original filename for output naming (e.g. "invoice.pdf")

  // --- Image loading (compress, resize, convert, remove-bg tools) ---
  originalImage: null,          // HTMLImageElement of the loaded image
  originalImageName: null,      // Original filename
  originalImageSize: 0,         // Original file size in bytes (for compression stats)
  originalWidth: 0,             // Natural width of loaded image
  originalHeight: 0,            // Natural height of loaded image
  compressedBlob: null,         // Result blob after image compression
  compressPreviewUrl: null,     // Object URL for compression preview (needs revoking)

  // --- Standalone merge tool (pdf-tools.js merge workspace) ---
  mergeFiles: [],               // Array of { name, bytes, thumbnail } for merge list
  currentImages: [],            // Loaded images for standalone tools

  // --- Standalone page manager (legacy, pdf-tools.js) ---
  splitPages: [],               // Pages for split tool
  rotatePages: [],              // Pages for rotate tool
  pagesOrder: [],               // Page ordering state
  pmPages: [],                  // Array of { pageNum, sourceFile, sourceName, rotation, selected, canvas }
  pmSourceFiles: [],            // Array of { name, bytes }
  pmUndoStack: [],              // Undo stack for standalone page manager
  pmRedoStack: [],              // Redo stack for standalone page manager

  // --- Legacy edit mode annotations (pdf-tools.js) ---
  editAnnotations: {},          // Per-page annotations { pageNum: [...] }
  currentEditPage: 0,           // Currently visible page in legacy editor
  currentEditTool: null,        // Active tool ('whiteout', 'text', 'signature')
  editUndoStack: [],            // Annotation undo history
  editRedoStack: [],            // Annotation redo history
  selectedAnnotation: null,     // Currently selected annotation { pageNum, index }
  pendingTextPosition: null,    // Where text will be placed { x, y }
  editPageScales: {},           // Per-page scale factors for coordinate mapping
  editDevicePixelRatio: 1,      // Device pixel ratio for high-DPI displays
  editCanvasSetup: false,       // Guard: prevents duplicate canvas event listeners

  // --- Signature (shared by legacy editor + unified editor, via pdf-tools.js) ---
  signaturePad: null,           // SignaturePad instance (canvas-based drawing)
  signatureImage: null,         // Final signature as canvas/image (optimized, ready to embed)
  signatureUploadImage: null,   // Uploaded image before background removal
  signatureUploadCanvas: null,  // Canvas used for signature bg removal preview

  // --- Paraf (initials) ---
  parafPad: null,               // SignaturePad instance for paraf canvas

  // --- Image to PDF tool (image-tools.js) ---
  imgToPdfFiles: [],            // Array of loaded image files for PDF conversion
  pdfImgPages: [],              // Rendered page canvases for PDF-to-image export

  // --- Cleanup & guards ---
  blobUrls: [],                 // All created object URLs (revoked on tool close)
  workspaceDropZonesSetup: new Set(), // Tracks which workspaces have drop zones initialized
};

// ============================================================
// FILE SIZE LIMITS
// ============================================================

export const MAX_FILE_SIZE_WARNING = 20 * 1024 * 1024; // 20MB - show warning
export const MAX_FILE_SIZE_LIMIT = 100 * 1024 * 1024;  // 100MB - hard limit

// Editor constants
export const UNDO_STACK_LIMIT = 50;             // Max undo/redo history entries
export const SIGNATURE_DEFAULT_WIDTH = 150;     // Default signature placement width (px)
export const PARAF_DEFAULT_WIDTH = 80;          // Default paraf/initials placement width (px)
export const OBSERVER_ROOT_MARGIN = '200px 0px'; // IntersectionObserver lazy-load buffer
export const DOUBLE_TAP_DELAY = 300;            // ms threshold for double-tap detection
export const DOUBLE_TAP_DISTANCE = 30;          // px threshold for double-tap proximity
// WHY: At 200% browser zoom on Retina (DPR 4), each A4 canvas = ~42MB GPU memory.
// 5 pages = 400MB+, causing Chrome to silently fail canvas allocation.
// DPR 2 is visually indistinguishable from 3-4 on all screens.
export const MAX_CANVAS_DPR = 2;

// ============================================================
// MOBILE STATE (device detection results)
// ============================================================

// WHY: Only isTouch kept — capability-based, doesn't change after init.
// Layout decisions use CSS @media (max-width: 900px) as single source of truth.
// Removed: isMobile (768px width check mismatched CSS 900px breakpoint),
// orientation/viewportWidth/viewportHeight (set but never read anywhere).
export const mobileState = {
  isTouch: false
};

// ============================================================
// DEVICE CAPABILITY — populated by detectMobile() in init.js
// ============================================================
// WHY: Rendering pipeline needs device-class awareness (not just screen width).
// Inspired by PDF.js maxCanvasPixels, Excalidraw formFactor, tldraw coarsePointer.
// Used as a read-only reference for rendering decisions (pixel budget, etc.).

export const deviceCapability = {
  isTouch: false,           // 'ontouchstart' in window || maxTouchPoints > 0
  isCoarsePointer: false,   // matchMedia('(any-pointer: coarse)')
  formFactor: 'desktop',    // 'phone' | 'tablet' | 'desktop' (from viewport width)
  maxCanvasPixels: 16_777_216 // 16MP desktop, 10MP tablet, 5MP phone
};

// ============================================================
// NAVIGATION HISTORY
// ============================================================

export const navHistory = {
  currentView: 'home',      // 'home', 'workspace', 'modal'
  currentWorkspace: null,   // Current tool name when in workspace
  currentModal: null        // Current modal id when modal is open
};

// ============================================================
// UNIFIED EDITOR STATE
// ============================================================

// Default values for ueState — used by initial definition and ueReset().
// Adding a new field here automatically gets it reset. (SSOT)
export function getDefaultUeState() {
  return {
    // --- Document data ---
    pages: [],
    sourceFiles: [],
    selectedPage: -1,
    // --- Editing tools ---
    currentTool: null,
    annotations: {},
    selectedAnnotation: null,
    pendingTextPosition: null,
    // --- Undo/redo (unified stack, entries tagged { type: 'page'|'annotation', ... }) ---
    undoStack: [],
    redoStack: [],
    // --- Rendering ---
    pageScales: {},
    pageCaches: {},
    pageCanvases: [],
    scrollSyncEnabled: true,
    zoomLevel: 1.0,
    // --- Signature placement ---
    pendingSignature: false,
    signaturePreviewPos: null,
    pendingSignatureWidth: null,
    pendingSubtype: null,
    // WHY: When the user checks "Tempel di semua halaman" before pressing Gunakan
    // in the paraf modal, the very next paraf placement also clones onto every
    // other page. Without this flag, the user had to discover post-placement
    // that selecting the paraf surfaces a "Semua Hal." button — UX audit
    // finding H7. Cleared after the first placement.
    pendingApplyToAllPages: false,
    resizeHandle: null,
    resizeStartInfo: null,
    // --- Interaction ---
    isDragging: false,
    isResizing: false,
    sidebarDropIndicator: null,
    // --- UX ---
    lastLockedToastAnnotation: null,
    // --- Guards ---
    isRestoring: false,
  };
}

export const ueState = {
  ...getDefaultUeState(),
  // Fields that persist across resets (intentionally NOT in getDefaultUeState):
  devicePixelRatio: 1,    // Set on init, updated on render
  eventsSetup: false,     // Guard: true after event delegation attached (one-time setup)
  pageObserver: null,     // IntersectionObserver — needs .disconnect() side effect on reset
  // WHY: Remembers the formatting of the last-typed text annotation so the next
  // text annotation picks up the same style. Without this, every annotation
  // would reset to Helvetica/16pt/black and Sari would re-pick the same font
  // 8 times to fill a contract. Persists across file loads in the same session,
  // hence outside getDefaultUeState. (UX audit finding H2.)
  lastTextOptions: {
    fontSize: 16,
    color: '#000000',
    fontFamily: 'Helvetica',
    bold: false,
    italic: false,
  },
};

// ============================================================
// PAGE OBJECT FACTORY (SSOT for page shape)
// ============================================================

// Single factory for creating page info objects. All code paths that add pages
// must use this to guarantee a consistent shape. (SSOT)
export function createPageInfo({ pageNum, sourceIndex, sourceName, rotation = 0, canvas, thumbCanvas = null, isFromImage = false }) {
  return { pageNum, sourceIndex, sourceName, rotation, canvas, thumbCanvas, isFromImage };
}

// SINGLE SOURCE OF TRUTH — wraps any in-place mutation of `ueState.pages`
// (reorder, delete a subset) so that every parallel map keyed by page index
// follows the mutation atomically. Closes the bug class behind Sentry JS-4
// (stale selectedAnnotation), JS-7 (stale annotations bucket), and JS-8
// (parallel-map drift).
//
// Re-keys: annotations, pageCaches, pageScales (all keyed by index).
// Reseats: selectedPage and selectedAnnotation.pageIndex (captured as page
// object refs BEFORE the mutation, looked up via indexOf AFTER).
//
// Does NOT touch:
//   - ueState.pageCanvases: holds live DOM elements. Each caller is
//     responsible for splicing it in the same shape as `pages`. Page-rendering
//     deletePage and createPageSlots own this.
//   - ueState.sourceFiles, sourceFileBytes, etc: not page-indexed.
//
// Do NOT use for ueRestorePages (undo) — that builds a fresh pages array
// from a serialized snapshot with no object overlap, so the index-based maps
// all collapse to defaults. That path uses its own helpers.
//
// Usage:
//   mutatePages(() => {
//     const [moved] = ueState.pages.splice(from, 1);
//     ueState.pages.splice(insertAt, 0, moved);
//   });
export function mutatePages(fn) {
  const oldPages = ueState.pages.slice();
  const oldAnnotations = { ...ueState.annotations };
  const oldCaches = { ...ueState.pageCaches };
  const oldScales = { ...ueState.pageScales };
  const oldSelectedPage = ueState.selectedPage;
  const oldSelectedAnno = ueState.selectedAnnotation;
  // Capture references BEFORE the mutation. After the mutation, we look these
  // up by indexOf to find their new positions (or learn they were removed).
  const selectedPageRef = (oldSelectedPage >= 0 && oldSelectedPage < oldPages.length)
    ? oldPages[oldSelectedPage]
    : null;
  const selectedAnnoPageRef = (oldSelectedAnno && oldPages[oldSelectedAnno.pageIndex]) || null;

  fn();

  // Re-key index-based parallel maps using page reference equality.
  const newAnnotations = {};
  const newCaches = {};
  const newScales = {};
  ueState.pages.forEach((page, newIdx) => {
    const oldIdx = oldPages.indexOf(page);
    newAnnotations[newIdx] = (oldIdx >= 0 ? oldAnnotations[oldIdx] : null) || [];
    if (oldIdx >= 0) {
      if (oldCaches[oldIdx]) newCaches[newIdx] = oldCaches[oldIdx];
      if (oldScales[oldIdx]) newScales[newIdx] = oldScales[oldIdx];
    }
  });
  ueState.annotations = newAnnotations;
  ueState.pageCaches = newCaches;
  ueState.pageScales = newScales;

  // Reseat selectedPage by chasing the previously-selected page ref.
  if (selectedPageRef) {
    const newIdx = ueState.pages.indexOf(selectedPageRef);
    if (newIdx >= 0) {
      ueState.selectedPage = newIdx;
    } else if (ueState.pages.length === 0) {
      ueState.selectedPage = -1;
    } else {
      // Selected page was removed. Fall back to the nearest still-valid
      // index — preserves the "stay near where you were" intuition.
      ueState.selectedPage = Math.min(oldSelectedPage, ueState.pages.length - 1);
    }
  } else if (ueState.pages.length === 0) {
    ueState.selectedPage = -1;
  }

  // Reseat selectedAnnotation by chasing its old page ref AND verifying the
  // annotation at the recorded index still exists in the re-keyed bucket.
  if (selectedAnnoPageRef && oldSelectedAnno) {
    const newPageIdx = ueState.pages.indexOf(selectedAnnoPageRef);
    if (newPageIdx >= 0 && newAnnotations[newPageIdx]?.[oldSelectedAnno.index]) {
      ueState.selectedAnnotation = { pageIndex: newPageIdx, index: oldSelectedAnno.index };
    } else {
      ueState.selectedAnnotation = null;
    }
  } else if (oldSelectedAnno) {
    // The annotation's page was removed entirely.
    ueState.selectedAnnotation = null;
  }
}

// ============================================================
// ANNOTATION FACTORIES (SSOT for annotation shapes)
// SINGLE SOURCE OF TRUTH — all annotation creation must use these factories.
// Never construct annotation objects inline. Adding a field here guarantees
// all annotations get it.
// ============================================================

export function createWhiteoutAnnotation({ x, y, width, height }) {
  return { type: 'whiteout', x, y, width, height };
}

export function createTextAnnotation({ text, x, y, fontSize, color, fontFamily, bold = false, italic = false }) {
  return { type: 'text', text, x, y, fontSize, color, fontFamily, bold, italic };
}

export function createSignatureAnnotation({ image, imageId, x, y, width, height, cachedImg = null, locked = false, subtype = null }) {
  const anno = { type: 'signature', image, imageId, x, y, width, height, cachedImg, locked };
  if (subtype) anno.subtype = subtype;
  return anno;
}

export function createWatermarkAnnotation({ text, fontSize, color, opacity, rotation, x, y }) {
  return { type: 'watermark', text, fontSize, color, opacity, rotation, x, y };
}

export function createPageNumberAnnotation({ text, fontSize, color = '#000000', x, y, position }) {
  return { type: 'pageNumber', text, fontSize, color, x, y, position };
}

// ============================================================
// PAGE MANAGER (GABUNGKAN) MODAL STATE
// ============================================================

export const uePmState = {
  isOpen: false,            // Whether the Gabungkan modal is currently visible
  extractMode: false,       // true = "Split" mode (multi-select pages for extraction)
  selectedForExtract: [],   // Array of page indices selected for split/extraction
  draggedIndex: -1,         // Index of the page currently being dragged (-1 = none)
  dropIndicator: null       // DOM element showing where dragged page will land
};

// ============================================================
// SHARED IMAGE REGISTRY (prevents base64 duplication in undo stack)
// ============================================================

export const imageRegistry = new Map();
let imageRegistryNextId = 0;

export function registerImage(dataUrl) {
  // Check if this exact dataUrl is already registered
  for (const [id, url] of imageRegistry) {
    if (url === dataUrl) return id;
  }
  const id = 'img_' + (imageRegistryNextId++);
  imageRegistry.set(id, dataUrl);
  return id;
}

export function getRegisteredImage(id) {
  return imageRegistry.get(id);
}

export function clearImageRegistry() {
  imageRegistry.clear();
  imageRegistryNextId = 0;
}

// ============================================================
// CSS FONT MAP (used in annotation drawing, inline editor, text bounds)
// ============================================================

export const CSS_FONT_MAP = {
  'Helvetica': 'Helvetica, Arial, sans-serif',
  'Times-Roman': 'Times New Roman, Times, serif',
  'Courier': 'Courier New, Courier, monospace',
  'Montserrat': 'Montserrat, sans-serif',
  'Carlito': 'Carlito, Calibri, sans-serif'
};

// SINGLE SOURCE OF TRUTH — builds CSS font string from annotation properties.
// WHY centralized: the if(italic)...if(bold)...CSS_FONT_MAP pattern was in 3 files.
// fontSize param allows callers to override (e.g. scaled fontSize for inline editor).
export function buildCanvasFont(anno, fontSize) {
  let style = '';
  if (anno.italic) style += 'italic ';
  if (anno.bold) style += 'bold ';
  const family = CSS_FONT_MAP[anno.fontFamily] || CSS_FONT_MAP['Helvetica'];
  return `${style}${fontSize ?? anno.fontSize}px ${family}`;
}

// ============================================================
// WINDOW BRIDGE (for non-module scripts and onclick handlers)
// ============================================================

window.state = state;
window.mobileState = mobileState;
window.navHistory = navHistory;
window.ueState = ueState;
window.uePmState = uePmState;
window.CSS_FONT_MAP = CSS_FONT_MAP;
window.MAX_FILE_SIZE_WARNING = MAX_FILE_SIZE_WARNING;
window.MAX_FILE_SIZE_LIMIT = MAX_FILE_SIZE_LIMIT;
