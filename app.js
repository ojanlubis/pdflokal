/*
 * ============================================================
 * PDFLokal - Main Application
 * ============================================================
 * Client-side PDF & Image manipulation tool
 * No files are ever uploaded - everything runs in browser
 * ============================================================
 */

// ============================================================
// GLOBAL STATE
// ============================================================

const state = {
  currentTool: null,
  currentPDF: null,
  currentPDFBytes: null,
  currentImages: [],
  mergeFiles: [],
  splitPages: [],
  rotatePages: [],
  pagesOrder: [],
  editAnnotations: {},
  currentEditPage: 0,
  currentEditTool: null,
  cropRect: null,
  currentCropPage: 0,
  signaturePad: null,
  signatureImage: null,
  signatureUploadImage: null,  // For uploaded signature image
  signatureUploadCanvas: null, // Canvas for signature bg removal
  originalImage: null,
  originalImageName: null,
  // Additional state for proper cleanup
  imgToPdfFiles: [],
  pdfImgPages: [],
  compressedBlob: null,
  originalImageSize: 0,
  originalWidth: 0,
  originalHeight: 0,
  // Track setup states to prevent duplicate event listeners
  workspaceDropZonesSetup: new Set(),
  editCanvasSetup: false,
  // Track blob URLs for cleanup
  blobUrls: [],
  compressPreviewUrl: null,
  // Page Manager unified state
  pmPages: [], // Array of { pageNum, sourceFile, sourceName, rotation, selected, canvas }
  pmSourceFiles: [], // Array of { name, bytes }
  pmUndoStack: [],   // Undo stack for page manager
  pmRedoStack: [],   // Redo stack for page manager
  // Original filename tracking
  originalPDFName: null,  // Original PDF filename for output naming
  // Enhanced PDF Editor state
  editUndoStack: [],           // Stack of previous annotation states for undo
  editRedoStack: [],           // Stack of undone states for redo
  selectedAnnotation: null,    // Currently selected annotation { pageNum, index }
  pendingTextPosition: null,   // Position where text will be placed { x, y }
  editPageScales: {},          // Per-page scale factors for accurate coordinate mapping
  editDevicePixelRatio: 1,     // Device pixel ratio for high-DPI displays
};

// ============================================================
// FILE SIZE LIMITS
// ============================================================

const MAX_FILE_SIZE_WARNING = 20 * 1024 * 1024; // 20MB - show warning
const MAX_FILE_SIZE_LIMIT = 100 * 1024 * 1024;  // 100MB - hard limit

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

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

document.addEventListener('DOMContentLoaded', () => {
  // Check browser compatibility first
  checkBrowserCompatibility();

  // Initialize mobile detection first
  detectMobile();

  // Listen for resize and orientation changes
  window.addEventListener('resize', debounce(detectMobile, 150));
  window.addEventListener('orientationchange', () => {
    setTimeout(detectMobile, 100);
  });

  initDropZone();
  initToolCards();
  initFileInputs();
  initRangeSliders();
  initSignaturePad();
  initNavigationHistory();
});

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

function initToolCards() {
  document.querySelectorAll('.tool-card:not(.disabled)').forEach(card => {
    card.addEventListener('click', () => {
      const tool = card.dataset.tool;

      // Handle merge-pdf and split-pdf separately (don't call showTool)
      if (tool === 'merge-pdf') {
        handleMergePdfCard();
        return;
      }
      if (tool === 'split-pdf') {
        handleSplitPdfCard();
        return;
      }

      showTool(tool);
    });
  });
}

