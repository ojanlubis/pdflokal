/*
 * ============================================================
 * PDFLokal - app.js
 * Core Application Logic & State Management
 * ============================================================
 *
 * PURPOSE:
 *   Bootstrap file. Manages global state, initialization, navigation,
 *   file handling, utility functions, keyboard shortcuts, and mobile UI
 *   for the unified editor.
 *
 * GLOBAL STATE DEFINED HERE:
 *   - state {}           — Shared mutable state for all tools
 *   - mobileState {}     — Device detection results (read-only by other files)
 *   - navHistory {}      — Browser back-button navigation tracking
 *
 * FUNCTIONS EXPORTED (called by other files):
 *   showToast(), showFullscreenLoading(), hideFullscreenLoading(),
 *   formatFileSize(), downloadBlob(), getDownloadFilename(),
 *   getOutputFilename(), checkFileSize(), loadImage(), escapeHtml(),
 *   cleanupImage(), convertImageToPdf(), pushModalState(),
 *   pushWorkspaceState(), closeAllModals(), showHome(), showTool(),
 *   sleep(), debounce(), openShortcutsModal(), closeShortcutsModal()
 *
 * FUNCTIONS IMPORTED (defined in other files):
 *   From unified-editor.js:
 *     ueAddFiles(), initUnifiedEditor(), ueReset(), ueSelectPage(),
 *     ueDownload(), ueUndoAnnotation(), ueRedoAnnotation(),
 *     ueRotateCurrentPage(), ueSetTool(), ueRedrawAnnotations(),
 *     uePmOpenModal(), uePmCloseModal(), uePmToggleExtractMode()
 *   From unified-editor.js (state):
 *     ueState, uePmState
 *   From pdf-tools.js:
 *     loadSignatureImage()
 *   From changelog.js:
 *     window.changelogAPI (hide, restore)
 *
 * LOAD ORDER: Must load AFTER changelog.js, BEFORE pdf-tools.js
 * ============================================================
 */

// ============================================================
// GLOBAL STATE
// ============================================================

const state = {
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

const MAX_FILE_SIZE_WARNING = 20 * 1024 * 1024; // 20MB - show warning
const MAX_FILE_SIZE_LIMIT = 100 * 1024 * 1024;  // 100MB - hard limit

// formatFileSize() is defined once in the UTILITY FUNCTIONS section (~line 1135)

function checkFileSize(file) {
  if (file.size > MAX_FILE_SIZE_LIMIT) {
    showToast(`File "${file.name}" terlalu besar (${formatFileSize(file.size)}). Maksimal 100MB.`, 'error');
    return false;
  }
  if (file.size > MAX_FILE_SIZE_WARNING) {
    showToast(`File "${file.name}" berukuran ${formatFileSize(file.size)}. File besar mungkin memerlukan waktu lebih lama untuk diproses.`, 'info');
  }
  return true;
}

// ============================================================
// BROWSER COMPATIBILITY CHECK
// ============================================================

function checkBrowserCompatibility() {
  const required = [
    { feature: 'Promise', check: typeof Promise !== 'undefined' },
    { feature: 'Blob', check: typeof Blob !== 'undefined' },
    { feature: 'Canvas', check: !!document.createElement('canvas').getContext },
    { feature: 'fetch', check: typeof fetch !== 'undefined' },
    { feature: 'FileReader', check: typeof FileReader !== 'undefined' }
  ];

  const missing = required.filter(r => !r.check);
  if (missing.length > 0) {
    showToast(`Browser tidak mendukung fitur: ${missing.map(m => m.feature).join(', ')}. Silakan gunakan browser modern.`, 'error');
    return false;
  }
  return true;
}

// ============================================================
// MOBILE STATE & DETECTION
// ============================================================

const mobileState = {
  isMobile: false,
  isTouch: false,
  orientation: 'portrait',
  viewportWidth: 0,
  viewportHeight: 0
};

function detectMobile() {
  mobileState.viewportWidth = window.innerWidth;
  mobileState.viewportHeight = window.innerHeight;
  mobileState.isMobile = window.innerWidth < 768;
  mobileState.isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  mobileState.orientation = window.innerHeight > window.innerWidth ? 'portrait' : 'landscape';

  // Update body classes for CSS targeting
  document.body.classList.toggle('is-mobile', mobileState.isMobile);
  document.body.classList.toggle('is-touch', mobileState.isTouch);
  document.body.classList.toggle('is-landscape', mobileState.orientation === 'landscape');

  // Update dropzone text for mobile/touch devices
  const dropzoneText = document.querySelector('#main-dropzone h3');
  const dropzoneSubtext = document.querySelector('#main-dropzone p');
  const mainFileInput = document.getElementById('file-input');

  if (dropzoneText) {
    if (mobileState.isMobile || mobileState.isTouch) {
      dropzoneText.textContent = 'Ketuk, lalu pilih Foto/Media untuk browse file PDF';
    } else {
      dropzoneText.textContent = 'Seret file ke sini atau klik untuk pilih';
    }
  }

  // Mobile: PDF only on main dropzone
  if (mobileState.isMobile) {
    if (mainFileInput) {
      mainFileInput.accept = '.pdf,application/pdf';
    }
    if (dropzoneSubtext) {
      dropzoneSubtext.textContent = 'PDF';
    }
  } else {
    if (mainFileInput) {
      mainFileInput.accept = '.pdf,image/*,application/pdf';
    }
    if (dropzoneSubtext) {
      dropzoneSubtext.textContent = 'PDF or Image';
    }
  }
}

// Debounce helper for resize events
function debounce(fn, delay) {
  let timeoutId;
  return function(...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(this, args), delay);
  };
}

// ============================================================
// NAVIGATION HISTORY MANAGEMENT
// ============================================================

