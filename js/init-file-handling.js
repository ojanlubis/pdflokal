/*
 * PDFLokal - init-file-handling.js (ES Module)
 * File input wiring, dropzone, drag hints, paste handler, and file routing
 */

import { state, mobileState } from './lib/state.js';
import {
  showToast, showFullscreenLoading, hideFullscreenLoading,
  formatFileSize, checkFileSize, loadImage,
  isPDF, isImage, loadPdfDocument
} from './lib/utils.js';
import { showTool } from './lib/navigation.js';
import { track } from './lib/analytics.js';

// WHY: These were static imports that forced browser to load entire editor (15 modules)
// + pdf-tools (7 modules) + image-tools before dropzone could be interactive.
// Now loaded on-demand inside handlers — dropzone works immediately on page load.
// Module cache ensures each import() resolves instantly after first load.

// ============================================================
// DROPZONE
// ============================================================

export function initDropZone() {
  const dropzone = document.getElementById('main-dropzone');
  const fileInput = document.getElementById('file-input');

  // WHY: click + keydown handlers are set by inline <script> in index.html
  // for instant interactivity. Only drag/drop + file change need module code.

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
// FILE INPUTS
// ============================================================

/**
 * Wire up a file input with loading overlay, error handling, and cleanup.
 * @param {string} inputId - DOM id of the <input type="file">
 * @param {object} opts
 * @param {string}   opts.loadingMsg  - Message for fullscreen loading overlay
 * @param {string}   opts.errorMsg    - Toast message on failure
 * @param {Function} opts.handler     - async (files) => void  — receives FileList or single File
 * @param {boolean}  [opts.allFiles]  - Pass entire FileList instead of first file (default false)
 */
function setupFileInput(inputId, { loadingMsg, errorMsg, handler, allFiles = false }) {
  const input = document.getElementById(inputId);
  if (!input) return;
  input.addEventListener('change', async (e) => {
    if (e.target.files.length === 0) return;
    // WHY: checkFileSize here (not in each handler) so ALL tool-specific
    // file inputs get the 20MB warning / 100MB hard limit for free.
    const firstFile = e.target.files[0];
    if (!checkFileSize(firstFile)) { e.target.value = ''; return; }
    showFullscreenLoading(loadingMsg);
    try {
      await handler(allFiles ? e.target.files : firstFile);
    } catch (error) {
      console.error(`Error: ${errorMsg}`, error);
      showToast(errorMsg, 'error');
    } finally {
      hideFullscreenLoading();
      e.target.value = '';
    }
  });
}

export function initFileInputs() {
  // PDF tools
  setupFileInput('compress-pdf-input', {
    loadingMsg: 'Memuat PDF...', errorMsg: 'Gagal memuat PDF',
    handler: (file) => loadPDFForTool(file, 'compress-pdf')
  });
  setupFileInput('pdf-img-input', {
    loadingMsg: 'Memuat PDF...', errorMsg: 'Gagal memuat PDF',
    handler: (file) => loadPDFForTool(file, 'pdf-to-img')
  });
  setupFileInput('protect-input', {
    loadingMsg: 'Memuat PDF...', errorMsg: 'Gagal memuat PDF',
    handler: (file) => loadPDFForTool(file, 'protect')
  });

  // Image tools
  setupFileInput('img-pdf-input', {
    loadingMsg: 'Memuat gambar...', errorMsg: 'Gagal memuat gambar',
    handler: async (files) => {
      const { addImagesToPDF } = await import('./image-tools.js');
      await addImagesToPDF(files);
    }, allFiles: true
  });
  setupFileInput('compress-img-input', {
    loadingMsg: 'Memuat gambar...', errorMsg: 'Gagal memuat gambar',
    handler: (file) => loadImageForTool(file, 'compress-img')
  });
  setupFileInput('resize-input', {
    loadingMsg: 'Memuat gambar...', errorMsg: 'Gagal memuat gambar',
    handler: (file) => loadImageForTool(file, 'resize')
  });
  setupFileInput('convert-input', {
    loadingMsg: 'Memuat gambar...', errorMsg: 'Gagal memuat gambar',
    handler: (file) => loadImageForTool(file, 'convert-img')
  });
  setupFileInput('remove-bg-input', {
    loadingMsg: 'Memuat gambar...', errorMsg: 'Gagal memuat gambar',
    handler: (file) => loadImageForTool(file, 'remove-bg')
  });

  // Signature upload
  setupFileInput('signature-upload-input', {
    loadingMsg: 'Memuat tanda tangan...', errorMsg: 'Gagal memuat tanda tangan',
    handler: async (file) => {
      const { loadSignatureImage } = await import('./pdf-tools/index.js');
      await loadSignatureImage(file);
    }
  });

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

    // WHY: div[role="button"] needs explicit keydown for Enter/Space activation.
    // Native <button> gets this for free, but dropzones are divs for drag-drop styling.
    if (hint.getAttribute('role') === 'button') {
      hint.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          hint.click();
        }
      });
    }
  });
}

// ============================================================
// FILE HANDLING
// ============================================================

// WHY: Rapid file drops can trigger concurrent loads that overwrite shared state
// (state.currentPDF, state.currentPDFBytes). Flag prevents re-entry.
let isProcessingDrop = false;