function handleMergePdfCard() {
  // Create or get hidden file input for merge
  let mergeInput = document.getElementById('merge-pdf-input');
  if (!mergeInput) {
    mergeInput = document.createElement('input');
    mergeInput.type = 'file';
    mergeInput.id = 'merge-pdf-input';
    mergeInput.multiple = true;
    mergeInput.accept = '.pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*';
    mergeInput.style.display = 'none';
    document.body.appendChild(mergeInput);

    mergeInput.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        // Convert FileList to Array before resetting input
        const filesArray = Array.from(e.target.files);
        // Reset input immediately so same files can be selected again
        mergeInput.value = '';

        // Show loading overlay (home-view stays visible behind it)
        showFullscreenLoading('Memuat PDF...');

        try {
          // Initialize unified editor in background
          const workspace = document.getElementById('unified-editor-workspace');
          if (workspace) {
            initUnifiedEditor();

            // Load the files into unified editor
            await ueAddFiles(filesArray);

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
            uePmOpenModal();

            // Hide loading overlay after modal is ready
            setTimeout(() => {
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
  mergeInput.click();
}

function handleSplitPdfCard() {
  // Create or get hidden file input for split
  let splitInput = document.getElementById('split-pdf-input');
  if (!splitInput) {
    splitInput = document.createElement('input');
    splitInput.type = 'file';
    splitInput.id = 'split-pdf-input';
    splitInput.multiple = true;
    splitInput.accept = '.pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*';
    splitInput.style.display = 'none';
    document.body.appendChild(splitInput);

    splitInput.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        // Convert FileList to Array before resetting input
        const filesArray = Array.from(e.target.files);
        // Reset input immediately so same files can be selected again
        splitInput.value = '';

        // Show loading overlay (home-view stays visible behind it)
        showFullscreenLoading('Memuat PDF...');

        try {
          // Initialize unified editor in background
          const workspace = document.getElementById('unified-editor-workspace');
          if (workspace) {
            initUnifiedEditor();

            // Load the files into unified editor
            await ueAddFiles(filesArray);

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
            uePmOpenModal();

            // Enable split mode
            setTimeout(() => {
              if (!uePmState.extractMode) {
                uePmToggleExtractMode();
              }
              // Hide loading overlay after split mode is ready
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
  splitInput.click();
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
          await loadSignatureImage(e.target.files[0]);
        } catch (error) {
          console.error('Error loading signature:', error);
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
        await ueAddFiles(files);
      } else if (isImage && files.length > 1) {
        showTool('img-to-pdf');
        await addImagesToPDF(files);
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

function showHome(skipPushState = false) {
  document.getElementById('home-view').style.display = 'block';
  document.querySelectorAll('.workspace').forEach(ws => ws.classList.remove('active'));
  closeAllModals();
  state.currentTool = null;
  resetState();

  // Update navigation history
  if (!skipPushState) {
    history.pushState({ view: 'home' }, '', '#');
  }
  navHistory.currentView = 'home';
  navHistory.currentWorkspace = null;
  navHistory.currentModal = null;
}

function showTool(tool, skipPushState = false) {
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
    ueReset();
  }
}

// ============================================================
// LEGACY MERGE PDF (kept for future use)
// ============================================================

async function addMergeFiles(files) {
  const fileList = document.getElementById('merge-file-list');
  
  // Clear placeholder
  if (state.mergeFiles.length === 0) {
    fileList.innerHTML = '';
  }
  
  for (const file of files) {
    if (file.type !== 'application/pdf') {
      showToast(`${file.name} bukan file PDF`, 'error');
      continue;
    }
    
    try {
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      const page = await pdf.getPage(1);
      
      // Render thumbnail
      const scale = 0.3;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      
      await page.render({ canvasContext: ctx, viewport }).promise;
      
      const fileItem = createFileItem(file.name, formatFileSize(file.size), canvas.toDataURL(), state.mergeFiles.length);
      fileList.appendChild(fileItem);
      
      state.mergeFiles.push({
        name: file.name,
        bytes: bytes
      });
      
    } catch (error) {
      console.error('Error processing file:', error);
      showToast(`Gagal memproses ${file.name}`, 'error');
    }
  }
  
  // Add the "add file" button
  updateMergeAddButton();
  document.getElementById('merge-btn').disabled = state.mergeFiles.length < 2;
  
  // Enable drag to reorder
  enableDragReorder('merge-file-list', state.mergeFiles);
}

function createFileItem(name, size, thumbnail, index) {
  const div = document.createElement('div');
  div.className = 'file-item';
  div.dataset.index = index;
  div.draggable = true;

  // Escape HTML to prevent XSS
  const safeName = escapeHtml(name);
  const safeSize = escapeHtml(size);

  div.innerHTML = `
    <div class="file-item-preview">
      <img src="${thumbnail}" alt="preview">
    </div>
    <div class="file-item-info">
      <div class="file-item-name" title="${safeName}">${safeName}</div>
      <div class="file-item-size">${safeSize}</div>
    </div>
    <button class="file-item-remove">×</button>
  `;

  // Add click handler safely (avoid inline onclick with index)
  div.querySelector('.file-item-remove').addEventListener('click', () => removeMergeFile(index));

  return div;
}

function updateMergeAddButton() {
  const fileList = document.getElementById('merge-file-list');
  const existing = fileList.querySelector('.add-file-btn');
  if (existing) existing.remove();
  
  const addBtn = document.createElement('button');
  addBtn.className = 'add-file-btn';
  addBtn.innerHTML = `
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 5v14M5 12h14"/>
    </svg>
    <span>Tambah File</span>
  `;
  addBtn.onclick = () => document.getElementById('merge-input').click();
  fileList.appendChild(addBtn);
}

function removeMergeFile(index) {
  state.mergeFiles.splice(index, 1);
  refreshMergeList();
}

async function refreshMergeList() {
  const fileList = document.getElementById('merge-file-list');
  fileList.innerHTML = '';

  if (state.mergeFiles.length === 0) {
    fileList.innerHTML = '<p style="color: var(--text-tertiary); width: 100%; text-align: center;">Seret file PDF ke sini atau gunakan tombol di bawah</p>';
    document.getElementById('merge-btn').disabled = true;
    return;
  }

  // Use for...of to maintain order and await properly
  for (let i = 0; i < state.mergeFiles.length; i++) {
    const file = state.mergeFiles[i];
    try {
      const pdf = await pdfjsLib.getDocument({ data: file.bytes.slice() }).promise;
      const page = await pdf.getPage(1);

      const scale = 0.3;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');

      await page.render({ canvasContext: ctx, viewport }).promise;

      const fileItem = createFileItem(file.name, '', canvas.toDataURL(), i);
      const addBtn = fileList.querySelector('.add-file-btn');
      if (addBtn) {
        fileList.insertBefore(fileItem, addBtn);
      } else {
        fileList.appendChild(fileItem);
      }
    } catch (error) {
      console.error('Error refreshing file:', error);
    }
  }

  updateMergeAddButton();
  document.getElementById('merge-btn').disabled = state.mergeFiles.length < 2;
  enableDragReorder('merge-file-list', state.mergeFiles);
}

async function mergePDFs() {
  if (state.mergeFiles.length < 2) return;
  
  const progress = document.getElementById('merge-progress');
  const progressFill = progress.querySelector('.progress-fill');
  const progressText = progress.querySelector('.progress-text');
  
  progress.classList.remove('hidden');
  document.getElementById('merge-btn').disabled = true;
  
  try {
    const mergedPdf = await PDFLib.PDFDocument.create();
    
    for (let i = 0; i < state.mergeFiles.length; i++) {
      progressText.textContent = `Memproses file ${i + 1} dari ${state.mergeFiles.length}...`;
      progressFill.style.width = `${((i + 1) / state.mergeFiles.length) * 100}%`;
      
      const pdf = await PDFLib.PDFDocument.load(state.mergeFiles[i].bytes);
      const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
      pages.forEach(page => mergedPdf.addPage(page));
    }
    
    progressText.textContent = 'Menyimpan...';
    const mergedBytes = await mergedPdf.save();
    downloadBlob(new Blob([mergedBytes], { type: 'application/pdf' }), getDownloadFilename({originalName: state.mergeFiles[0]?.name, extension: 'pdf'}));
    
    showToast('PDF berhasil digabung!', 'success');
    
  } catch (error) {
    console.error('Error merging PDFs:', error);
    showToast('Gagal menggabung PDF', 'error');
  } finally {
    progress.classList.add('hidden');
    document.getElementById('merge-btn').disabled = false;
  }
}

// ============================================================
// SPLIT PDF
// ============================================================

async function renderSplitPages() {
  const container = document.getElementById('split-pages');
  container.innerHTML = '<div class="spinner"></div>';
  
  state.splitPages = [];
  const numPages = state.currentPDF.numPages;
  
  container.innerHTML = '';
  
  for (let i = 1; i <= numPages; i++) {
    const page = await state.currentPDF.getPage(i);
    const scale = 0.5;
    const viewport = page.getViewport({ scale });
    
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    
    await page.render({ canvasContext: ctx, viewport }).promise;
    
    const pageItem = document.createElement('div');
    pageItem.className = 'page-item';
    pageItem.dataset.page = i;
    pageItem.onclick = () => togglePageSelection(pageItem, i, 'split');
    
    pageItem.innerHTML = `
      <canvas></canvas>
      <div class="page-item-number">${i}</div>
      <div class="page-item-checkbox">✓</div>
    `;
    
    pageItem.querySelector('canvas').replaceWith(canvas);
    container.appendChild(pageItem);
    
    state.splitPages.push({ page: i, selected: false });
  }
  
  // Setup split mode change
  document.getElementById('split-mode').onchange = (e) => {
    const rangeInput = document.getElementById('split-range-input');
    rangeInput.style.display = e.target.value === 'range' ? 'flex' : 'none';
  };
}

function togglePageSelection(element, pageNum, tool) {
  element.classList.toggle('selected');
  
  if (tool === 'split') {
    const page = state.splitPages.find(p => p.page === pageNum);
    if (page) page.selected = !page.selected;
  } else if (tool === 'pdf-img') {
    const page = state.pdfImgPages.find(p => p.page === pageNum);
    if (page) page.selected = !page.selected;
  }
}

function selectAllPages() {
  const container = document.getElementById('split-pages');
  container.querySelectorAll('.page-item').forEach(item => {
    item.classList.add('selected');
  });
  state.splitPages.forEach(p => p.selected = true);
}

function deselectAllPages() {
  const container = document.getElementById('split-pages');
  container.querySelectorAll('.page-item').forEach(item => {
    item.classList.remove('selected');
  });
  state.splitPages.forEach(p => p.selected = false);
}

async function splitPDF() {
  const mode = document.getElementById('split-mode').value;
  const progress = document.getElementById('split-progress');
  const progressFill = progress.querySelector('.progress-fill');
  const progressText = progress.querySelector('.progress-text');
  const splitBtn = document.getElementById('split-btn');

  // Helper to hide progress and enable button
  const cleanup = () => {
    progress.classList.add('hidden');
    splitBtn.disabled = false;
  };

  progress.classList.remove('hidden');
  splitBtn.disabled = true;

  try {
    const srcDoc = await PDFLib.PDFDocument.load(state.currentPDFBytes);

    if (mode === 'each') {
      // Each page as separate file - create zip
      for (let i = 0; i < srcDoc.getPageCount(); i++) {
        progressText.textContent = `Memproses halaman ${i + 1}...`;
        progressFill.style.width = `${((i + 1) / srcDoc.getPageCount()) * 100}%`;

        const newDoc = await PDFLib.PDFDocument.create();
        const [page] = await newDoc.copyPages(srcDoc, [i]);
        newDoc.addPage(page);
        const bytes = await newDoc.save();

        downloadBlob(new Blob([bytes], { type: 'application/pdf' }), getDownloadFilename({originalName: state.currentPDFName, suffix: `page${i + 1}`, extension: 'pdf'}));
        await sleep(100); // Small delay between downloads
      }

      showToast('Semua halaman berhasil dipisah!', 'success');

    } else if (mode === 'range') {
      // Split by range
      const rangeStr = document.getElementById('split-range').value;
      const ranges = parsePageRanges(rangeStr, srcDoc.getPageCount());

      if (ranges.length === 0) {
        showToast('Format range tidak valid', 'error');
        cleanup();
        return;
      }

      for (let r = 0; r < ranges.length; r++) {
        progressText.textContent = `Memproses range ${r + 1}...`;
        progressFill.style.width = `${((r + 1) / ranges.length) * 100}%`;

        const newDoc = await PDFLib.PDFDocument.create();
        const pageIndices = ranges[r].map(p => p - 1);
        const pages = await newDoc.copyPages(srcDoc, pageIndices);
        pages.forEach(page => newDoc.addPage(page));

        const bytes = await newDoc.save();
        downloadBlob(new Blob([bytes], { type: 'application/pdf' }), getDownloadFilename({originalName: state.currentPDFName, suffix: `page${r + 1}`, extension: 'pdf'}));
        await sleep(100);
      }

      showToast('PDF berhasil dipisah!', 'success');

    } else {
      // Extract selected pages
      const selectedPages = state.splitPages.filter(p => p.selected).map(p => p.page - 1);

      if (selectedPages.length === 0) {
        showToast('Pilih minimal satu halaman', 'error');
        cleanup();
        return;
      }

      progressText.textContent = 'Mengekstrak halaman...';

      const newDoc = await PDFLib.PDFDocument.create();
      const pages = await newDoc.copyPages(srcDoc, selectedPages);
      pages.forEach(page => newDoc.addPage(page));

      const bytes = await newDoc.save();
      downloadBlob(new Blob([bytes], { type: 'application/pdf' }), getDownloadFilename({originalName: state.currentPDFName, extension: 'pdf'}));

      showToast('Halaman berhasil diekstrak!', 'success');
    }

  } catch (error) {
    console.error('Error splitting PDF:', error);
    showToast('Gagal memisah PDF', 'error');
  } finally {
    cleanup();
  }
}

function parsePageRanges(str, maxPages) {
  const ranges = [];
  const parts = str.split(',').map(s => s.trim()).filter(s => s);
  
  for (const part of parts) {
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(s => parseInt(s.trim()));
      if (!isNaN(start) && !isNaN(end) && start >= 1 && end <= maxPages && start <= end) {
        const range = [];
        for (let i = start; i <= end; i++) range.push(i);
        ranges.push(range);
      }
    } else {
      const page = parseInt(part);
      if (!isNaN(page) && page >= 1 && page <= maxPages) {
        ranges.push([page]);
      }
    }
  }
  
  return ranges;
}

// ============================================================
// ROTATE PDF
// ============================================================

async function renderRotatePages() {
  const container = document.getElementById('rotate-pages');
  container.innerHTML = '<div class="spinner"></div>';
  
  state.rotatePages = [];
  const numPages = state.currentPDF.numPages;
  
  container.innerHTML = '';
  
  for (let i = 1; i <= numPages; i++) {
    const page = await state.currentPDF.getPage(i);
    const scale = 0.5;
    const viewport = page.getViewport({ scale });
    
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    
    await page.render({ canvasContext: ctx, viewport }).promise;
    
    const pageItem = document.createElement('div');
    pageItem.className = 'page-item';
    pageItem.dataset.page = i;
    pageItem.onclick = () => pageItem.classList.toggle('selected');
    
    pageItem.innerHTML = `
      <canvas></canvas>
      <div class="page-item-number">${i}</div>
      <div class="page-item-checkbox">✓</div>
    `;
    
    pageItem.querySelector('canvas').replaceWith(canvas);
    container.appendChild(pageItem);
    
    state.rotatePages.push({ page: i, rotation: 0, canvas });
  }
}

function rotateSelected(degrees) {
  const container = document.getElementById('rotate-pages');
  const selected = container.querySelectorAll('.page-item.selected');

  selected.forEach(item => {
    const pageNum = parseInt(item.dataset.page);
    const pageState = state.rotatePages.find(p => p.page === pageNum);
    if (pageState) {
      // Fix negative rotation: ensure result is always positive
      pageState.rotation = ((pageState.rotation + degrees) % 360 + 360) % 360;
      const canvas = item.querySelector('canvas');
      canvas.style.transform = `rotate(${pageState.rotation}deg)`;
    }
  });
}

function rotateAll(degrees) {
  state.rotatePages.forEach(pageState => {
    // Fix negative rotation: ensure result is always positive
    pageState.rotation = ((pageState.rotation + degrees) % 360 + 360) % 360;
  });
  
  const container = document.getElementById('rotate-pages');
  container.querySelectorAll('.page-item canvas').forEach((canvas, i) => {
    canvas.style.transform = `rotate(${state.rotatePages[i].rotation}deg)`;
  });
}

async function saveRotatedPDF() {
  try {
    const srcDoc = await PDFLib.PDFDocument.load(state.currentPDFBytes);
    
    state.rotatePages.forEach(pageState => {
      if (pageState.rotation !== 0) {
        const page = srcDoc.getPage(pageState.page - 1);
        const currentRotation = page.getRotation().angle;
        page.setRotation(PDFLib.degrees(currentRotation + pageState.rotation));
      }
    });
    
    const bytes = await srcDoc.save();
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), getDownloadFilename({originalName: state.currentPDFName, extension: 'pdf'}));
    showToast('PDF berhasil diputar!', 'success');
    
  } catch (error) {
    console.error('Error rotating PDF:', error);
    showToast('Gagal memutar PDF', 'error');
  }
}

// ============================================================
// PAGES (REORDER/DELETE)
// ============================================================

async function renderPagesGrid() {
  const container = document.getElementById('pages-grid');
  container.innerHTML = '<div class="spinner"></div>';
  
  state.pagesOrder = [];
  const numPages = state.currentPDF.numPages;
  
  container.innerHTML = '';
  
  for (let i = 1; i <= numPages; i++) {
    const page = await state.currentPDF.getPage(i);
    const scale = 0.5;
    const viewport = page.getViewport({ scale });
    
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    
    await page.render({ canvasContext: ctx, viewport }).promise;
    
    const pageItem = document.createElement('div');
    pageItem.className = 'page-item';
    pageItem.dataset.page = i;
    pageItem.draggable = true;
    pageItem.onclick = (e) => {
      if (!e.target.closest('.file-item-remove')) {
        pageItem.classList.toggle('selected');
      }
    };
    
    pageItem.innerHTML = `
      <canvas></canvas>
      <div class="page-item-number">${i}</div>
      <div class="page-item-checkbox">✓</div>
      <button class="file-item-remove" onclick="event.stopPropagation(); deletePageFromGrid(${i})">×</button>
    `;
    
    pageItem.querySelector('canvas').replaceWith(canvas);
    container.appendChild(pageItem);
    
    state.pagesOrder.push(i);
  }
  
  enableDragReorder('pages-grid', state.pagesOrder, true);
}

function deletePageFromGrid(pageNum) {
  const index = state.pagesOrder.indexOf(pageNum);
  if (index > -1) {
    state.pagesOrder.splice(index, 1);
    const container = document.getElementById('pages-grid');
    const item = container.querySelector(`[data-page="${pageNum}"]`);
    if (item) item.remove();
    
    // Renumber visible pages
    container.querySelectorAll('.page-item').forEach((item, i) => {
      item.querySelector('.page-item-number').textContent = i + 1;
    });
  }
  
  if (state.pagesOrder.length === 0) {
    document.getElementById('pages-btn').disabled = true;
  }
}

function deleteSelectedPages() {
  const container = document.getElementById('pages-grid');
  const selected = container.querySelectorAll('.page-item.selected');
  
  selected.forEach(item => {
    const pageNum = parseInt(item.dataset.page);
    deletePageFromGrid(pageNum);
  });
}

async function saveReorderedPDF() {
  if (state.pagesOrder.length === 0) {
    showToast('Tidak ada halaman tersisa', 'error');
    return;
  }
  
  try {
    const srcDoc = await PDFLib.PDFDocument.load(state.currentPDFBytes);
    const newDoc = await PDFLib.PDFDocument.create();
    
    const pageIndices = state.pagesOrder.map(p => p - 1);
    const pages = await newDoc.copyPages(srcDoc, pageIndices);
    pages.forEach(page => newDoc.addPage(page));
    
    const bytes = await newDoc.save();
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), getDownloadFilename({originalName: state.currentPDFName, extension: 'pdf'}));
    showToast('PDF berhasil disimpan!', 'success');
    
  } catch (error) {
    console.error('Error saving PDF:', error);
    showToast('Gagal menyimpan PDF', 'error');
  }
}

// ============================================================
// DRAG REORDER
// ============================================================

function enableDragReorder(containerId, stateArray, isPages = false) {
  const container = document.getElementById(containerId);
  let draggedItem = null;
  
  container.querySelectorAll(isPages ? '.page-item' : '.file-item').forEach(item => {
    item.addEventListener('dragstart', (e) => {
      draggedItem = item;
      item.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      draggedItem = null;
    });
    
    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (item === draggedItem) return;
      
      const rect = item.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      
      if (e.clientX < midX) {
        container.insertBefore(draggedItem, item);
      } else {
        container.insertBefore(draggedItem, item.nextSibling);
      }
      
      // Update state array
      updateStateOrder(container, stateArray, isPages);
    });
  });
}

function updateStateOrder(container, stateArray, isPages) {
  const items = container.querySelectorAll(isPages ? '.page-item' : '.file-item');
  const newOrder = [];
  
  items.forEach(item => {
    if (isPages) {
      const pageNum = parseInt(item.dataset.page);
      if (!isNaN(pageNum)) newOrder.push(pageNum);
    } else {
      const index = parseInt(item.dataset.index);
      if (!isNaN(index) && stateArray[index]) {
        newOrder.push(stateArray[index]);
      }
    }
  });
  
  if (isPages) {
    state.pagesOrder = newOrder;
  } else {
    stateArray.length = 0;
    newOrder.forEach(item => stateArray.push(item));
  }
}

// ============================================================
// PDF TO IMAGE
// ============================================================

async function renderPdfImgPages() {
  const container = document.getElementById('pdf-img-pages');
  container.innerHTML = '<div class="spinner"></div>';
  container.classList.remove('empty');

  state.pdfImgPages = [];
  const numPages = state.currentPDF.numPages;

  container.innerHTML = '';
  
  for (let i = 1; i <= numPages; i++) {
    const page = await state.currentPDF.getPage(i);
    const scale = 0.5;
    const viewport = page.getViewport({ scale });
    
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    
    await page.render({ canvasContext: ctx, viewport }).promise;
    
    const pageItem = document.createElement('div');
    pageItem.className = 'page-item selected';
    pageItem.dataset.page = i;
    pageItem.onclick = () => togglePageSelection(pageItem, i, 'pdf-img');
    
    pageItem.innerHTML = `
      <canvas></canvas>
      <div class="page-item-number">${i}</div>
      <div class="page-item-checkbox">✓</div>
    `;
    
    pageItem.querySelector('canvas').replaceWith(canvas);
    container.appendChild(pageItem);
    
    state.pdfImgPages.push({ page: i, selected: true });
  }
}

function selectAllPdfImgPages() {
  const container = document.getElementById('pdf-img-pages');
  container.querySelectorAll('.page-item').forEach(item => item.classList.add('selected'));
  state.pdfImgPages.forEach(p => p.selected = true);
}

async function convertPDFtoImages() {
  const selectedPages = state.pdfImgPages.filter(p => p.selected);
  if (selectedPages.length === 0) {
    showToast('Pilih minimal satu halaman', 'error');
    return;
  }

  const format = document.getElementById('img-format').value;
  const scale = parseFloat(document.getElementById('img-scale').value);

  const progress = document.getElementById('pdf-img-progress');
  const progressFill = progress.querySelector('.progress-fill');
  const progressText = progress.querySelector('.progress-text');

  progress.classList.remove('hidden');
  document.getElementById('pdf-img-btn').disabled = true;

  try {
    for (let i = 0; i < selectedPages.length; i++) {
      const pageNum = selectedPages[i].page;
      progressText.textContent = `Mengkonversi halaman ${pageNum}...`;
      progressFill.style.width = `${((i + 1) / selectedPages.length) * 100}%`;

      const page = await state.currentPDF.getPage(pageNum);
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');

      await page.render({ canvasContext: ctx, viewport }).promise;

      const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
      const quality = format === 'png' ? undefined : 0.92;

      // Await blob creation to ensure proper ordering
      await new Promise((resolve) => {
        canvas.toBlob((blob) => {
          if (blob) {
            downloadBlob(blob, getDownloadFilename({originalName: state.currentPDFName, suffix: `page${pageNum}`, extension: format}));
          }
          resolve();
        }, mimeType, quality);
      });

      await sleep(100);
    }

    showToast('Semua halaman berhasil dikonversi!', 'success');

  } catch (error) {
    console.error('Error converting PDF to images:', error);
    showToast('Gagal mengkonversi PDF', 'error');
  } finally {
    progress.classList.add('hidden');
    document.getElementById('pdf-img-btn').disabled = false;
  }
}

// ============================================================
// COMPRESS PDF
// ============================================================

async function showPDFPreview(containerId) {
  const container = document.getElementById(containerId);
  
  try {
    const page = await state.currentPDF.getPage(1);
    const scale = 0.5;
    const viewport = page.getViewport({ scale });
    
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    
    await page.render({ canvasContext: ctx, viewport }).promise;
    
    container.innerHTML = '';
    container.appendChild(canvas);
    canvas.style.maxWidth = '300px';
    canvas.style.borderRadius = 'var(--radius-md)';
    canvas.style.boxShadow = 'var(--shadow-paper)';
    
  } catch (error) {
    container.innerHTML = '<p style="color: var(--text-tertiary)">Gagal memuat preview</p>';
  }
}

async function compressPDF() {
  const quality = parseInt(document.getElementById('pdf-quality').value) / 100;

  const progress = document.getElementById('compress-pdf-progress');
  const progressFill = progress.querySelector('.progress-fill');
  const progressText = progress.querySelector('.progress-text');

  progress.classList.remove('hidden');
  document.getElementById('compress-pdf-btn').disabled = true;

  try {
    progressText.textContent = 'Menganalisis PDF...';

    const srcDoc = await PDFLib.PDFDocument.load(state.currentPDFBytes, {
      ignoreEncryption: true
    });

    const pages = srcDoc.getPages();

    for (let i = 0; i < pages.length; i++) {
      progressText.textContent = `Memproses halaman ${i + 1} dari ${pages.length}...`;
      progressFill.style.width = `${((i + 1) / pages.length) * 100}%`;
      // Small delay to show progress
      await sleep(50);
    }

    progressText.textContent = 'Mengoptimasi struktur PDF...';

    // Use object streams for better compression of PDF structure
    const bytes = await srcDoc.save({
      useObjectStreams: true,
      addDefaultPage: false,
    });

    const originalSize = state.currentPDFBytes.length;
    const newSize = bytes.length;
    const reduction = ((originalSize - newSize) / originalSize * 100).toFixed(1);

    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), getDownloadFilename({originalName: state.currentPDFName, extension: 'pdf'}));

    if (newSize < originalSize) {
      showToast(`PDF dikompres! Berkurang ${reduction}%`, 'success');
    } else {
      // More informative message about limitations
      showToast('Ukuran tidak berubah. Fitur ini hanya mengoptimasi struktur PDF, bukan gambar di dalamnya.', 'info');
    }

  } catch (error) {
    console.error('Error compressing PDF:', error);
    showToast('Gagal mengkompres PDF', 'error');
  } finally {
    progress.classList.add('hidden');
    document.getElementById('compress-pdf-btn').disabled = false;
  }
}

// ============================================================
// PROTECT PDF
// ============================================================

async function protectPDF() {
  const password = document.getElementById('protect-password').value;
  const confirm = document.getElementById('protect-password-confirm').value;

  if (!password) {
    showToast('Masukkan password', 'error');
    return;
  }

  if (password !== confirm) {
    showToast('Password tidak cocok', 'error');
    return;
  }

  const protectBtn = document.getElementById('protect-btn');
  const originalText = protectBtn.innerHTML;

  // Show loading state
  protectBtn.disabled = true;
  protectBtn.innerHTML = `
    <svg class="btn-spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4m-3.93 7.07l-2.83-2.83M7.76 7.76L4.93 4.93"/>
    </svg>
    Memproses...
  `;

  try {
    // Load the PDF with pdf-lib to ensure it's valid
    const srcDoc = await PDFLib.PDFDocument.load(state.currentPDFBytes);
    const pdfBytes = await srcDoc.save();

    // Encrypt with @pdfsmaller/pdf-encrypt-lite
    const encryptedBytes = await window.encryptPDF(
      new Uint8Array(pdfBytes),
      password,
      password // Use same password for both user and owner
    );

    downloadBlob(new Blob([encryptedBytes], { type: 'application/pdf' }), getDownloadFilename({originalName: state.currentPDFName, extension: 'pdf'}));
    showToast('PDF berhasil diproteksi!', 'success');

  } catch (error) {
    console.error('Error protecting PDF:', error);
    showToast('Gagal memproteksi PDF', 'error');
  } finally {
    // Restore button state
    protectBtn.disabled = false;
    protectBtn.innerHTML = originalText;
  }
}

// ============================================================
// EDIT PDF (Whiteout, Text, Signature) - Enhanced Version
// ============================================================

async function initEditMode() {
  state.currentEditPage = 0;
  state.editAnnotations = {};
  state.currentEditTool = null;
  state.editUndoStack = [];
  state.editRedoStack = [];
  state.selectedAnnotation = null;
  state.pendingTextPosition = null;
  state.editPageScales = {};
  state.editDevicePixelRatio = window.devicePixelRatio || 1;

  for (let i = 0; i < state.currentPDF.numPages; i++) {
    state.editAnnotations[i] = [];
  }

  // Setup keyboard shortcuts
  setupEditKeyboardShortcuts();

  await renderEditPage();
  setupEditCanvas();
  updateEditorStatus('Pilih alat untuk mulai mengedit');
}

// Cached PDF page image for smooth dragging
let editPageCache = null;

async function renderEditPage() {
  const canvas = document.getElementById('edit-canvas');
  if (!canvas) return; // Skip if in Unified Editor or canvas not found
  const ctx = canvas.getContext('2d');
  const dpr = state.editDevicePixelRatio;

  const page = await state.currentPDF.getPage(state.currentEditPage + 1);

  // Use adaptive scaling based on container width
  const wrapper = document.querySelector('.editor-canvas-wrapper');
  const maxWidth = wrapper ? wrapper.clientWidth - 40 : 800;
  const naturalViewport = page.getViewport({ scale: 1 });

  // Calculate scale to fit width while maintaining quality
  let scale = Math.min(maxWidth / naturalViewport.width, 2);
  scale = Math.max(scale, 1); // Minimum scale of 1

  const viewport = page.getViewport({ scale });

  // Store scale info for this page for coordinate transformation
  state.editPageScales[state.currentEditPage] = {
    scale: scale,
    pdfWidth: naturalViewport.width,
    pdfHeight: naturalViewport.height,
    canvasWidth: viewport.width,
    canvasHeight: viewport.height
  };

  // Set canvas size accounting for device pixel ratio for crisp rendering
  canvas.width = viewport.width * dpr;
  canvas.height = viewport.height * dpr;
  canvas.style.width = viewport.width + 'px';
  canvas.style.height = viewport.height + 'px';

  // Scale context for high-DPI displays
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  await page.render({ canvasContext: ctx, viewport }).promise;

  // Cache the rendered PDF page (without annotations) for smooth dragging
  editPageCache = ctx.getImageData(0, 0, canvas.width, canvas.height);

  // Draw annotations
  redrawAnnotationsOnly();

  document.getElementById('edit-page-info').textContent =
    `Halaman ${state.currentEditPage + 1} dari ${state.currentPDF.numPages}`;

  document.getElementById('edit-prev').disabled = state.currentEditPage === 0;
  document.getElementById('edit-next').disabled = state.currentEditPage === state.currentPDF.numPages - 1;
}

// Synchronous function to redraw annotations from cache - used during drag
function redrawAnnotationsOnly() {
  const canvas = document.getElementById('edit-canvas');
  const ctx = canvas.getContext('2d');

  // Restore cached PDF page
  if (editPageCache) {
    ctx.putImageData(editPageCache, 0, 0);
  }

  // Reset transform after putImageData (which resets it)
  ctx.setTransform(state.editDevicePixelRatio, 0, 0, state.editDevicePixelRatio, 0, 0);

  // Draw annotations synchronously
  const annotations = state.editAnnotations[state.currentEditPage] || [];
  for (let i = 0; i < annotations.length; i++) {
    const anno = annotations[i];
    const isSelected = state.selectedAnnotation &&
                       state.selectedAnnotation.pageNum === state.currentEditPage &&
                       state.selectedAnnotation.index === i;
    drawAnnotationSync(ctx, anno, isSelected);
  }
}

// Synchronous version of drawAnnotation for drag operations
function drawAnnotationSync(ctx, anno, isSelected = false) {
  switch (anno.type) {
    case 'whiteout':
      ctx.fillStyle = 'white';
      ctx.fillRect(anno.x, anno.y, anno.width, anno.height);
      if (isSelected) {
        drawSelectionHandles(ctx, anno.x, anno.y, anno.width, anno.height);
      }
      break;
    case 'text':
      // Build font string with bold/italic and family
      let textFontStyle = '';
      if (anno.italic) textFontStyle += 'italic ';
      if (anno.bold) textFontStyle += 'bold ';

      // Map font family to CSS equivalent
      let textCssFontFamily = 'Helvetica, Arial, sans-serif';
      if (anno.fontFamily === 'Times-Roman') textCssFontFamily = 'Times New Roman, Times, serif';
      else if (anno.fontFamily === 'Courier') textCssFontFamily = 'Courier New, Courier, monospace';
      else if (anno.fontFamily === 'Montserrat') textCssFontFamily = 'Montserrat, sans-serif';
      else if (anno.fontFamily === 'Carlito') textCssFontFamily = 'Carlito, Calibri, sans-serif';

      ctx.font = `${textFontStyle}${anno.fontSize}px ${textCssFontFamily}`;
      ctx.fillStyle = anno.color;
      const lines = anno.text.split('\n');
      lines.forEach((line, i) => {
        ctx.fillText(line, anno.x, anno.y + (i * anno.fontSize * 1.2));
      });
      if (isSelected) {
        const metrics = ctx.measureText(anno.text);
        const textHeight = anno.fontSize * lines.length * 1.2;
        drawSelectionHandles(ctx, anno.x - 2, anno.y - anno.fontSize, metrics.width + 4, textHeight + 4);
      }
      break;
    case 'signature':
      if (anno.image) {
        // Create and cache image if not already cached
        if (!anno.cachedImg) {
          const img = new Image();
          img.src = anno.image;
          anno.cachedImg = img;
        }
        // Draw if image is loaded (data URLs load almost instantly)
        if (anno.cachedImg.complete && anno.cachedImg.naturalWidth > 0) {
          ctx.drawImage(anno.cachedImg, anno.x, anno.y, anno.width, anno.height);
          if (isSelected) {
            drawSelectionHandles(ctx, anno.x, anno.y, anno.width, anno.height);
          }
        }
      }
      break;
    case 'watermark':
      ctx.save();
      ctx.translate(anno.x, anno.y);
      ctx.rotate(anno.rotation * Math.PI / 180);
      ctx.font = `${anno.fontSize}px Arial`;
      ctx.fillStyle = anno.color;
      ctx.globalAlpha = anno.opacity;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(anno.text, 0, 0);
      ctx.restore();
      break;
    case 'pageNumber':
      ctx.font = `${anno.fontSize}px Arial`;
      ctx.fillStyle = anno.color;
      // Adjust text alignment based on position
      if (anno.position.includes('center')) {
        ctx.textAlign = 'center';
      } else if (anno.position.includes('right')) {
        ctx.textAlign = 'right';
      } else {
        ctx.textAlign = 'left';
      }
      ctx.fillText(anno.text, anno.x, anno.y);
      ctx.textAlign = 'left'; // Reset
      break;
  }
}

function drawAnnotation(ctx, anno, isSelected = false) {
  return new Promise((resolve) => {
    switch (anno.type) {
      case 'whiteout':
        ctx.fillStyle = 'white';
        ctx.fillRect(anno.x, anno.y, anno.width, anno.height);
        if (isSelected) {
          drawSelectionHandles(ctx, anno.x, anno.y, anno.width, anno.height);
        }
        resolve();
        break;
      case 'text':
        ctx.font = `${anno.fontSize}px Arial`;
        ctx.fillStyle = anno.color;
        // Handle multi-line text
        const lines = anno.text.split('\n');
        lines.forEach((line, i) => {
          ctx.fillText(line, anno.x, anno.y + (i * anno.fontSize * 1.2));
        });
        if (isSelected) {
          // Calculate text bounds for selection
          const metrics = ctx.measureText(anno.text);
          const textHeight = anno.fontSize * lines.length * 1.2;
          drawSelectionHandles(ctx, anno.x - 2, anno.y - anno.fontSize, metrics.width + 4, textHeight + 4);
        }
        resolve();
        break;
      case 'signature':
        if (anno.image && anno.cachedImg) {
          ctx.drawImage(anno.cachedImg, anno.x, anno.y, anno.width, anno.height);
          if (isSelected) {
            drawSelectionHandles(ctx, anno.x, anno.y, anno.width, anno.height);
          }
          resolve();
        } else if (anno.image) {
          const img = new Image();
          img.onload = () => {
            anno.cachedImg = img;
            ctx.drawImage(img, anno.x, anno.y, anno.width, anno.height);
            if (isSelected) {
              drawSelectionHandles(ctx, anno.x, anno.y, anno.width, anno.height);
            }
            resolve();
          };
          img.onerror = () => resolve();
          img.src = anno.image;
        } else {
          resolve();
        }
        break;
      case 'watermark':
        ctx.save();
        ctx.translate(anno.x, anno.y);
        ctx.rotate(anno.rotation * Math.PI / 180);
        ctx.font = `${anno.fontSize}px Arial`;
        ctx.fillStyle = anno.color;
        ctx.globalAlpha = anno.opacity;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(anno.text, 0, 0);
        ctx.restore();
        resolve();
        break;
      case 'pageNumber':
        ctx.font = `${anno.fontSize}px Arial`;
        ctx.fillStyle = anno.color;
        if (anno.position.includes('center')) {
          ctx.textAlign = 'center';
        } else if (anno.position.includes('right')) {
          ctx.textAlign = 'right';
        } else {
          ctx.textAlign = 'left';
        }
        ctx.fillText(anno.text, anno.x, anno.y);
        ctx.textAlign = 'left';
        resolve();
        break;
      default:
        resolve();
    }
  });
}

function drawSelectionHandles(ctx, x, y, width, height) {
  // Draw selection border
  ctx.strokeStyle = '#3B82F6';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 3]);
  ctx.strokeRect(x - 2, y - 2, width + 4, height + 4);
  ctx.setLineDash([]);

  // Draw corner handles
  const handleSize = 8;
  ctx.fillStyle = '#3B82F6';

  // Top-left
  ctx.fillRect(x - handleSize/2 - 2, y - handleSize/2 - 2, handleSize, handleSize);
  // Top-right
  ctx.fillRect(x + width - handleSize/2 + 2, y - handleSize/2 - 2, handleSize, handleSize);
  // Bottom-left
  ctx.fillRect(x - handleSize/2 - 2, y + height - handleSize/2 + 2, handleSize, handleSize);
  // Bottom-right
  ctx.fillRect(x + width - handleSize/2 + 2, y + height - handleSize/2 + 2, handleSize, handleSize);
}