const navHistory = {
  currentView: 'home',      // 'home', 'workspace', 'modal'
  currentWorkspace: null,   // Current tool name when in workspace
  currentModal: null        // Current modal id when modal is open
};

// Push state when entering workspace
function pushWorkspaceState(tool) {
  history.pushState({ view: 'workspace', tool }, '', `#${tool}`);
  navHistory.currentView = 'workspace';
  navHistory.currentWorkspace = tool;
  navHistory.currentModal = null;
}

// Push state when opening modal
function pushModalState(modalId) {
  history.pushState({
    view: 'modal',
    modal: modalId,
    tool: navHistory.currentWorkspace
  }, '', null);
  navHistory.currentView = 'modal';
  navHistory.currentModal = modalId;
}

// Close all modals
function closeAllModals() {
  // Close signature modal
  const sigModal = document.getElementById('signature-modal');
  if (sigModal?.classList.contains('active')) {
    sigModal.classList.remove('active');
  }

  // Close signature background modal
  const sigBgModal = document.getElementById('signature-bg-modal');
  if (sigBgModal?.classList.contains('active')) {
    sigBgModal.classList.remove('active');
  }

  // Close text modal
  const textModal = document.getElementById('text-input-modal');
  if (textModal?.classList.contains('active')) {
    textModal.classList.remove('active');
  }

  // Close page manager modal
  const pmModal = document.getElementById('ue-gabungkan-modal');
  if (pmModal?.classList.contains('active')) {
    if (typeof uePmCloseModal === 'function') {
      uePmCloseModal(true); // true = skip history manipulation
    }
  }

  // Close watermark modal
  const wmModal = document.getElementById('editor-watermark-modal');
  if (wmModal?.classList.contains('active')) {
    wmModal.classList.remove('active');
  }

  // Close page number modal
  const pnModal = document.getElementById('editor-pagenum-modal');
  if (pnModal?.classList.contains('active')) {
    pnModal.classList.remove('active');
  }

  // Close protect modal
  const protectModal = document.getElementById('editor-protect-modal');
  if (protectModal?.classList.contains('active')) {
    protectModal.classList.remove('active');
  }

  navHistory.currentModal = null;
}

// Handle browser back button
function initNavigationHistory() {
  // Set initial state
  history.replaceState({ view: 'home' }, '', window.location.pathname);

  window.addEventListener('popstate', (event) => {
    if (event.state) {
      if (event.state.view === 'workspace') {
        // Close any open modal, stay in workspace
        closeAllModals();
        navHistory.currentView = 'workspace';
        navHistory.currentModal = null;
      } else if (event.state.view === 'home') {
        // Go back to home
        closeAllModals();
        showHome(true); // true = skip pushState
      }
    } else {
      // No state = we're at home or initial load
      closeAllModals();
      showHome(true);
    }
  });
}

// ============================================================
// INITIALIZATION
// ============================================================

function initApp() {
  // Check browser compatibility first
  checkBrowserCompatibility();

  // Initialize mobile detection first
  detectMobile();

  // Listen for resize and orientation changes
  window.addEventListener('resize', debounce(detectMobile, 150));
  window.addEventListener('orientationchange', () => {
    setTimeout(detectMobile, 100);
  });

  // Initialize theme system
  if (window.themeAPI) {
    window.themeAPI.init();
  }

  initDropZone();
  initToolCards();
  initFileInputs();
  initRangeSliders();
  initSignaturePad();
  initNavigationHistory();
}

// Initialize when DOM is ready (same pattern as changelog.js)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

// USER FLOW: Homepage dropzone
// User drops/selects file → handleDroppedFiles() → detects type →
//   PDF: showTool('unified-editor') → ueAddFiles() [unified-editor.js]
//   Images (multiple): showTool('img-to-pdf') → addImagesToPDF() [image-tools.js]
//   Image (single): showTool('compress-img') → loadImage() [app.js]
function initDropZone() {
  const dropzone = document.getElementById('main-dropzone');
  const fileInput = document.getElementById('file-input');

  dropzone.addEventListener('click', () => fileInput.click());
  
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('drag-over');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('drag-over');
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    handleDroppedFiles(e.dataTransfer.files);
  });

  fileInput.addEventListener('change', async (e) => {
    await handleDroppedFiles(e.target.files);
    e.target.value = '';
  });
}

// USER FLOW: Homepage tool cards
// User clicks card → reads data-tool attribute →
//   'merge-pdf': handleEditorCardWithFilePicker('merge') → file picker → unified editor + Gabungkan modal
//   'split-pdf': handleEditorCardWithFilePicker('split') → file picker → unified editor + Gabungkan modal + extract mode
//   anything else: showTool(tool) → hides home, shows workspace
function initToolCards() {
  document.querySelectorAll('.tool-card:not(.disabled)').forEach(card => {
    card.addEventListener('click', () => {
      const tool = card.dataset.tool;

      // Handle merge-pdf and split-pdf separately (don't call showTool)
      if (tool === 'merge-pdf') {
        handleEditorCardWithFilePicker('merge');
        return;
      }
      if (tool === 'split-pdf') {
        handleEditorCardWithFilePicker('split');
        return;
      }

      showTool(tool);
    });
  });
}

