/*
 * PDFLokal - init.js (ES Module)
 * Main entry point: app bootstrap, dropzone, tool cards, file handling
 *
 * This is the single <script type="module"> entry point.
 * All other modules are loaded via import.
 */

// Shared foundations
import { state, mobileState, ueState, uePmState } from './lib/state.js';
import {
  showToast, showFullscreenLoading, hideFullscreenLoading,
  formatFileSize, checkFileSize, loadImage, debounce
} from './lib/utils.js';
import {
  showTool, showHome, pushWorkspaceState, initNavigationHistory
} from './lib/navigation.js';

// Feature modules (side-effect imports — set up window bridges on load)
import './theme.js';
import './changelog.js';
import './pdf-tools/index.js';
import './editor/index.js';
import './image-tools.js';

// Editor functions used directly
import {
  initUnifiedEditor, ueAddFiles,
  uePmOpenModal, uePmToggleExtractMode
} from './editor/index.js';

// PDF tools functions used directly
import { renderPdfImgPages, showPDFPreview, loadSignatureImage } from './pdf-tools/index.js';

// Image tools functions used directly
import { addImagesToPDF, updateCompressPreview, updateRemoveBgPreview } from './image-tools.js';

// New modules
import { setupKeyboardShortcuts } from './keyboard.js';
import { initMobileEditorEnhancements, ueMobileUpdatePageIndicator } from './mobile-ui.js';

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
// MOBILE DETECTION
// ============================================================

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

// ============================================================
// INITIALIZATION
// ============================================================

function initApp() {
  checkBrowserCompatibility();
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
  setupKeyboardShortcuts();
  initNavigationHistory();
}

// Modules execute after DOM parsing — readyState is 'interactive' or later
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}

// ============================================================
// DROPZONE
// ============================================================

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

// ============================================================
// TOOL CARDS
// ============================================================

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

// Merge/Split PDF cards (bypasses showTool — keeps home visible during file picking)
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
        const filesArray = Array.from(e.target.files);
        input.value = '';

        showFullscreenLoading('Memuat PDF...');

        try {
          const workspace = document.getElementById('unified-editor-workspace');
          if (workspace) {
            initUnifiedEditor();
            await ueAddFiles(filesArray);

            document.getElementById('home-view').style.display = 'none';
            workspace.classList.add('active');
            state.currentTool = 'unified-editor';
            window.scrollTo(0, 0);
            pushWorkspaceState('unified-editor');

            if (mobileState.isMobile || mobileState.isTouch) {
              initMobileEditorEnhancements();
              ueMobileUpdatePageIndicator();
            }

            uePmOpenModal();

            setTimeout(() => {
              if (mode === 'split' && !uePmState.extractMode) {
                uePmToggleExtractMode();
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
  input.click();
}

// ============================================================
// FILE INPUTS
// ============================================================

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
  document.querySelectorAll('.drop-hint, .workspace .dropzone, .preview-area .dropzone, .page-grid .dropzone, .file-list .dropzone').forEach(hint => {
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

  if (!checkFileSize(file)) return;

  const isPDF = file.type === 'application/pdf';
  const isImage = file.type.startsWith('image/');

  if (!isPDF && !isImage) {
    showToast('File tidak didukung. Gunakan PDF, JPG, PNG, atau WebP.', 'error');
    return;
  }

  if (mobileState.isMobile && isImage && !isPDF) {
    showToast('Di perangkat mobile, gunakan tool khusus gambar untuk memproses gambar.', 'info');
    return;
  }

  showFullscreenLoading(isPDF ? 'Memuat PDF...' : 'Memuat gambar...');

  try {
    if (!state.currentTool) {
      if (isPDF) {
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

    state.currentPDF = await pdfjsLib.getDocument({ data: state.currentPDFBytes.slice() }).promise;

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
// Window bridges (for functions called from other modules via window.*)
// ============================================================

window.handleDroppedFiles = handleDroppedFiles;
window.loadPDFForTool = loadPDFForTool;
window.loadImageForTool = loadImageForTool;
window.detectMobile = detectMobile;