function getCanvasCoordinates(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (canvas.width / canvas.clientWidth / state.editDevicePixelRatio);
  const y = (e.clientY - rect.top) * (canvas.height / canvas.clientHeight / state.editDevicePixelRatio);
  return { x, y };
}

function setupEditCanvas() {
  if (state.editCanvasSetup) {
    return;
  }

  const canvas = document.getElementById('edit-canvas');
  if (!canvas) return;

  state.editCanvasSetup = true;

  let isDrawing = false;
  let isDragging = false;
  let isResizing = false;
  let startX, startY;
  let dragOffsetX, dragOffsetY;

  // Mouse event handlers
  canvas.addEventListener('mousedown', (e) => handlePointerDown(e, canvas));
  canvas.addEventListener('mousemove', (e) => handlePointerMove(e, canvas));
  canvas.addEventListener('mouseup', (e) => handlePointerUp(e, canvas));
  canvas.addEventListener('mouseleave', () => { isDrawing = false; isDragging = false; });

  // Touch event handlers for mobile support
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    handlePointerDown({ clientX: touch.clientX, clientY: touch.clientY }, canvas);
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const touch = e.touches[0];
    handlePointerMove({ clientX: touch.clientX, clientY: touch.clientY }, canvas);
  }, { passive: false });

  canvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    const touch = e.changedTouches[0];
    handlePointerUp({ clientX: touch.clientX, clientY: touch.clientY }, canvas);
  }, { passive: false });

  function handlePointerDown(e, canvas) {
    const { x, y } = getCanvasCoordinates(e, canvas);
    startX = x;
    startY = y;

    // Check if clicking on an existing annotation (select mode)
    if (state.currentEditTool === 'select') {
      const clickedAnno = findAnnotationAt(x, y);
      if (clickedAnno) {
        // Save undo state BEFORE we start dragging (so we can undo to original position)
        saveUndoState();
        state.selectedAnnotation = clickedAnno;
        isDragging = true;
        const anno = state.editAnnotations[clickedAnno.pageNum][clickedAnno.index];
        dragOffsetX = x - anno.x;
        dragOffsetY = y - (anno.type === 'text' ? anno.y - anno.fontSize : anno.y);
        redrawAnnotationsOnly();
        return;
      } else {
        state.selectedAnnotation = null;
        redrawAnnotationsOnly();
      }
    }

    if (!state.currentEditTool || state.currentEditTool === 'select') return;
    isDrawing = true;
  }

  function handlePointerMove(e, canvas) {
    const { x, y } = getCanvasCoordinates(e, canvas);

    // Handle dragging selected annotation - use synchronous redraw for smooth movement
    if (isDragging && state.selectedAnnotation) {
      const anno = state.editAnnotations[state.selectedAnnotation.pageNum][state.selectedAnnotation.index];
      if (anno.type === 'text') {
        anno.x = x - dragOffsetX;
        anno.y = y - dragOffsetY + anno.fontSize;
      } else {
        anno.x = x - dragOffsetX;
        anno.y = y - dragOffsetY;
      }
      // Use synchronous redraw from cache - no async issues
      redrawAnnotationsOnly();
      return;
    }

    if (!isDrawing || state.currentEditTool !== 'whiteout') return;

    // Draw preview for whiteout - use synchronous redraw
    redrawAnnotationsOnly();
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.strokeStyle = '#3B82F6';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.fillRect(
      Math.min(startX, x),
      Math.min(startY, y),
      Math.abs(x - startX),
      Math.abs(y - startY)
    );
    ctx.strokeRect(
      Math.min(startX, x),
      Math.min(startY, y),
      Math.abs(x - startX),
      Math.abs(y - startY)
    );
    ctx.setLineDash([]);
  }

  function handlePointerUp(e, canvas) {
    const { x, y } = getCanvasCoordinates(e, canvas);

    // Handle end of drag (undo state was already saved in handlePointerDown)
    if (isDragging) {
      isDragging = false;
      return;
    }

    if (!isDrawing) return;
    isDrawing = false;

    if (state.currentEditTool === 'whiteout') {
      const width = Math.abs(x - startX);
      const height = Math.abs(y - startY);
      if (width > 5 && height > 5) { // Minimum size
        saveUndoState();
        state.editAnnotations[state.currentEditPage].push({
          type: 'whiteout',
          x: Math.min(startX, x),
          y: Math.min(startY, y),
          width,
          height
        });
        renderEditPage();
      }
    } else if (state.currentEditTool === 'text') {
      state.pendingTextPosition = { x: startX, y: startY };
      openTextModal();
    } else if (state.currentEditTool === 'signature' && state.signatureImage) {
      saveUndoState();
      // Calculate signature size based on page scale (adaptive sizing)
      const pageScale = state.editPageScales[state.currentEditPage];
      const sigWidth = Math.min(200, pageScale.canvasWidth * 0.3);
      const sigHeight = sigWidth / 2; // Maintain 2:1 aspect ratio

      const annotation = {
        type: 'signature',
        image: state.signatureImage,
        x: startX,
        y: startY,
        width: sigWidth,
        height: sigHeight
      };

      // Pre-cache the image for immediate visual rendering
      const img = new Image();
      img.onload = () => {
        annotation.cachedImg = img;
        renderEditPage();
        updateEditorStatus('Tanda tangan ditambahkan');
      };
      img.onerror = () => {
        // Still render even if image fails to load
        renderEditPage();
        updateEditorStatus('Tanda tangan ditambahkan');
      };
      img.src = state.signatureImage;

      state.editAnnotations[state.currentEditPage].push(annotation);
    }
  }
}

