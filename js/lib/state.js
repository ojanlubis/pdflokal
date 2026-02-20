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

// ============================================================
// MOBILE STATE (device detection results)
// ============================================================

export const mobileState = {
  isMobile: false,
  isTouch: false,
  orientation: 'portrait',
  viewportWidth: 0,
  viewportHeight: 0
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
    // --- Undo/redo ---
    undoStack: [],
    redoStack: [],
    editUndoStack: [],
    editRedoStack: [],
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
};

// ============================================================
// PAGE OBJECT FACTORY (SSOT for page shape)
// ============================================================

// Single factory for creating page info objects. All code paths that add pages
// must use this to guarantee a consistent shape. (SSOT)
export function createPageInfo({ pageNum, sourceIndex, sourceName, rotation = 0, canvas, thumbCanvas = null, isFromImage = false }) {
  return { pageNum, sourceIndex, sourceName, rotation, canvas, thumbCanvas, isFromImage };
}

// ============================================================
// ANNOTATION FACTORIES (SSOT for annotation shapes)
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
