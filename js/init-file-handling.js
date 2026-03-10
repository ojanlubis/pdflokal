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
import { ueAddFiles } from './editor/index.js';
import { renderPdfImgPages, showPDFPreview, loadSignatureImage } from './pdf-tools/index.js';
import { addImagesToPDF, updateCompressPreview, updateRemoveBgPreview } from './image-tools.js';

// ============================================================
// DROPZONE
// ============================================================

export function initDropZone() {
  const dropzone = document.getElementById('main-dropzone');
  const fileInput = document.getElementById('file-input');

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

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
    showFullscreenLoading(loadingMsg);
    try {
      await handler(allFiles ? e.target.files : e.target.files[0]);
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
    handler: (files) => addImagesToPDF(files), allFiles: true
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
    handler: (file) => loadSignatureImage(file)
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
  });
}

// ============================================================
// FILE HANDLING
// ============================================================

async function handleDroppedFiles(files) {
  if (!files || files.length === 0) return;

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
      if (filePDF) {
        showTool('unified-editor');
        await ueAddFiles(files);
      } else if (fileImage && files.length > 1) {
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
    hideFullscreenLoading();
  }
}

async function loadPDFForTool(file, tool) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    state.currentPDFBytes = new Uint8Array(arrayBuffer);
    state.currentPDFName = file.name;

    state.currentPDF = await loadPdfDocument(state.currentPDFBytes);

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
// Window bridges (for functions called from HTML onclick handlers)
// ============================================================

window.handleDroppedFiles = handleDroppedFiles;
window.loadPDFForTool = loadPDFForTool;
window.loadImageForTool = loadImageForTool;