// USER FLOW: Merge/Split PDF cards (bypasses showTool — keeps home visible during file picking)
// 1. Creates hidden file input → triggers file picker
// 2. On file selection: showFullscreenLoading → initUnifiedEditor → ueAddFiles → hide home → show editor
// 3. Opens Gabungkan modal. If split: also enables extract mode after 100ms delay.
// mode: 'merge' | 'split'
function handleEditorCardWithFilePicker(mode) {
  const inputId = mode + '-pdf-input';
  let input = document.getElementById(inputId);
  if (!input) {
    input = document.createElement('input');
    input.type = 'file';
    input.id = inputId;
    input.multiple = true;
    input.accept = '.pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*';
    input.style.display = 'none';
    document.body.appendChild(input);

    input.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        // Convert FileList to Array before resetting input
        const filesArray = Array.from(e.target.files);
        // Reset input immediately so same files can be selected again
        input.value = '';

        // Show loading overlay (home-view stays visible behind it)
        showFullscreenLoading('Memuat PDF...');

        try {
          // Initialize unified editor in background
          const workspace = document.getElementById('unified-editor-workspace');
          if (workspace) {
            initUnifiedEditor(); // → unified-editor.js

            // Load the files into unified editor
            await ueAddFiles(filesArray); // → unified-editor.js

            // Now hide home-view and show editor
            document.getElementById('home-view').style.display = 'none';
            workspace.classList.add('active');
            state.currentTool = 'unified-editor';
            window.scrollTo(0, 0);
            pushWorkspaceState('unified-editor');

            // Initialize mobile enhancements
            if (mobileState.isMobile || mobileState.isTouch) {
              initMobileEditorEnhancements();
              ueMobileUpdatePageIndicator();
            }

            // Open the Gabungkan modal
            uePmOpenModal(); // → unified-editor.js

            setTimeout(() => {
              // Enable split/extract mode when opened from Split card
              if (mode === 'split' && !uePmState.extractMode) {
                uePmToggleExtractMode(); // → unified-editor.js
              }
              hideFullscreenLoading();
            }, 100);
          }
        } catch (error) {
          console.error('Error loading PDFs:', error);
          hideFullscreenLoading();
          showToast('Gagal memuat PDF', 'error');
        }
      }
    });
  }
  // Trigger file selection
  input.click();
}

function initFileInputs() {
  // Image to PDF input
  const imgPdfInput = document.getElementById('img-pdf-input');
  if (imgPdfInput) {
    imgPdfInput.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        showFullscreenLoading('Memuat gambar...');
        try {
          await addImagesToPDF(e.target.files);
        } catch (error) {
          console.error('Error loading images:', error);
          showToast('Gagal memuat gambar', 'error');
        } finally {
          hideFullscreenLoading();
          e.target.value = '';
        }
      }
    });
  }

  // Compress PDF input
  const compressPdfInput = document.getElementById('compress-pdf-input');
  if (compressPdfInput) {
    compressPdfInput.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        showFullscreenLoading('Memuat PDF...');
        try {
          await loadPDFForTool(e.target.files[0], 'compress-pdf');
        } catch (error) {
          console.error('Error loading PDF:', error);
          showToast('Gagal memuat PDF', 'error');
        } finally {
          hideFullscreenLoading();
          e.target.value = '';
        }
      }
    });
  }

  // PDF to Image input
  const pdfImgInput = document.getElementById('pdf-img-input');
  if (pdfImgInput) {
    pdfImgInput.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        showFullscreenLoading('Memuat PDF...');
        try {
          await loadPDFForTool(e.target.files[0], 'pdf-to-img');
        } catch (error) {
          console.error('Error loading PDF:', error);
          showToast('Gagal memuat PDF', 'error');
        } finally {
          hideFullscreenLoading();
          e.target.value = '';
        }
      }
    });
  }

  // Protect PDF input
  const protectInput = document.getElementById('protect-input');
  if (protectInput) {
    protectInput.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        showFullscreenLoading('Memuat PDF...');
        try {
          await loadPDFForTool(e.target.files[0], 'protect');
        } catch (error) {
          console.error('Error loading PDF:', error);
          showToast('Gagal memuat PDF', 'error');
        } finally {
          hideFullscreenLoading();
          e.target.value = '';
        }
      }
    });
  }

  // Compress Image input
  const compressImgInput = document.getElementById('compress-img-input');
  if (compressImgInput) {
    compressImgInput.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        showFullscreenLoading('Memuat gambar...');
        try {
          await loadImageForTool(e.target.files[0], 'compress-img');
        } catch (error) {
          console.error('Error loading image:', error);
          showToast('Gagal memuat gambar', 'error');
        } finally {
          hideFullscreenLoading();
          e.target.value = '';
        }
      }
    });
  }

  // Resize Image input
  const resizeInput = document.getElementById('resize-input');
  if (resizeInput) {
    resizeInput.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        showFullscreenLoading('Memuat gambar...');
        try {
          await loadImageForTool(e.target.files[0], 'resize');
        } catch (error) {
          console.error('Error loading image:', error);
          showToast('Gagal memuat gambar', 'error');
        } finally {
          hideFullscreenLoading();
          e.target.value = '';
        }
      }
    });
  }

  // Convert Image input
  const convertInput = document.getElementById('convert-input');
  if (convertInput) {
    convertInput.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        showFullscreenLoading('Memuat gambar...');
        try {
          await loadImageForTool(e.target.files[0], 'convert-img');
        } catch (error) {
          console.error('Error loading image:', error);
          showToast('Gagal memuat gambar', 'error');
        } finally {
          hideFullscreenLoading();
          e.target.value = '';
        }
      }
    });
  }

  // Remove Background input
  const removeBgInput = document.getElementById('remove-bg-input');
  if (removeBgInput) {
    removeBgInput.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        showFullscreenLoading('Memuat gambar...');
        try {
          await loadImageForTool(e.target.files[0], 'remove-bg');
        } catch (error) {
          console.error('Error loading image:', error);
          showToast('Gagal memuat gambar', 'error');
        } finally {
          hideFullscreenLoading();
          e.target.value = '';
        }
      }
    });
  }

  // Signature Upload input
  const sigUploadInput = document.getElementById('signature-upload-input');
  if (sigUploadInput) {
    sigUploadInput.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        showFullscreenLoading('Memuat tanda tangan...');
        try {
          await loadSignatureImage(e.target.files[0]); // → pdf-tools.js
        } catch (error) {
          showToast('Gagal memuat tanda tangan', 'error');
        } finally {
          hideFullscreenLoading();
          e.target.value = '';
        }
      }
    });
  }

  // Initialize drop hint drag-over effects
  initDropHints();
}