function findAnnotationAt(x, y) {
  const annotations = state.editAnnotations[state.currentEditPage] || [];
  // Check in reverse order (topmost first)
  for (let i = annotations.length - 1; i >= 0; i--) {
    const anno = annotations[i];
    let bounds;

    if (anno.type === 'whiteout' || anno.type === 'signature') {
      bounds = { x: anno.x, y: anno.y, width: anno.width, height: anno.height };
    } else if (anno.type === 'text') {
      // Approximate text bounds
      const canvas = document.getElementById('edit-canvas');
      const ctx = canvas.getContext('2d');
      ctx.font = `${anno.fontSize}px Arial`;
      const metrics = ctx.measureText(anno.text);
      const lines = anno.text.split('\n');
      bounds = {
        x: anno.x,
        y: anno.y - anno.fontSize,
        width: metrics.width,
        height: anno.fontSize * lines.length * 1.2
      };
    }

    if (bounds &&
        x >= bounds.x && x <= bounds.x + bounds.width &&
        y >= bounds.y && y <= bounds.y + bounds.height) {
      return { pageNum: state.currentEditPage, index: i };
    }
  }
  return null;
}

function setEditTool(tool) {
  state.currentEditTool = tool;
  state.selectedAnnotation = null;

  document.querySelectorAll('.editor-tool-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.editTool === tool);
  });

  // Update canvas cursor (only for legacy editor)
  const canvas = document.getElementById('edit-canvas');
  if (canvas) {
    canvas.className = 'editor-canvas';
    if (tool) {
      canvas.classList.add(`tool-${tool}`);
    }
  }

  // Update status message
  const messages = {
    'select': 'Klik anotasi untuk memilih, seret untuk memindahkan',
    'whiteout': 'Seret untuk menggambar area whiteout',
    'text': 'Klik di mana Anda ingin menambahkan teks',
    'signature': state.signatureImage ? 'Klik untuk menempatkan tanda tangan' : 'Buat tanda tangan terlebih dahulu'
  };
  updateEditorStatus(messages[tool] || 'Pilih alat untuk mulai mengedit');

  renderEditPage();
}