async function handleDroppedFiles(files) {
  if (!files || files.length === 0) return;
  if (isProcessingDrop) return;
  isProcessingDrop = true;

  const file = files[0];

  if (!checkFileSize(file)) return;

  const filePDF = isPDF(file);
  const fileImage = isImage(file);

  if (!filePDF && !fileImage) {
    showToast('File tidak didukung. Gunakan PDF, JPG, PNG, atau WebP.', 'error');
    return;
  }

  if (mobileState.isMobile && fileImage && !filePDF) {
    showToast('Di perangkat mobile, gunakan tool khusus gambar untuk memproses gambar.', 'info');
    return;
  }

  showFullscreenLoading(filePDF ? 'Memuat PDF...' : 'Memuat gambar...');

  try {
    if (!state.currentTool) {
      track('file_loaded', { tool: 'dropzone', fileType: filePDF ? 'pdf' : 'image' });
      if (filePDF) {
        const { ueAddFiles } = await import('./editor/index.js');
        showTool('unified-editor');
        await ueAddFiles(files);
      } else if (fileImage && files.length > 1) {
        const { addImagesToPDF } = await import('./image-tools.js');
        showTool('img-to-pdf');
        await addImagesToPDF(files);
      } else if (fileImage) {
        showTool('compress-img');
        await loadImageForTool(file, 'compress-img');
      }
    }
  } catch (error) {
    console.error('Error loading file:', error);
    showToast('Gagal memuat file', 'error');
  } finally {
    isProcessingDrop = false;
    hideFullscreenLoading();
  }
}

async function loadPDFForTool(file, tool) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    state.currentPDFBytes = new Uint8Array(arrayBuffer);
    state.currentPDFName = file.name;

    state.currentPDF = await loadPdfDocument(state.currentPDFBytes);

    const pdfTools = await import('./pdf-tools/index.js');
    switch (tool) {
      case 'pdf-to-img':
        await pdfTools.renderPdfImgPages();
        document.getElementById('pdf-img-btn').disabled = false;
        break;
      case 'compress-pdf':
        await pdfTools.showPDFPreview('compress-pdf-preview');
        document.getElementById('compress-pdf-btn').disabled = false;
        break;
      case 'protect':
        await pdfTools.showPDFPreview('protect-preview');
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

// DRY helper: hide hint element, show preview container
function showImageToolPreview(hintId, previewId) {
  const hint = document.getElementById(hintId);
  const preview = document.getElementById(previewId);
  if (hint) hint.classList.add('hidden');
  if (preview) preview.classList.remove('hidden');
}

async function loadImageForTool(file, tool) {
  try {
    state.originalImage = await loadImage(file);
    state.originalImageName = file.name;

    const imageTools = await import('./image-tools.js');
    switch (tool) {
      case 'compress-img':
        showImageToolPreview('compress-img-hint', 'compress-img-comparison');
        document.getElementById('compress-original').src = state.originalImage.src;
        document.getElementById('compress-original-size').textContent = `Original: ${formatFileSize(file.size)}`;
        state.originalImageSize = file.size;
        imageTools.updateCompressPreview();
        document.getElementById('compress-img-btn').disabled = false;
        break;
      case 'resize':
        showImageToolPreview('resize-hint', 'resize-preview-box');
        document.getElementById('resize-preview').src = state.originalImage.src;
        document.getElementById('resize-width').value = state.originalImage.naturalWidth;
        document.getElementById('resize-height').value = state.originalImage.naturalHeight;
        state.originalWidth = state.originalImage.naturalWidth;
        state.originalHeight = state.originalImage.naturalHeight;
        document.getElementById('resize-dimensions').textContent = `Dimensi: ${state.originalWidth} × ${state.originalHeight}`;
        document.getElementById('resize-btn').disabled = false;
        break;
      case 'convert-img': {
        showImageToolPreview('convert-hint', 'convert-preview-box');
        document.getElementById('convert-preview').src = state.originalImage.src;
        const ext = file.name.split('.').pop().toLowerCase();
        document.getElementById('convert-info').textContent = `Format saat ini: ${ext.toUpperCase()}`;
        document.getElementById('convert-btn').disabled = false;
        break;
      }
      case 'remove-bg':
        showImageToolPreview('remove-bg-hint', 'remove-bg-comparison');
        document.getElementById('remove-bg-original').src = state.originalImage.src;
        imageTools.updateRemoveBgPreview();
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

// WHY: Named function (not anonymous) so it can be removed if module is re-initialized.
async function handlePaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;

  for (const item of items) {
    // WHY: isImage() checks .type which exists on DataTransferItem too. Use SSOT helper.
    if (isImage(item)) {
      const file = item.getAsFile();
      if (file) {
        if (state.currentTool === 'img-to-pdf') {
          import('./image-tools.js').then(m => m.addImagesToPDF([file]));
        } else if (state.currentTool === 'compress-img' || state.currentTool === 'resize' || state.currentTool === 'convert-img' || state.currentTool === 'remove-bg') {
          loadImageForTool(file, state.currentTool);
        } else if (!state.currentTool) {
          showTool('compress-img');
          loadImageForTool(file, 'compress-img');
        }
      }
    }
  }
}
document.addEventListener('paste', handlePaste);

// ============================================================
// Window bridges (for functions called from HTML onclick handlers)
// ============================================================

window.handleDroppedFiles = handleDroppedFiles;
window.loadPDFForTool = loadPDFForTool;
window.loadImageForTool = loadImageForTool;