function initDropHints() {
  // Handle both old .drop-hint class and new .dropzone class in workspaces
  // Exclude main-dropzone which has its own handler in initDropZone()
  document.querySelectorAll('.drop-hint, .workspace .dropzone, .preview-area .dropzone, .page-grid .dropzone, .file-list .dropzone').forEach(hint => {
    // Skip the main homepage dropzone
    if (hint.id === 'main-dropzone') return;

    hint.addEventListener('dragover', (e) => {
      e.preventDefault();
      hint.classList.add('drag-over');
    });
    hint.addEventListener('dragleave', () => {
      hint.classList.remove('drag-over');
    });
    hint.addEventListener('drop', (e) => {
      e.preventDefault();
      hint.classList.remove('drag-over');
      // The workspace drop handler will handle the actual file processing
    });
  });
}

function initRangeSliders() {
  document.querySelectorAll('.range-slider input[type="range"]').forEach(slider => {
    const valueSpan = slider.parentElement.querySelector('.range-value');
    slider.addEventListener('input', () => {
      valueSpan.textContent = slider.value + '%';
    });
  });
}

function initSignaturePad() {
  const canvas = document.getElementById('signature-canvas');
  if (canvas && typeof SignaturePad !== 'undefined') {
    state.signaturePad = new SignaturePad(canvas, {
      backgroundColor: 'rgb(255, 255, 255)',
      penColor: 'rgb(0, 0, 0)'
    });
    
    // Resize canvas
    function resizeCanvas() {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      canvas.width = canvas.offsetWidth * ratio;
      canvas.height = canvas.offsetHeight * ratio;
      canvas.getContext('2d').scale(ratio, ratio);
      state.signaturePad.clear();
    }
    
    window.addEventListener('resize', resizeCanvas);
    setTimeout(resizeCanvas, 100);
  }
}

// ============================================================
// FILE HANDLING
// ============================================================

async function handleDroppedFiles(files) {
  if (!files || files.length === 0) return;

  const file = files[0];

  // Check file size
  if (!checkFileSize(file)) return;

  const isPDF = file.type === 'application/pdf';
  const isImage = file.type.startsWith('image/');

  if (!isPDF && !isImage) {
    showToast('File tidak didukung. Gunakan PDF, JPG, PNG, atau WebP.', 'error');
    return;
  }

  // Mobile: reject images on main dropzone (only allow PDF)
  if (mobileState.isMobile && isImage && !isPDF) {
    showToast('Di perangkat mobile, gunakan tool khusus gambar untuk memproses gambar.', 'info');
    return;
  }

  // Show loading state
  showFullscreenLoading(isPDF ? 'Memuat PDF...' : 'Memuat gambar...');

  try {
    // If no tool is selected, suggest based on file type
    if (!state.currentTool) {
      if (isPDF) {
        // Default to Unified Editor for all PDF operations
        showTool('unified-editor');
        await ueAddFiles(files); // → unified-editor.js
      } else if (isImage && files.length > 1) {
        showTool('img-to-pdf');
        await addImagesToPDF(files); // → image-tools.js
      } else if (isImage) {
        showTool('compress-img');
        await loadImageForTool(file, 'compress-img');
      }
    }
  } catch (error) {
    console.error('Error loading file:', error);
    showToast('Gagal memuat file', 'error');
  } finally {
    hideFullscreenLoading();
  }
}

async function loadPDFForTool(file, tool) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    state.currentPDFBytes = new Uint8Array(arrayBuffer);
    state.currentPDFName = file.name;
    
    // Load with PDF.js for rendering
    state.currentPDF = await pdfjsLib.getDocument({ data: state.currentPDFBytes.slice() }).promise;
    
    // Initialize tool-specific views
    switch (tool) {
      case 'pdf-to-img':
        await renderPdfImgPages();
        document.getElementById('pdf-img-btn').disabled = false;
        break;
      case 'compress-pdf':
        await showPDFPreview('compress-pdf-preview');
        document.getElementById('compress-pdf-btn').disabled = false;
        break;
      case 'protect':
        await showPDFPreview('protect-preview');
        document.getElementById('protect-btn').disabled = false;
        break;
    }
  } catch (error) {
    console.error('Error loading PDF:', error);
    // Provide more specific error messages
    const errorMsg = error.message || '';
    if (errorMsg.includes('password') || errorMsg.includes('encrypted')) {
      showToast('PDF ini dilindungi password. File tidak dapat dibuka tanpa password.', 'error');
    } else if (errorMsg.includes('Invalid') || errorMsg.includes('corrupt')) {
      showToast('File PDF rusak atau tidak valid. Coba file lain.', 'error');
    } else {
      showToast('Gagal memuat PDF. File mungkin rusak atau terenkripsi.', 'error');
    }
  }
}