function updateEditorStatus(message) {
  const statusEl = document.querySelector('#editor-status .status-text');
  if (statusEl) {
    statusEl.textContent = message;
  }
}

function editPrevPage() {
  if (state.currentEditPage > 0) {
    state.selectedAnnotation = null;
    state.currentEditPage--;
    renderEditPage();
  }
}

function editNextPage() {
  if (state.currentEditPage < state.currentPDF.numPages - 1) {
    state.selectedAnnotation = null;
    state.currentEditPage++;
    renderEditPage();
  }
}

// Undo/Redo System
function saveUndoState() {
  // Deep clone the current annotations
  const currentState = JSON.parse(JSON.stringify(state.editAnnotations));
  state.editUndoStack.push(currentState);
  state.editRedoStack = []; // Clear redo stack when new action is performed

  // Limit undo stack to 50 states
  if (state.editUndoStack.length > 50) {
    state.editUndoStack.shift();
  }
}

function undoEdit() {
  if (state.editUndoStack.length === 0) {
    showToast('Tidak ada yang bisa di-undo', 'info');
    return;
  }

  // Save current state to redo stack
  const currentState = JSON.parse(JSON.stringify(state.editAnnotations));
  state.editRedoStack.push(currentState);

  // Restore previous state
  const previousState = state.editUndoStack.pop();

  // Preserve cached images
  for (const pageNum in previousState) {
    for (const anno of previousState[pageNum]) {
      if (anno.type === 'signature' && anno.image) {
        // Find matching annotation in current state to copy cached image
        const currentAnno = state.editAnnotations[pageNum]?.find(
          a => a.type === 'signature' && a.image === anno.image
        );
        if (currentAnno?.cachedImg) {
          anno.cachedImg = currentAnno.cachedImg;
        }
      }
    }
  }

  state.editAnnotations = previousState;
  state.selectedAnnotation = null;
  renderEditPage();
  showToast('Undo berhasil', 'success');
}

function redoEdit() {
  if (state.editRedoStack.length === 0) {
    showToast('Tidak ada yang bisa di-redo', 'info');
    return;
  }

  // Save current state to undo stack
  const currentState = JSON.parse(JSON.stringify(state.editAnnotations));
  state.editUndoStack.push(currentState);

  // Restore next state
  const nextState = state.editRedoStack.pop();

  // Preserve cached images
  for (const pageNum in nextState) {
    for (const anno of nextState[pageNum]) {
      if (anno.type === 'signature' && anno.image) {
        const currentAnno = state.editAnnotations[pageNum]?.find(
          a => a.type === 'signature' && a.image === anno.image
        );
        if (currentAnno?.cachedImg) {
          anno.cachedImg = currentAnno.cachedImg;
        }
      }
    }
  }

  state.editAnnotations = nextState;
  state.selectedAnnotation = null;
  renderEditPage();
  showToast('Redo berhasil', 'success');
}

function clearCurrentPageAnnotations() {
  if (state.editAnnotations[state.currentEditPage]?.length === 0) {
    showToast('Tidak ada anotasi di halaman ini', 'info');
    return;
  }

  if (confirm('Hapus semua anotasi di halaman ini?')) {
    saveUndoState();
    state.editAnnotations[state.currentEditPage] = [];
    state.selectedAnnotation = null;
    renderEditPage();
    showToast('Semua anotasi di halaman ini dihapus', 'success');
  }
}

function deleteSelectedAnnotation() {
  if (!state.selectedAnnotation) {
    showToast('Pilih anotasi terlebih dahulu', 'info');
    return;
  }

  saveUndoState();
  const { pageNum, index } = state.selectedAnnotation;
  state.editAnnotations[pageNum].splice(index, 1);
  state.selectedAnnotation = null;
  renderEditPage();
  showToast('Anotasi dihapus', 'success');
}

// Keyboard shortcuts
function setupEditKeyboardShortcuts() {
  const handler = (e) => {
    // Only handle when edit workspace is visible
    const editWorkspace = document.getElementById('edit-pdf-workspace');
    if (!editWorkspace || editWorkspace.style.display === 'none') return;

    // Don't handle if typing in input
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    // Ctrl/Cmd + Z for undo
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undoEdit();
    }
    // Ctrl/Cmd + Y or Ctrl/Cmd + Shift + Z for redo
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      redoEdit();
    }
    // Delete or Backspace to delete selected annotation
    else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedAnnotation) {
      e.preventDefault();
      deleteSelectedAnnotation();
    }
    // Tool shortcuts
    else if (!e.ctrlKey && !e.metaKey) {
      switch (e.key.toLowerCase()) {
        case 'v': setEditTool('select'); break;
        case 'w': setEditTool('whiteout'); break;
        case 't': setEditTool('text'); break;
        case 's': openSignatureModal(); break;
        case 'escape':
          state.selectedAnnotation = null;
          state.currentEditTool = null;
          document.querySelectorAll('.editor-tool-btn').forEach(btn => btn.classList.remove('active'));
          renderEditPage();
          break;
      }
    }
  };

  document.addEventListener('keydown', handler);
  // Store reference to remove later if needed
  state.editKeyboardHandler = handler;
}

// Text Input Modal
function initTextModalControls() {
  const boldBtn = document.getElementById('modal-text-bold');
  const italicBtn = document.getElementById('modal-text-italic');
  const colorPresets = document.querySelectorAll('.color-preset-btn');
  const colorPicker = document.getElementById('modal-text-color');

  // Bold toggle
  boldBtn.onclick = () => {
    boldBtn.classList.toggle('active');
    updateTextPreview();
  };

  // Italic toggle
  italicBtn.onclick = () => {
    italicBtn.classList.toggle('active');
    updateTextPreview();
  };

  // Color presets
  colorPresets.forEach(btn => {
    btn.onclick = () => {
      const color = btn.dataset.color;
      colorPicker.value = color;
      colorPresets.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateTextPreview();
    };
  });

  // Color picker change
  colorPicker.oninput = () => {
    colorPresets.forEach(b => b.classList.remove('active'));
    updateTextPreview();
  };
}

function openTextModal() {
  const modal = document.getElementById('text-input-modal');
  modal.classList.add('active');
  pushModalState('text-input-modal');

  const textInput = document.getElementById('text-input-field');
  textInput.value = '';
  textInput.focus();

  // Reset to defaults
  document.getElementById('modal-font-family').value = 'Helvetica';
  document.getElementById('modal-font-size').value = '16';
  document.getElementById('modal-text-bold').classList.remove('active');
  document.getElementById('modal-text-italic').classList.remove('active');
  document.getElementById('modal-text-color').value = '#000000';

  // Set black as active preset
  document.querySelectorAll('.color-preset-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.color === '#000000');
  });

  // Setup live preview
  initTextModalControls();
  updateTextPreview();

  textInput.oninput = updateTextPreview;
  document.getElementById('modal-font-size').oninput = updateTextPreview;
  document.getElementById('modal-font-family').onchange = updateTextPreview;

  // Enter key to submit (Shift+Enter for new line)
  textInput.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      confirmTextInput();
    }
  };
}

function closeTextModal(skipHistoryBack = false) {
  const modal = document.getElementById('text-input-modal');
  modal.classList.remove('active');
  state.pendingTextPosition = null;
  navHistory.currentModal = null;
  if (!skipHistoryBack && navHistory.currentView === 'modal') {
    history.back();
  }
}

function updateTextPreview() {
  const text = document.getElementById('text-input-field').value || 'Preview teks';
  const fontSize = document.getElementById('modal-font-size').value;
  const color = document.getElementById('modal-text-color').value;
  const fontFamily = document.getElementById('modal-font-family').value;
  const isBold = document.getElementById('modal-text-bold').classList.contains('active');
  const isItalic = document.getElementById('modal-text-italic').classList.contains('active');

  const preview = document.getElementById('text-preview');
  preview.textContent = text;
  preview.style.fontSize = fontSize + 'px';
  preview.style.color = color;
  preview.style.fontWeight = isBold ? 'bold' : 'normal';
  preview.style.fontStyle = isItalic ? 'italic' : 'normal';

  // Map font family to CSS
  let cssFontFamily = 'Helvetica, Arial, sans-serif';
  if (fontFamily === 'Times-Roman') cssFontFamily = 'Times New Roman, Times, serif';
  else if (fontFamily === 'Courier') cssFontFamily = 'Courier New, Courier, monospace';
  else if (fontFamily === 'Montserrat') cssFontFamily = 'Montserrat, sans-serif';
  else if (fontFamily === 'Carlito') cssFontFamily = 'Carlito, Calibri, sans-serif';
  preview.style.fontFamily = cssFontFamily;
}

function getTextModalSettings() {
  return {
    text: document.getElementById('text-input-field').value.trim(),
    fontSize: parseInt(document.getElementById('modal-font-size').value) || 16,
    color: document.getElementById('modal-text-color').value,
    fontFamily: document.getElementById('modal-font-family').value,
    bold: document.getElementById('modal-text-bold').classList.contains('active'),
    italic: document.getElementById('modal-text-italic').classList.contains('active')
  };
}

function confirmTextInput() {
  // Check if we're in unified editor mode
  if (state.currentTool === 'unified-editor' && ueState.pendingTextPosition) {
    ueConfirmText();
    return;
  }

  const settings = getTextModalSettings();

  if (!settings.text) {
    showToast('Masukkan teks terlebih dahulu', 'error');
    return;
  }

  if (!state.pendingTextPosition) {
    showToast('Posisi teks tidak valid', 'error');
    closeTextModal();
    return;
  }

  saveUndoState();
  state.editAnnotations[state.currentEditPage].push({
    type: 'text',
    text: settings.text,
    x: state.pendingTextPosition.x,
    y: state.pendingTextPosition.y,
    fontSize: settings.fontSize,
    color: settings.color,
    fontFamily: settings.fontFamily,
    bold: settings.bold,
    italic: settings.italic
  });

  closeTextModal();
  renderEditPage();
  setEditTool('select'); // Reset to select tool after adding text
  updateEditorStatus('Teks ditambahkan');
}

