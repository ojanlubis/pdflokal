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
  cropRect: null,               // (unused — crop feature was removed)
  currentCropPage: 0,           // (unused — crop feature was removed)
  editCanvasSetup: false,       // Guard: prevents duplicate canvas event listeners

  // --- Signature (shared by legacy editor + unified editor, via pdf-tools.js) ---
  signaturePad: null,           // SignaturePad instance (canvas-based drawing)
  signatureImage: null,         // Final signature as canvas/image (optimized, ready to embed)
  signatureUploadImage: null,   // Uploaded image before background removal
  signatureUploadCanvas: null,  // Canvas used for signature bg removal preview

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

export const ueState = {
  // --- Document data ---
  pages: [],              // All loaded pages: [{ pageNum, sourceIndex, sourceName, rotation, canvas }]
  sourceFiles: [],        // Source PDF files: [{ name, bytes }] — indexes match pages[].sourceIndex
  selectedPage: -1,       // Index into pages[] of the currently visible page

  // --- Editing tools ---
  currentTool: null,      // Active annotation tool: 'select' | 'whiteout' | 'text' | 'signature' | null
  annotations: {},        // Per-page annotation arrays: { pageIndex: [annotation, ...] }
  selectedAnnotation: null, // Currently selected annotation: { pageIndex, index } or null
  pendingTextPosition: null, // Where text will be placed on next confirm: { x, y } or null

  // --- Undo/redo (two separate stacks: page ops vs annotations) ---
  undoStack: [],          // Page operation history (reorder, delete, rotate)
  redoStack: [],          // Page operation redo
  editUndoStack: [],      // Annotation edit history (add, move, delete annotations)
  editRedoStack: [],      // Annotation edit redo

  // --- Rendering ---
  pageScales: {},         // Per-page scale info: { pageIndex: { canvasWidth, canvasHeight, pdfWidth, pdfHeight, scale } }
  devicePixelRatio: 1,    // Window.devicePixelRatio at render time
  eventsSetup: false,     // Guard: true after event delegation is attached to container
  pageCanvases: [],       // Per-page DOM: [{ slot: HTMLElement, canvas: HTMLCanvasElement, rendered: bool }]
  pageCaches: {},         // Per-page cached renders: { pageIndex: ImageData } for smooth annotation redraw
  pageObserver: null,     // IntersectionObserver instance for lazy page rendering
  scrollSyncEnabled: true, // false during programmatic scrollIntoView to prevent feedback loop
  zoomLevel: 1.0,         // Current zoom multiplier (1.0 = fit width)

  // --- Signature placement ---
  pendingSignature: false,  // true when signature image is "attached to cursor" awaiting click
  signaturePreviewPos: null, // Cursor position for ghost preview: { x, y } or null
  resizeHandle: null,       // Which corner handle is being dragged: 'tl' | 'tr' | 'bl' | 'br' | null
  resizeStartInfo: null,    // Snapshot of annotation state when resize began

  // --- Touch & drag interaction ---
  isDragging: false,        // true while an annotation is being dragged (shared with pinch-to-zoom)
  isResizing: false,        // true while an annotation is being resized
  sidebarDropIndicator: null, // DOM element for sidebar drag-drop indicator

  // --- UX ---
  lastLockedToastAnnotation: null, // Tracks last signature that showed "locked" toast (prevents spam)

  // --- Guards ---
  isRestoring: false,             // true during undo/redo page restoration (blocks scroll sync, new undo/redo)
};

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