async function loadImageForTool(file, tool) {
  try {
    state.originalImage = await loadImage(file);
    state.originalImageName = file.name;

    switch (tool) {
      case 'compress-img':
        // Hide drop hint, show comparison
        const compressHint = document.getElementById('compress-img-hint');
        const compressComparison = document.getElementById('compress-img-comparison');
        if (compressHint) compressHint.classList.add('hidden');
        if (compressComparison) compressComparison.classList.remove('hidden');

        document.getElementById('compress-original').src = state.originalImage.src;
        document.getElementById('compress-original-size').textContent = `Original: ${formatFileSize(file.size)}`;
        state.originalImageSize = file.size;
        updateCompressPreview();
        document.getElementById('compress-img-btn').disabled = false;
        break;
      case 'resize':
        // Hide drop hint, show preview
        const resizeHint = document.getElementById('resize-hint');
        const resizePreviewBox = document.getElementById('resize-preview-box');
        if (resizeHint) resizeHint.classList.add('hidden');
        if (resizePreviewBox) resizePreviewBox.classList.remove('hidden');

        document.getElementById('resize-preview').src = state.originalImage.src;
        document.getElementById('resize-width').value = state.originalImage.naturalWidth;
        document.getElementById('resize-height').value = state.originalImage.naturalHeight;
        state.originalWidth = state.originalImage.naturalWidth;
        state.originalHeight = state.originalImage.naturalHeight;
        document.getElementById('resize-dimensions').textContent = `Dimensi: ${state.originalWidth} × ${state.originalHeight}`;
        document.getElementById('resize-btn').disabled = false;
        break;
      case 'convert-img':
        // Hide drop hint, show preview
        const convertHint = document.getElementById('convert-hint');
        const convertPreviewBox = document.getElementById('convert-preview-box');
        if (convertHint) convertHint.classList.add('hidden');
        if (convertPreviewBox) convertPreviewBox.classList.remove('hidden');

        document.getElementById('convert-preview').src = state.originalImage.src;
        const ext = file.name.split('.').pop().toLowerCase();
        document.getElementById('convert-info').textContent = `Format saat ini: ${ext.toUpperCase()}`;
        document.getElementById('convert-btn').disabled = false;
        break;
      case 'remove-bg':
        // Hide drop hint, show comparison
        const removeBgHint = document.getElementById('remove-bg-hint');
        const removeBgComparison = document.getElementById('remove-bg-comparison');
        if (removeBgHint) removeBgHint.classList.add('hidden');
        if (removeBgComparison) removeBgComparison.classList.remove('hidden');

        document.getElementById('remove-bg-original').src = state.originalImage.src;
        updateRemoveBgPreview();
        document.getElementById('remove-bg-btn').disabled = false;
        break;
    }
  } catch (error) {
    console.error('Error loading image:', error);
    showToast('Gagal memuat gambar.', 'error');
  }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const blobUrl = URL.createObjectURL(file);
    img.onload = () => {
      // Store the blob URL on the image for later cleanup
      img._blobUrl = blobUrl;
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(blobUrl);
      reject(new Error('Failed to load image'));
    };
    img.src = blobUrl;
  });
}

/**
 * Convert image file to single-page PDF
 * @param {File} imageFile - Image file to convert
 * @returns {Promise<Uint8Array>} PDF bytes
 */
async function convertImageToPdf(imageFile) {
  try {
    // Load image to get dimensions
    const img = await loadImage(imageFile);

    // Create new PDF document
    const pdfDoc = await PDFLib.PDFDocument.create();

    // Read image bytes
    const arrayBuffer = await imageFile.arrayBuffer();
    const imgBytes = new Uint8Array(arrayBuffer);

    // Embed image based on MIME type
    let embeddedImage;
    const mimeType = imageFile.type.toLowerCase();

    if (mimeType === 'image/png') {
      embeddedImage = await pdfDoc.embedPng(imgBytes);
    } else if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
      embeddedImage = await pdfDoc.embedJpg(imgBytes);
    } else {
      // Convert other formats (WebP, GIF, etc.) to PNG via Canvas
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);

      const pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
      embeddedImage = await pdfDoc.embedPng(pngBytes);
    }

    // Create page matching image dimensions exactly
    const page = pdfDoc.addPage([embeddedImage.width, embeddedImage.height]);

    // Draw image to fill entire page
    page.drawImage(embeddedImage, {
      x: 0,
      y: 0,
      width: embeddedImage.width,
      height: embeddedImage.height
    });

    // Clean up blob URL
    if (img._blobUrl) {
      URL.revokeObjectURL(img._blobUrl);
    }

    // Return PDF bytes
    return await pdfDoc.save();

  } catch (error) {
    console.error('Image conversion failed:', error);
    throw new Error(`Gagal mengonversi ${imageFile.name}. Format tidak didukung.`);
  }
}

// Helper function to escape HTML and prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Helper function to revoke blob URL from an image
function cleanupImage(img) {
  if (img && img._blobUrl) {
    URL.revokeObjectURL(img._blobUrl);
    img._blobUrl = null;
  }
}

// ============================================================
// NAVIGATION
// ============================================================

// Navigate back to homepage. Hides all workspaces, closes modals, resets tool state, cleans up blobs.
function showHome(skipPushState = false) {
  document.getElementById('home-view').style.display = 'block';
  document.querySelectorAll('.workspace').forEach(ws => ws.classList.remove('active'));
  closeAllModals();
  state.currentTool = null;
  resetState();

  // Restore changelog badge when returning to home
  if (window.changelogAPI) {
    window.changelogAPI.restore();
  }

  // Update navigation history
  if (!skipPushState) {
    history.pushState({ view: 'home' }, '', '#');
  }
  navHistory.currentView = 'home';
  navHistory.currentWorkspace = null;
  navHistory.currentModal = null;
}

// Navigate to a workspace. Hides home, shows the workspace matching data-tool attribute.
// For unified-editor: also calls initUnifiedEditor(). Sets up workspace drop zones on first visit.
function showTool(tool, skipPushState = false) {
  // Hide changelog when leaving home-view
  if (window.changelogAPI) {
    window.changelogAPI.hide();
  }

  document.getElementById('home-view').style.display = 'none';
  document.querySelectorAll('.workspace').forEach(ws => ws.classList.remove('active'));

  const workspace = document.getElementById(`${tool}-workspace`);
  if (workspace) {
    workspace.classList.add('active');
    state.currentTool = tool;

    // Scroll to top when opening workspace
    window.scrollTo(0, 0);

    // Push browser history state
    if (!skipPushState) {
      pushWorkspaceState(tool);
    }

    // Setup drop zones for workspaces
    setupWorkspaceDropZone(tool);

    // Initialize unified editor when opened
    if (tool === 'unified-editor') {
      initUnifiedEditor();

      // Initialize mobile enhancements
      if (mobileState.isMobile || mobileState.isTouch) {
        setTimeout(() => {
          initMobileEditorEnhancements();
          ueMobileUpdatePageIndicator();
        }, 100);
      }
    }
  }
}