// Signature Modal
function openSignatureModal() {
  document.getElementById('signature-modal').classList.add('active');
  setEditTool('signature');
  pushModalState('signature-modal');

  // Default to upload tab
  switchSignatureTab('upload');

  setTimeout(() => {
    const canvas = document.getElementById('signature-canvas');
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = canvas.offsetWidth * ratio;
    canvas.height = canvas.offsetHeight * ratio;
    canvas.getContext('2d').scale(ratio, ratio);
    if (state.signaturePad) state.signaturePad.clear();
  }, 100);
}

function closeSignatureModal(skipHistoryBack = false) {
  document.getElementById('signature-modal').classList.remove('active');
  navHistory.currentModal = null;
  if (!skipHistoryBack && navHistory.currentView === 'modal') {
    history.back();
  }
}

function clearSignature() {
  if (state.signaturePad) {
    state.signaturePad.clear();
  }
}

function useSignature() {
  if (state.signaturePad && !state.signaturePad.isEmpty()) {
    // Get the drawn signature
    const signatureCanvas = document.getElementById('signature-canvas');

    // Create a temporary canvas for background removal
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = signatureCanvas.width;
    tempCanvas.height = signatureCanvas.height;
    const ctx = tempCanvas.getContext('2d');

    // Draw the signature
    ctx.drawImage(signatureCanvas, 0, 0);

    // Apply background removal (make white pixels transparent)
    const imageData = ctx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
    const data = imageData.data;
    const threshold = 240; // Threshold for white background

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      // Make white/near-white pixels transparent
      if (r >= threshold && g >= threshold && b >= threshold) {
        data[i + 3] = 0; // Set alpha to 0 (transparent)
      }
    }

    ctx.putImageData(imageData, 0, 0);
    state.signatureImage = tempCanvas.toDataURL('image/png');

    closeSignatureModal();
    // Check if in unified editor mode
    if (state.currentTool === 'unified-editor') {
      ueSetTool('signature');
      // Enable signature preview attached to cursor
      ueState.pendingSignature = true;
      ueState.signaturePreviewPos = null;
    } else {
      setEditTool('signature');
    }
    showToast('Klik pada PDF untuk menempatkan tanda tangan', 'success');
  } else {
    showToast('Buat tanda tangan terlebih dahulu', 'error');
  }
}

// Signature Tab Switching
function switchSignatureTab(tab) {
  // Update tab buttons
  document.querySelectorAll('.signature-tab').forEach(btn => {
    const text = btn.textContent.toLowerCase().trim();
    const shouldBeActive = (tab === 'upload' && text === 'upload gambar') ||
                          (tab === 'draw' && text === 'gambar');
    btn.classList.toggle('active', shouldBeActive);
  });

  // Update tab content
  document.getElementById('signature-draw-tab').classList.toggle('active', tab === 'draw');
  document.getElementById('signature-upload-tab').classList.toggle('active', tab === 'upload');

  // Re-init signature pad if switching to draw tab
  if (tab === 'draw') {
    setTimeout(() => {
      const canvas = document.getElementById('signature-canvas');
      if (canvas && state.signaturePad) {
        const ratio = Math.max(window.devicePixelRatio || 1, 1);
        canvas.width = canvas.offsetWidth * ratio;
        canvas.height = canvas.offsetHeight * ratio;
        canvas.getContext('2d').scale(ratio, ratio);
        state.signaturePad.clear();
      }
    }, 100);
  }
}

// Load Signature Image for Background Removal
async function loadSignatureImage(file) {
  try {
    const img = await loadImage(file);
    state.signatureUploadImage = img;

    // Close signature modal and open bg removal modal
    closeSignatureModal();
    openSignatureBgModal();
  } catch (error) {
    console.error('Error loading signature image:', error);
    showToast('Gagal memuat gambar', 'error');
  }
}

// Signature Background Removal Modal
function openSignatureBgModal() {
  document.getElementById('signature-bg-modal').classList.add('active');
  pushModalState('signature-bg-modal');

  // Show original image
  document.getElementById('sig-bg-original').src = state.signatureUploadImage.src;

  // Initialize preview
  updateSignatureBgPreview();
}

function closeSignatureBgModal(skipHistoryBack = false) {
  document.getElementById('signature-bg-modal').classList.remove('active');

  // Cleanup
  if (state.signatureUploadImage && state.signatureUploadImage._blobUrl) {
    URL.revokeObjectURL(state.signatureUploadImage._blobUrl);
  }
  state.signatureUploadImage = null;
  state.signatureUploadCanvas = null;

  navHistory.currentModal = null;
  if (!skipHistoryBack && navHistory.currentView === 'modal') {
    history.back();
  }
}

function updateSignatureBgPreview() {
  if (!state.signatureUploadImage) return;

  const threshold = parseInt(document.getElementById('sig-bg-threshold').value);

  // Update slider display
  document.getElementById('sig-bg-threshold-value').textContent = threshold;

  const canvas = document.getElementById('sig-bg-preview');
  const ctx = canvas.getContext('2d');

  // Set canvas size to match original image
  canvas.width = state.signatureUploadImage.naturalWidth;
  canvas.height = state.signatureUploadImage.naturalHeight;

  // Draw original image
  ctx.drawImage(state.signatureUploadImage, 0, 0);

  // Get image data
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  // Process each pixel - make white/near-white pixels transparent
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    // Check if pixel is white/near-white based on threshold
    if (r >= threshold && g >= threshold && b >= threshold) {
      data[i + 3] = 0; // Set alpha to 0 (transparent)
    }
  }

  // Put the modified image data back
  ctx.putImageData(imageData, 0, 0);

  // Store reference for use
  state.signatureUploadCanvas = canvas;
}

function useSignatureFromUpload() {
  if (!state.signatureUploadCanvas) {
    showToast('Tidak ada gambar untuk digunakan', 'error');
    return;
  }

  // Convert canvas to data URL and use as signature
  state.signatureImage = state.signatureUploadCanvas.toDataURL('image/png');

  closeSignatureBgModal();
  // Check if in unified editor mode
  if (state.currentTool === 'unified-editor') {
    ueSetTool('signature');
    // Enable signature preview attached to cursor
    ueState.pendingSignature = true;
    ueState.signaturePreviewPos = null;
    ueUpdateStatus('Klik untuk menempatkan tanda tangan');
  } else {
    setEditTool('signature');
    updateEditorStatus('Klik untuk menempatkan tanda tangan');
  }
  showToast('Klik pada PDF untuk menempatkan tanda tangan', 'success');
}

// Editor Watermark Functions
function openEditorWatermarkModal() {
  document.getElementById('editor-watermark-modal').classList.add('active');
  pushModalState('editor-watermark-modal');
}

function closeEditorWatermarkModal(skipHistoryBack = false) {
  document.getElementById('editor-watermark-modal').classList.remove('active');
  navHistory.currentModal = null;
  if (!skipHistoryBack && navHistory.currentView === 'modal') {
    history.back();
  }
}

function applyEditorWatermark() {
  const text = document.getElementById('editor-wm-text').value || 'WATERMARK';
  const fontSize = parseInt(document.getElementById('editor-wm-size').value);
  const color = document.getElementById('editor-wm-color').value;
  const opacity = parseInt(document.getElementById('editor-wm-opacity').value) / 100;
  const rotation = parseInt(document.getElementById('editor-wm-rotation').value);
  const applyTo = document.getElementById('editor-wm-pages').value;

  // Check if in unified editor mode
  if (state.currentTool === 'unified-editor') {
    ueSaveEditUndoState();
    const pageScale = ueState.pageScales[ueState.selectedPage] || { canvasWidth: 600, canvasHeight: 800 };
    const centerX = pageScale.canvasWidth / 2;
    const centerY = pageScale.canvasHeight / 2;

    const watermarkAnno = {
      type: 'watermark',
      text,
      fontSize,
      color,
      opacity,
      rotation,
      x: centerX,
      y: centerY
    };

    if (applyTo === 'all') {
      for (let i = 0; i < ueState.pages.length; i++) {
        if (!ueState.annotations[i]) ueState.annotations[i] = [];
        ueState.annotations[i].push({ ...watermarkAnno });
      }
      showToast('Watermark diterapkan ke semua halaman', 'success');
    } else {
      ueState.annotations[ueState.selectedPage].push(watermarkAnno);
      showToast('Watermark diterapkan', 'success');
    }

    closeEditorWatermarkModal();
    ueRedrawAnnotations();
    return;
  }

  saveUndoState();

  const canvas = document.getElementById('edit-canvas');
  const pageScale = state.editPageScales[state.currentEditPage];
  const centerX = pageScale.canvasWidth / 2;
  const centerY = pageScale.canvasHeight / 2;

  const watermarkAnno = {
    type: 'watermark',
    text,
    fontSize,
    color,
    opacity,
    rotation,
    x: centerX,
    y: centerY
  };

  if (applyTo === 'all') {
    // Apply to all pages
    for (let i = 0; i < state.currentPDF.numPages; i++) {
      state.editAnnotations[i].push({ ...watermarkAnno });
    }
    showToast('Watermark diterapkan ke semua halaman', 'success');
  } else {
    // Apply to current page only
    state.editAnnotations[state.currentEditPage].push(watermarkAnno);
    showToast('Watermark diterapkan', 'success');
  }

  closeEditorWatermarkModal();
  renderEditPage();
}

// Editor Page Number Functions
function openEditorPageNumModal() {
  document.getElementById('editor-pagenum-modal').classList.add('active');
  pushModalState('editor-pagenum-modal');
}

function closeEditorPageNumModal(skipHistoryBack = false) {
  document.getElementById('editor-pagenum-modal').classList.remove('active');
  navHistory.currentModal = null;
  if (!skipHistoryBack && navHistory.currentView === 'modal') {
    history.back();
  }
}

function applyEditorPageNumbers() {
  const position = document.getElementById('editor-pn-position').value;
  const format = document.getElementById('editor-pn-format').value;
  const fontSize = parseInt(document.getElementById('editor-pn-size').value);
  const startNum = parseInt(document.getElementById('editor-pn-start').value) || 1;

  // Check if in unified editor mode
  if (state.currentTool === 'unified-editor') {
    const totalPages = ueState.pages.length;
    ueSaveEditUndoState();

    for (let i = 0; i < totalPages; i++) {
      const pageNum = startNum + i;
      let text;

      switch (format) {
        case 'page-of':
          text = `Halaman ${pageNum} dari ${totalPages + startNum - 1}`;
          break;
        case 'dash':
          text = `- ${pageNum} -`;
          break;
        default:
          text = `${pageNum}`;
      }

      const pageScale = ueState.pageScales[i] || ueState.pageScales[ueState.selectedPage] || { canvasWidth: 600, canvasHeight: 800 };
      const canvasWidth = pageScale.canvasWidth;
      const canvasHeight = pageScale.canvasHeight;
      const margin = 30;

      let x, y;
      switch (position) {
        case 'bottom-left':
          x = margin; y = canvasHeight - margin; break;
        case 'bottom-right':
          x = canvasWidth - margin; y = canvasHeight - margin; break;
        case 'top-center':
          x = canvasWidth / 2; y = margin + fontSize; break;
        case 'top-left':
          x = margin; y = margin + fontSize; break;
        case 'top-right':
          x = canvasWidth - margin; y = margin + fontSize; break;
        default:
          x = canvasWidth / 2; y = canvasHeight - margin;
      }

      if (!ueState.annotations[i]) ueState.annotations[i] = [];
      ueState.annotations[i].push({
        type: 'pageNumber',
        text,
        fontSize,
        color: '#000000',
        x,
        y,
        position
      });
    }

    closeEditorPageNumModal();
    ueRedrawAnnotations();
    showToast('Nomor halaman ditambahkan ke semua halaman', 'success');
    return;
  }

  const totalPages = state.currentPDF.numPages;
  saveUndoState();

  for (let i = 0; i < totalPages; i++) {
    const pageNum = startNum + i;
    let text;

    switch (format) {
      case 'page-of':
        text = `Halaman ${pageNum} dari ${totalPages + startNum - 1}`;
        break;
      case 'dash':
        text = `- ${pageNum} -`;
        break;
      default:
        text = `${pageNum}`;
    }

    // Calculate position based on page scale
    const pageScale = state.editPageScales[i] || state.editPageScales[state.currentEditPage];
    const canvasWidth = pageScale?.canvasWidth || 600;
    const canvasHeight = pageScale?.canvasHeight || 800;
    const margin = 30;

    let x, y;
    switch (position) {
      case 'bottom-left':
        x = margin;
        y = canvasHeight - margin;
        break;
      case 'bottom-right':
        x = canvasWidth - margin;
        y = canvasHeight - margin;
        break;
      case 'top-center':
        x = canvasWidth / 2;
        y = margin + fontSize;
        break;
      case 'top-left':
        x = margin;
        y = margin + fontSize;
        break;
      case 'top-right':
        x = canvasWidth - margin;
        y = margin + fontSize;
        break;
      default: // bottom-center
        x = canvasWidth / 2;
        y = canvasHeight - margin;
    }

    state.editAnnotations[i].push({
      type: 'pageNumber',
      text,
      fontSize,
      color: '#000000',
      x,
      y,
      position
    });
  }

  closeEditorPageNumModal();
  renderEditPage();
  showToast('Nomor halaman ditambahkan ke semua halaman', 'success');
}