function setupWorkspaceDropZone(tool) {
  // Prevent duplicate event listeners
  if (state.workspaceDropZonesSetup.has(tool)) {
    return;
  }

  const workspace = document.getElementById(`${tool}-workspace`);
  if (!workspace) return;

  state.workspaceDropZonesSetup.add(tool);

  workspace.addEventListener('dragover', (e) => {
    e.preventDefault();
  });

  workspace.addEventListener('drop', async (e) => {
    e.preventDefault();
    const files = e.dataTransfer.files;

    if (files.length === 0) return;

    // Determine loading message based on file type
    const isPDF = files[0].type === 'application/pdf';
    const loadingMessage = isPDF ? 'Memuat PDF...' : 'Memuat gambar...';

    showFullscreenLoading(loadingMessage);
    try {
      if (tool === 'merge') {
        await addMergeFiles(files);
      } else if (tool === 'img-to-pdf') {
        await addImagesToPDF(files);
      } else if (files.length === 1) {
        const file = files[0];
        if (file.type === 'application/pdf') {
          await loadPDFForTool(file, tool);
        } else if (file.type.startsWith('image/')) {
          await loadImageForTool(file, tool);
        }
      }
    } catch (error) {
      console.error('Error handling dropped files:', error);
      showToast('Gagal memuat file', 'error');
    } finally {
      hideFullscreenLoading();
    }
  });
}

function resetState() {
  state.currentPDF = null;
  state.currentPDFBytes = null;
  state.currentImages = [];
  state.mergeFiles = [];
  state.splitPages = [];
  state.rotatePages = [];
  state.pagesOrder = [];
  state.editAnnotations = {};
  state.currentEditPage = 0;

  // Cleanup original image blob URL
  cleanupImage(state.originalImage);
  state.originalImage = null;
  state.originalImageName = null;
  state.originalImageSize = 0;
  state.originalWidth = 0;
  state.originalHeight = 0;

  // Cleanup images to PDF
  state.imgToPdfFiles.forEach(item => cleanupImage(item.img));
  state.imgToPdfFiles = [];

  // Reset other state
  state.pdfImgPages = [];
  state.compressedBlob = null;
  state.cropRect = null;
  state.currentCropPage = 0;
  state.currentEditTool = null;
  state.signatureImage = null;

  // Cleanup compress preview URL
  if (state.compressPreviewUrl) {
    URL.revokeObjectURL(state.compressPreviewUrl);
    state.compressPreviewUrl = null;
  }

  // Reset canvas setup flags so they can be re-initialized
  state.editCanvasSetup = false;

  // Reset Page Manager state
  state.pmPages = [];
  state.pmSourceFiles = [];

  // Reset Unified Editor state
  if (typeof ueReset === 'function') {
    ueReset(); // → unified-editor.js
  }
}

// ============================================================
// UTILITY FUNCTIONS
// ============================================================

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Generate output filename: [original]_[suffix].ext
function getOutputFilename(suffix, ext = 'pdf', originalName = null) {
  const baseName = originalName || state.currentPDFName || state.originalImageName || 'output';
  // Remove extension from base name
  const nameWithoutExt = baseName.replace(/\.[^/.]+$/, '');
  return `${nameWithoutExt}_${suffix}.${ext}`;
}

/**
 * Constructs download filename with _pdflokal.id suffix
 * @param {Object} options - Configuration object
 * @param {string} options.originalName - Original uploaded filename (with or without extension)
 * @param {string} [options.suffix] - Optional descriptive suffix (e.g., 'page1', 'page2')
 * @param {string} options.extension - Output file extension (pdf, png, jpg, etc.)
 * @returns {string} Formatted filename: {basename}[_suffix]_pdflokal.id.{extension}
 */