async function saveEditedPDF() {
  try {
    const srcDoc = await PDFLib.PDFDocument.load(state.currentPDFBytes);
    const pages = srcDoc.getPages();

    // Font cache for all text annotations
    const fontCache = {};

    // Helper to get the right font based on family, bold, italic
    async function getTextFont(fontFamily, bold, italic) {
      let fontName = fontFamily || 'Helvetica';

      if (fontFamily === 'Helvetica') {
        if (bold && italic) fontName = 'HelveticaBoldOblique';
        else if (bold) fontName = 'HelveticaBold';
        else if (italic) fontName = 'HelveticaOblique';
        else fontName = 'Helvetica';
      } else if (fontFamily === 'Times-Roman') {
        if (bold && italic) fontName = 'TimesRomanBoldItalic';
        else if (bold) fontName = 'TimesRomanBold';
        else if (italic) fontName = 'TimesRomanItalic';
        else fontName = 'TimesRoman';
      } else if (fontFamily === 'Courier') {
        if (bold && italic) fontName = 'CourierBoldOblique';
        else if (bold) fontName = 'CourierBold';
        else if (italic) fontName = 'CourierOblique';
        else fontName = 'Courier';
      }

      if (!fontCache[fontName]) {
        fontCache[fontName] = await srcDoc.embedFont(PDFLib.StandardFonts[fontName]);
      }
      return fontCache[fontName];
    }

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const annotations = state.editAnnotations[i] || [];
      const { width: pdfWidth, height: pdfHeight } = page.getSize();

      // Get the scale info for this page
      const pageScaleInfo = state.editPageScales[i];
      if (!pageScaleInfo && annotations.length > 0) {
        // If we don't have scale info (page wasn't viewed), we need to calculate it
        const pdfPage = await state.currentPDF.getPage(i + 1);
        const naturalViewport = pdfPage.getViewport({ scale: 1 });
        const wrapper = document.querySelector('.editor-canvas-wrapper');
        const maxWidth = wrapper ? wrapper.clientWidth - 40 : 800;
        let scale = Math.min(maxWidth / naturalViewport.width, 2);
        scale = Math.max(scale, 1);

        state.editPageScales[i] = {
          scale: scale,
          pdfWidth: naturalViewport.width,
          pdfHeight: naturalViewport.height,
          canvasWidth: naturalViewport.width * scale,
          canvasHeight: naturalViewport.height * scale
        };
      }

      const scaleInfo = state.editPageScales[i];
      if (!scaleInfo) continue;

      // Correct scale factors: canvas coordinates to PDF coordinates
      const scaleX = pdfWidth / scaleInfo.canvasWidth;
      const scaleY = pdfHeight / scaleInfo.canvasHeight;

      for (const anno of annotations) {
        if (anno.type === 'whiteout') {
          // Convert canvas coordinates to PDF coordinates
          const pdfX = anno.x * scaleX;
          const pdfY = pdfHeight - (anno.y + anno.height) * scaleY; // Y is flipped in PDF
          const pdfW = anno.width * scaleX;
          const pdfH = anno.height * scaleY;

          page.drawRectangle({
            x: pdfX,
            y: pdfY,
            width: pdfW,
            height: pdfH,
            color: PDFLib.rgb(1, 1, 1),
          });
        } else if (anno.type === 'text') {
          const hexColor = anno.color || '#000000';
          const r = parseInt(hexColor.slice(1, 3), 16) / 255;
          const g = parseInt(hexColor.slice(3, 5), 16) / 255;
          const b = parseInt(hexColor.slice(5, 7), 16) / 255;

          // Get the appropriate font based on family and style
          const textFont = await getTextFont(anno.fontFamily, anno.bold, anno.italic);

          // Text position conversion
          const pdfX = anno.x * scaleX;
          const pdfY = pdfHeight - anno.y * scaleY;
          const pdfFontSize = anno.fontSize * scaleX;

          // Handle multi-line text
          const lines = anno.text.split('\n');
          for (let idx = 0; idx < lines.length; idx++) {
            page.drawText(lines[idx], {
              x: pdfX,
              y: pdfY - (idx * pdfFontSize * 1.2),
              size: pdfFontSize,
              font: textFont,
              color: PDFLib.rgb(r, g, b),
            });
          }
        } else if (anno.type === 'signature' && anno.image) {
          try {
            const pngImage = await srcDoc.embedPng(anno.image);
            const pdfX = anno.x * scaleX;
            const pdfY = pdfHeight - (anno.y + anno.height) * scaleY;
            const pdfW = anno.width * scaleX;
            const pdfH = anno.height * scaleY;

            page.drawImage(pngImage, {
              x: pdfX,
              y: pdfY,
              width: pdfW,
              height: pdfH,
            });
          } catch (imgError) {
            console.error('Error embedding signature:', imgError);
          }
        } else if (anno.type === 'watermark') {
          const hexColor = anno.color || '#888888';
          const r = parseInt(hexColor.slice(1, 3), 16) / 255;
          const g = parseInt(hexColor.slice(3, 5), 16) / 255;
          const b = parseInt(hexColor.slice(5, 7), 16) / 255;

          const pdfX = anno.x * scaleX;
          const pdfY = pdfHeight - anno.y * scaleY;
          const pdfFontSize = anno.fontSize * scaleX;

          // Estimate text width for centering
          const textWidth = anno.text.length * pdfFontSize * 0.5;

          page.drawText(anno.text, {
            x: pdfX - textWidth / 2,
            y: pdfY,
            size: pdfFontSize,
            font,
            color: PDFLib.rgb(r, g, b),
            opacity: anno.opacity,
            rotate: PDFLib.degrees(anno.rotation),
          });
        } else if (anno.type === 'pageNumber') {
          const pdfX = anno.x * scaleX;
          const pdfY = pdfHeight - anno.y * scaleY;
          const pdfFontSize = anno.fontSize * scaleX;

          // Adjust X position based on text alignment
          let adjustedX = pdfX;
          if (anno.position.includes('center')) {
            const textWidth = font.widthOfTextAtSize(anno.text, pdfFontSize);
            adjustedX = pdfX - textWidth / 2;
          } else if (anno.position.includes('right')) {
            const textWidth = font.widthOfTextAtSize(anno.text, pdfFontSize);
            adjustedX = pdfX - textWidth;
          }

          page.drawText(anno.text, {
            x: adjustedX,
            y: pdfY,
            size: pdfFontSize,
            font,
            color: PDFLib.rgb(0, 0, 0),
          });
        }
      }
    }

    const bytes = await srcDoc.save();
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), getDownloadFilename({originalName: state.currentPDFName, extension: 'pdf'}));
    showToast('PDF berhasil disimpan!', 'success');

  } catch (error) {
    console.error('Error saving edited PDF:', error);
    showToast('Gagal menyimpan PDF: ' + error.message, 'error');
  }
}

// ============================================================
// COMPRESS IMAGE
// ============================================================

async function updateCompressPreview() {
  if (!state.originalImage) return;

  const quality = parseInt(document.getElementById('compress-quality').value) / 100;
  const format = document.getElementById('compress-format').value;

  // Update slider display
  document.querySelector('#compress-img-workspace .range-value').textContent =
    document.getElementById('compress-quality').value + '%';

  const canvas = document.createElement('canvas');
  canvas.width = state.originalImage.naturalWidth;
  canvas.height = state.originalImage.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(state.originalImage, 0, 0);

  const mimeType = `image/${format}`;

  canvas.toBlob((blob) => {
    if (blob) {
      // Revoke previous blob URL to prevent memory leak
      if (state.compressPreviewUrl) {
        URL.revokeObjectURL(state.compressPreviewUrl);
      }

      const url = URL.createObjectURL(blob);
      state.compressPreviewUrl = url;
      document.getElementById('compress-preview').src = url;
      document.getElementById('compress-preview-size').textContent = `Hasil: ${formatFileSize(blob.size)}`;
      state.compressedBlob = blob;

      // Calculate savings
      const savings = ((state.originalImageSize - blob.size) / state.originalImageSize * 100).toFixed(1);
      if (blob.size < state.originalImageSize) {
        document.getElementById('compress-preview-size').textContent += ` (hemat ${savings}%)`;
      }
    }
  }, mimeType, quality);
}

function downloadCompressedImage() {
  if (!state.compressedBlob) {
    showToast('Tidak ada gambar untuk didownload', 'error');
    return;
  }

  const format = document.getElementById('compress-format').value;
  const extension = format === 'jpeg' ? 'jpg' : format;
  downloadBlob(state.compressedBlob, getDownloadFilename({originalName: state.originalImageName, extension: extension}));
  showToast('Gambar berhasil dikompres!', 'success');
}

// ============================================================
// REMOVE BACKGROUND
// ============================================================

function updateRemoveBgPreview() {
  if (!state.originalImage) return;

  const threshold = parseInt(document.getElementById('remove-bg-threshold').value);

  // Update slider display
  document.getElementById('remove-bg-threshold-value').textContent = threshold;

  const canvas = document.getElementById('remove-bg-preview');
  const ctx = canvas.getContext('2d');

  // Set canvas size to match original image
  canvas.width = state.originalImage.naturalWidth;
  canvas.height = state.originalImage.naturalHeight;

  // Draw original image
  ctx.drawImage(state.originalImage, 0, 0);

  // Get image data
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  // Process each pixel - make white/near-white pixels transparent
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    // Check if pixel is white/near-white based on threshold
    // All RGB values must be >= threshold to be considered "white"
    if (r >= threshold && g >= threshold && b >= threshold) {
      data[i + 3] = 0; // Set alpha to 0 (transparent)
    }
  }

  // Put the modified image data back
  ctx.putImageData(imageData, 0, 0);

  // Store the canvas for download
  state.removeBgCanvas = canvas;
}

function downloadRemovedBgImage() {
  if (!state.removeBgCanvas) {
    showToast('Tidak ada gambar untuk didownload', 'error');
    return;
  }

  state.removeBgCanvas.toBlob((blob) => {
    if (blob) {
      downloadBlob(blob, getDownloadFilename({originalName: state.originalImageName, extension: 'png'}));
      showToast('Latar belakang berhasil dihapus!', 'success');
    }
  }, 'image/png');
}

// ============================================================
// RESIZE IMAGE
// ============================================================

function onResizeChange(changedField) {
  const lock = document.getElementById('resize-lock').checked;
  if (!lock || !state.originalWidth || !state.originalHeight) return;
  
  const aspectRatio = state.originalWidth / state.originalHeight;
  
  if (changedField === 'width') {
    const newWidth = parseInt(document.getElementById('resize-width').value) || 0;
    document.getElementById('resize-height').value = Math.round(newWidth / aspectRatio);
  } else {
    const newHeight = parseInt(document.getElementById('resize-height').value) || 0;
    document.getElementById('resize-width').value = Math.round(newHeight * aspectRatio);
  }
  
  updateResizeDimensions();
}

function applyResizePercent() {
  const percent = parseInt(document.getElementById('resize-percent').value);
  if (!percent || !state.originalWidth || !state.originalHeight) return;
  
  document.getElementById('resize-width').value = Math.round(state.originalWidth * percent / 100);
  document.getElementById('resize-height').value = Math.round(state.originalHeight * percent / 100);
  document.getElementById('resize-percent').value = '';
  
  updateResizeDimensions();
}

function updateResizeDimensions() {
  const width = document.getElementById('resize-width').value;
  const height = document.getElementById('resize-height').value;
  document.getElementById('resize-dimensions').textContent = `Dimensi: ${width} × ${height}`;
}

function downloadResizedImage() {
  const newWidth = parseInt(document.getElementById('resize-width').value);
  const newHeight = parseInt(document.getElementById('resize-height').value);
  
  if (!newWidth || !newHeight || !state.originalImage) {
    showToast('Masukkan dimensi yang valid', 'error');
    return;
  }
  
  const canvas = document.createElement('canvas');
  canvas.width = newWidth;
  canvas.height = newHeight;
  const ctx = canvas.getContext('2d');
  
  // Use better quality interpolation
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  
  ctx.drawImage(state.originalImage, 0, 0, newWidth, newHeight);
  
  // Determine format from original
  const ext = state.originalImageName.split('.').pop().toLowerCase();
  let mimeType = 'image/png';
  let extension = 'png';
  
  if (['jpg', 'jpeg'].includes(ext)) {
    mimeType = 'image/jpeg';
    extension = 'jpg';
  } else if (ext === 'webp') {
    mimeType = 'image/webp';
    extension = 'webp';
  }
  
  canvas.toBlob((blob) => {
    downloadBlob(blob, getDownloadFilename({originalName: state.originalImageName, extension: extension}));
    showToast('Gambar berhasil diubah ukurannya!', 'success');
  }, mimeType, 0.92);
}

// ============================================================
// CONVERT IMAGE FORMAT
// ============================================================

function convertImage() {
  if (!state.originalImage) {
    showToast('Tidak ada gambar untuk dikonversi', 'error');
    return;
  }
  
  const format = document.getElementById('convert-format').value;
  const quality = parseInt(document.getElementById('convert-quality').value) / 100;
  
  const canvas = document.createElement('canvas');
  canvas.width = state.originalImage.naturalWidth;
  canvas.height = state.originalImage.naturalHeight;
  const ctx = canvas.getContext('2d');
  
  // For PNG with transparency, fill white background for JPEG
  if (format === 'jpeg') {
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  
  ctx.drawImage(state.originalImage, 0, 0);
  
  const mimeType = `image/${format}`;
  const extension = format === 'jpeg' ? 'jpg' : format;
  
  canvas.toBlob((blob) => {
    downloadBlob(blob, getDownloadFilename({originalName: state.originalImageName, extension: extension}));
    showToast('Gambar berhasil dikonversi!', 'success');
  }, mimeType, quality);
}

// ============================================================
// IMAGES TO PDF
// ============================================================

async function addImagesToPDF(files) {
  const fileList = document.getElementById('img-pdf-file-list');

  // Clear placeholder and remove empty class
  if (state.imgToPdfFiles.length === 0) {
    fileList.innerHTML = '';
    fileList.classList.remove('empty');
  }
  
  for (const file of files) {
    if (!file.type.startsWith('image/')) {
      showToast(`${file.name} bukan file gambar`, 'error');
      continue;
    }
    
    try {
      const img = await loadImage(file);
      
      // Create thumbnail
      const canvas = document.createElement('canvas');
      const maxSize = 120;
      const ratio = Math.min(maxSize / img.naturalWidth, maxSize / img.naturalHeight);
      canvas.width = img.naturalWidth * ratio;
      canvas.height = img.naturalHeight * ratio;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      
      const fileItem = createImageFileItem(file.name, formatFileSize(file.size), canvas.toDataURL(), state.imgToPdfFiles.length);
      fileList.appendChild(fileItem);
      
      state.imgToPdfFiles.push({
        name: file.name,
        file: file,
        img: img
      });
      
    } catch (error) {
      console.error('Error processing image:', error);
      showToast(`Gagal memproses ${file.name}`, 'error');
    }
  }
  
  updateImgPdfAddButton();
  document.getElementById('img-pdf-btn').disabled = state.imgToPdfFiles.length === 0;
  enableDragReorder('img-pdf-file-list', state.imgToPdfFiles);
}

function createImageFileItem(name, size, thumbnail, index) {
  const div = document.createElement('div');
  div.className = 'file-item';
  div.dataset.index = index;
  div.draggable = true;

  // Escape HTML to prevent XSS
  const safeName = escapeHtml(name);
  const safeSize = escapeHtml(size);

  div.innerHTML = `
    <div class="file-item-preview">
      <img src="${thumbnail}" alt="preview">
    </div>
    <div class="file-item-info">
      <div class="file-item-name" title="${safeName}">${safeName}</div>
      <div class="file-item-size">${safeSize}</div>
    </div>
    <button class="file-item-remove">×</button>
  `;

  // Add click handler safely (avoid inline onclick with index)
  div.querySelector('.file-item-remove').addEventListener('click', () => removeImgPdfFile(index));

  return div;
}

function updateImgPdfAddButton() {
  const fileList = document.getElementById('img-pdf-file-list');
  const existing = fileList.querySelector('.add-file-btn');
  if (existing) existing.remove();
  
  const addBtn = document.createElement('button');
  addBtn.className = 'add-file-btn';
  addBtn.innerHTML = `
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 5v14M5 12h14"/>
    </svg>
    <span>Tambah Gambar</span>
  `;
  addBtn.onclick = () => document.getElementById('img-pdf-input').click();
  fileList.appendChild(addBtn);
}

function removeImgPdfFile(index) {
  state.imgToPdfFiles.splice(index, 1);
  refreshImgPdfList();
}

function refreshImgPdfList() {
  const fileList = document.getElementById('img-pdf-file-list');
  fileList.innerHTML = '';

  if (state.imgToPdfFiles.length === 0) {
    fileList.innerHTML = '<p style="color: var(--text-tertiary); width: 100%; text-align: center;">Seret gambar ke sini atau gunakan tombol di bawah</p>';
    document.getElementById('img-pdf-btn').disabled = true;
    return;
  }

  // Use for loop to maintain order (synchronous since we're just drawing to canvas)
  for (let i = 0; i < state.imgToPdfFiles.length; i++) {
    const imgFile = state.imgToPdfFiles[i];
    const canvas = document.createElement('canvas');
    const maxSize = 120;
    const ratio = Math.min(maxSize / imgFile.img.naturalWidth, maxSize / imgFile.img.naturalHeight);
    canvas.width = imgFile.img.naturalWidth * ratio;
    canvas.height = imgFile.img.naturalHeight * ratio;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(imgFile.img, 0, 0, canvas.width, canvas.height);

    const fileItem = createImageFileItem(imgFile.name, '', canvas.toDataURL(), i);
    const addBtn = fileList.querySelector('.add-file-btn');
    if (addBtn) {
      fileList.insertBefore(fileItem, addBtn);
    } else {
      fileList.appendChild(fileItem);
    }
  }

  updateImgPdfAddButton();
  document.getElementById('img-pdf-btn').disabled = state.imgToPdfFiles.length === 0;
  enableDragReorder('img-pdf-file-list', state.imgToPdfFiles);
}

async function imagesToPDF() {
  if (state.imgToPdfFiles.length === 0) return;
  
  const pageSize = document.getElementById('img-pdf-size').value;
  const orientation = document.getElementById('img-pdf-orientation').value;
  
  const progress = document.getElementById('img-pdf-progress');
  const progressFill = progress.querySelector('.progress-fill');
  const progressText = progress.querySelector('.progress-text');
  
  progress.classList.remove('hidden');
  document.getElementById('img-pdf-btn').disabled = true;
  
  try {
    const pdfDoc = await PDFLib.PDFDocument.create();
    
    // Page dimensions
    const pageSizes = {
      a4: { width: 595.28, height: 841.89 },
      letter: { width: 612, height: 792 }
    };
    
    for (let i = 0; i < state.imgToPdfFiles.length; i++) {
      progressText.textContent = `Memproses gambar ${i + 1} dari ${state.imgToPdfFiles.length}...`;
      progressFill.style.width = `${((i + 1) / state.imgToPdfFiles.length) * 100}%`;
      
      const imgFile = state.imgToPdfFiles[i];
      const img = imgFile.img;
      
      // Get image bytes
      const imgBytes = await fetch(img.src).then(res => res.arrayBuffer());
      
      let embeddedImg;
      const fileType = imgFile.file.type;
      
      if (fileType === 'image/png') {
        embeddedImg = await pdfDoc.embedPng(imgBytes);
      } else if (fileType === 'image/jpeg' || fileType === 'image/jpg') {
        embeddedImg = await pdfDoc.embedJpg(imgBytes);
      } else {
        // Convert to PNG for other formats
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const pngDataUrl = canvas.toDataURL('image/png');
        const pngBytes = await fetch(pngDataUrl).then(res => res.arrayBuffer());
        embeddedImg = await pdfDoc.embedPng(pngBytes);
      }
      
      let pageWidth, pageHeight;
      
      if (pageSize === 'fit') {
        // Page size matches image
        pageWidth = embeddedImg.width;
        pageHeight = embeddedImg.height;
      } else {
        const dimensions = pageSizes[pageSize];
        
        // Determine orientation
        let isLandscape = false;
        if (orientation === 'landscape') {
          isLandscape = true;
        } else if (orientation === 'auto') {
          isLandscape = embeddedImg.width > embeddedImg.height;
        }
        
        if (isLandscape) {
          pageWidth = dimensions.height;
          pageHeight = dimensions.width;
        } else {
          pageWidth = dimensions.width;
          pageHeight = dimensions.height;
        }
      }
      
      const page = pdfDoc.addPage([pageWidth, pageHeight]);
      
      // Calculate image position to fit and center
      let imgWidth = embeddedImg.width;
      let imgHeight = embeddedImg.height;
      
      if (pageSize !== 'fit') {
        const scale = Math.min(
          (pageWidth - 40) / imgWidth,
          (pageHeight - 40) / imgHeight
        );
        imgWidth *= scale;
        imgHeight *= scale;
      }
      
      const x = (pageWidth - imgWidth) / 2;
      const y = (pageHeight - imgHeight) / 2;
      
      page.drawImage(embeddedImg, {
        x,
        y,
        width: imgWidth,
        height: imgHeight,
      });
    }
    
    progressText.textContent = 'Menyimpan PDF...';
    const pdfBytes = await pdfDoc.save();

    downloadBlob(new Blob([pdfBytes], { type: 'application/pdf' }), getDownloadFilename({originalName: state.imgToPdfFiles[0]?.name, extension: 'pdf'}));
    showToast('PDF berhasil dibuat!', 'success');
    
  } catch (error) {
    console.error('Error creating PDF from images:', error);
    showToast('Gagal membuat PDF', 'error');
  } finally {
    progress.classList.add('hidden');
    document.getElementById('img-pdf-btn').disabled = false;
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
      ueDownload();
    }
  }

  // Ctrl+Z for undo in unified editor
  if (key === 'z' && (e.ctrlKey || e.metaKey) && state.currentTool === 'unified-editor') {
    e.preventDefault();
    ueUndoAnnotation();
  }

  // Ctrl+Y for redo in unified editor
  if (key === 'y' && (e.ctrlKey || e.metaKey) && state.currentTool === 'unified-editor') {
    e.preventDefault();
    ueRedoAnnotation();
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

// Hook into existing ueRenderSelectedPage to update mobile UI
const originalUeRenderSelectedPage = typeof ueRenderSelectedPage === 'function' ? ueRenderSelectedPage : null;

// We need to hook into when pages change to update mobile UI
// This is done by patching ueSelectPage after it's defined