function getDownloadFilename(options) {
  const { originalName, suffix = '', extension } = options;

  // Handle missing original name (fallback to 'output')
  if (!originalName) {
    const filename = suffix
      ? `output_${suffix}_pdflokal.id.${extension}`
      : `output_pdflokal.id.${extension}`;
    return filename;
  }

  // Remove extension from original name
  const baseName = originalName.replace(/\.[^/.]+$/, '');

  // Build: {basename}[_suffix]_pdflokal.id.{extension}
  const filename = suffix
    ? `${baseName}_${suffix}_pdflokal.id.${extension}`
    : `${baseName}_pdflokal.id.${extension}`;

  return filename;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    ${type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ'}
    <span>${message}</span>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s ease reverse';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// Full-screen loading overlay for merge/split operations
function showFullscreenLoading(message = 'Memuat PDF...') {
  let overlay = document.getElementById('fullscreen-loading-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'fullscreen-loading-overlay';
    overlay.innerHTML = `
      <div class="fullscreen-loading-content">
        <div class="fullscreen-loading-spinner"></div>
        <p class="fullscreen-loading-text">${message}</p>
      </div>
    `;
    document.body.appendChild(overlay);
  } else {
    overlay.querySelector('.fullscreen-loading-text').textContent = message;
    overlay.style.display = 'flex';
  }
}

function hideFullscreenLoading() {
  const overlay = document.getElementById('fullscreen-loading-overlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
}


// ============================================================
// KEYBOARD SHORTCUTS
// ============================================================

document.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();

  // Skip if user is typing in an input field
  const activeEl = document.activeElement;
  const isTyping = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable);

  // Escape - close modals or go back home
  if (e.key === 'Escape') {
    // Check if any modal is open first
    const shortcutsModal = document.getElementById('shortcuts-modal');
    if (shortcutsModal && shortcutsModal.classList.contains('active')) {
      closeShortcutsModal();
      return;
    }
    if (state.currentTool) {
      showHome();
    }
  }

  // Ctrl+S / Cmd+S - Download PDF in unified editor
  if ((e.ctrlKey || e.metaKey) && key === 's') {
    e.preventDefault();
    if (state.currentTool === 'unified-editor' && ueState.pages.length > 0) {
      ueDownload(); // → unified-editor.js
    }
  }

  // Ctrl+Z for undo in unified editor
  if (key === 'z' && (e.ctrlKey || e.metaKey) && state.currentTool === 'unified-editor') {
    e.preventDefault();
    ueUndoAnnotation(); // → unified-editor.js
  }

  // Ctrl+Y for redo in unified editor
  if (key === 'y' && (e.ctrlKey || e.metaKey) && state.currentTool === 'unified-editor') {
    e.preventDefault();
    ueRedoAnnotation(); // → unified-editor.js
  }

  // Keyboard shortcuts for unified editor tools (only when not typing)
  if (state.currentTool === 'unified-editor' && !isTyping) {
    // Tool shortcuts (require a page to be selected)
    if (ueState.selectedPage >= 0) {
      if (key === 'v' && !e.ctrlKey && !e.metaKey) {
        ueSetTool('select');
      } else if (key === 'w' && !e.ctrlKey && !e.metaKey) {
        ueSetTool('whiteout');
      } else if (key === 't' && !e.ctrlKey && !e.metaKey) {
        ueSetTool('text');
      } else if (key === 's' && !e.ctrlKey && !e.metaKey) {
        ueOpenSignatureModal();
      } else if (key === 'r' && !e.ctrlKey && !e.metaKey) {
        ueRotateCurrentPage();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (ueState.selectedAnnotation) {
          e.preventDefault();
          ueSaveEditUndoState();
          ueState.annotations[ueState.selectedAnnotation.pageIndex].splice(ueState.selectedAnnotation.index, 1);
          ueState.selectedAnnotation = null;
          ueRedrawAnnotations();
        }
      }
    }

    // Arrow key navigation
    if (e.key === 'ArrowLeft' && ueState.selectedPage > 0) {
      e.preventDefault();
      ueSelectPage(ueState.selectedPage - 1);
    } else if (e.key === 'ArrowRight' && ueState.selectedPage < ueState.pages.length - 1) {
      e.preventDefault();
      ueSelectPage(ueState.selectedPage + 1);
    }

    // ? to show keyboard shortcuts help
    if (e.key === '?' || (e.shiftKey && key === '/')) {
      e.preventDefault();
      openShortcutsModal();
    }
  }
});

// ============================================================
// KEYBOARD SHORTCUTS MODAL
// ============================================================

function openShortcutsModal() {
  const modal = document.getElementById('shortcuts-modal');
  if (modal) {
    modal.classList.add('active');
  }
}

function closeShortcutsModal() {
  const modal = document.getElementById('shortcuts-modal');
  if (modal) {
    modal.classList.remove('active');
  }
}

// ============================================================
// HANDLE PASTE
// ============================================================

document.addEventListener('paste', async (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) {
        if (state.currentTool === 'img-to-pdf') {
          addImagesToPDF([file]);
        } else if (state.currentTool === 'compress-img' || state.currentTool === 'resize' || state.currentTool === 'convert-img' || state.currentTool === 'remove-bg') {
          loadImageForTool(file, state.currentTool);
        } else if (!state.currentTool) {
          showTool('compress-img');
          loadImageForTool(file, 'compress-img');
        }
      }
    }
  }
});

// ============================================================
// SERVICE WORKER (for offline support - optional)
// ============================================================

// Uncomment to enable offline support
/*
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js')
      .then(registration => {
        console.log('SW registered:', registration);
      })
      .catch(error => {
        console.log('SW registration failed:', error);
      });
  });
}
*/

// ============================================================
// FUTURE BACKEND FEATURES
// ============================================================
/*
 * The following features require server-side processing and cannot
 * be implemented purely in the browser:
 * 
 * 1. PDF to Word (.docx) conversion
 * 2. PDF to Excel (.xlsx) conversion
 * 3. Word/Excel/PowerPoint to PDF conversion
 * 4. OCR (Optical Character Recognition)
 * 
 * Implementation options when ready:
 * 
 * Option 1: Serverless Functions + LibreOffice
 *   - Deploy on AWS Lambda / Google Cloud Functions / Vercel
 *   - Use libreoffice-lambda: https://github.com/nickatnight/libreoffice-lambda
 *   - Pros: Pay per use, scales automatically
 *   - Cons: Cold start latency, 50MB limit on Lambda
 * 
 * Option 2: CloudConvert API
 *   - https://cloudconvert.com/api
 *   - Cost: ~$0.01-0.05 per conversion
 *   - Pros: Reliable, high quality, many formats
 *   - Cons: External dependency, cost per conversion
 * 
 * Option 3: Self-hosted LibreOffice
 *   - Docker container with LibreOffice headless
 *   - Use unoconv or LibreOffice CLI
 *   - Pros: No external costs, full control
 *   - Cons: Need to manage infrastructure
 * 
 * Option 4: Gotenberg
 *   - https://gotenberg.dev/
 *   - Docker-based conversion service
 *   - Pros: Easy to deploy, many formats
 *   - Cons: Need to manage infrastructure
 * 
 * Privacy considerations for server features:
 *   - Files should be deleted immediately after processing
 *   - Use HTTPS for all transfers
 *   - Consider client-side encryption before upload
 *   - Be transparent with users about data handling
 * 
 * When to implement: When MAU > 10K or donation revenue covers costs
 */

// ============================================================
// MOBILE NAVIGATION & UI FUNCTIONS
// ============================================================
//
// NOTE: These ueMobile*() functions live in app.js (not unified-editor.js)
// because they handle mobile UI chrome that WRAPS the editor — bottom bar,
// page picker overlay, tools dropdown, sign button. They read ueState from
// unified-editor.js and call ueSelectPage(), but they OWN the mobile-specific
// DOM elements (#ue-mobile-bottombar, #ue-mobile-page-picker, etc.).
//
// Functions: ueMobilePrevPage, ueMobileNextPage, ueMobileUpdatePageIndicator,
//            ueMobileOpenPagePicker, ueMobileClosePagePicker,
//            toggleMobileTools, closeMobileTools, ueMobileUpdateSignButton,
//            initMobileEditorEnhancements

/**
 * Navigate to previous page on mobile
 */
function ueMobilePrevPage() {
  if (ueState.selectedPage > 0) {
    ueSelectPage(ueState.selectedPage - 1);
    ueMobileUpdatePageIndicator();

    // Haptic feedback
    if (mobileState.isTouch && navigator.vibrate) {
      navigator.vibrate(10);
    }
  }
}

/**
 * Navigate to next page on mobile
 */
function ueMobileNextPage() {
  if (ueState.selectedPage < ueState.pages.length - 1) {
    ueSelectPage(ueState.selectedPage + 1);
    ueMobileUpdatePageIndicator();

    // Haptic feedback
    if (mobileState.isTouch && navigator.vibrate) {
      navigator.vibrate(10);
    }
  }
}

/**
 * Update the mobile page indicator display
 */
function ueMobileUpdatePageIndicator() {
  const indicator = document.getElementById('ue-mobile-page-indicator');
  const prevBtn = document.getElementById('ue-mobile-prev');
  const nextBtn = document.getElementById('ue-mobile-next');

  if (!indicator) return;

  const current = ueState.selectedPage + 1;
  const total = ueState.pages.length;

  indicator.innerHTML = `Halaman <strong>${current}</strong> / ${total}`;

  if (prevBtn) prevBtn.disabled = ueState.selectedPage <= 0;
  if (nextBtn) nextBtn.disabled = ueState.selectedPage >= ueState.pages.length - 1;
}

/**
 * Open the mobile page picker modal
 */
function ueMobileOpenPagePicker() {
  const picker = document.getElementById('ue-mobile-page-picker');
  const grid = document.getElementById('ue-mobile-page-grid');

  if (!picker || !grid || ueState.pages.length === 0) return;

  // Build thumbnail grid
  grid.innerHTML = '';
  ueState.pages.forEach((page, index) => {
    const thumb = document.createElement('div');
    thumb.className = 'mobile-page-thumb' + (index === ueState.selectedPage ? ' selected' : '');
    thumb.onclick = () => {
      ueSelectPage(index);
      ueMobileUpdatePageIndicator();
      ueMobileClosePagePicker();

      // Haptic feedback
      if (mobileState.isTouch && navigator.vibrate) {
        navigator.vibrate(10);
      }
    };

    // Clone thumbnail canvas
    if (page.canvas) {
      const thumbCanvas = document.createElement('canvas');
      const scale = 0.3; // Smaller scale for picker
      thumbCanvas.width = page.canvas.width * scale;
      thumbCanvas.height = page.canvas.height * scale;
      const ctx = thumbCanvas.getContext('2d');
      ctx.drawImage(page.canvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
      thumb.appendChild(thumbCanvas);
    }

    // Page number badge
    const num = document.createElement('span');
    num.className = 'mobile-page-thumb-number';
    num.textContent = index + 1;
    thumb.appendChild(num);

    grid.appendChild(thumb);
  });

  picker.classList.add('active');

  // Prevent body scroll
  document.body.style.overflow = 'hidden';
}

/**
 * Close the mobile page picker modal
 */
function ueMobileClosePagePicker() {
  const picker = document.getElementById('ue-mobile-page-picker');
  if (picker) {
    picker.classList.remove('active');
  }

  // Restore body scroll
  document.body.style.overflow = '';
}

/**
 * Toggle mobile tools dropdown
 */
function toggleMobileTools() {
  const dropdown = document.getElementById('mobile-tools-dropdown');
  if (dropdown) {
    dropdown.classList.toggle('active');
  }
}

/**
 * Close mobile tools dropdown
 */
function closeMobileTools() {
  const dropdown = document.getElementById('mobile-tools-dropdown');
  if (dropdown) {
    dropdown.classList.remove('active');
  }
}

/**
 * Update mobile sign button state (show checkmark when signature exists)
 */
function ueMobileUpdateSignButton() {
  const signBtn = document.getElementById('ue-mobile-sign-btn');
  if (!signBtn) return;

  // Check if there are any signatures on the current page
  const currentPageAnnotations = ueState.annotations[ueState.selectedPage] || [];
  const hasSignature = currentPageAnnotations.some(a => a.type === 'signature');

  signBtn.classList.toggle('has-signature', hasSignature);
}

// Close mobile tools when clicking outside
document.addEventListener('click', function(e) {
  const dropdown = document.getElementById('mobile-tools-dropdown');
  const moreBtn = document.getElementById('ue-mobile-more-btn');

  if (dropdown && dropdown.classList.contains('active')) {
    if (!dropdown.contains(e.target) && e.target !== moreBtn && !moreBtn.contains(e.target)) {
      closeMobileTools();
    }
  }
});

// ============================================================
// ENHANCED TOUCH HANDLING FOR UNIFIED EDITOR
// ============================================================

/**
 * Initialize mobile-specific enhancements when editor loads
 * Note: Pinch-to-zoom was removed due to conflicts with signature dragging.
 * Users can use the zoom +/- buttons in the toolbar instead.
 */
function initMobileEditorEnhancements() {
  // Placeholder for future mobile-specific enhancements
  // Pinch-to-zoom removed - use toolbar zoom buttons instead
}

// Mobile UI updates are handled directly inside ueSelectPage (unified-editor.js)
