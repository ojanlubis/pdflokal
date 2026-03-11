/*
 * ============================================================
 * PDFLokal - image-tools.js (ES Module)
 * Client-Side Image Processing Tools
 * ============================================================
 *
 * PURPOSE:
 *   Image manipulation tools: compress, resize, convert format,
 *   and background removal. Uses Canvas API exclusively.
 *   Images-to-PDF tool lives in img-to-pdf.js (re-exported here).
 *
 * IMPORTS:
 *   - state from lib/state.js
 *   - showToast, formatFileSize, downloadBlob, getDownloadFilename
 *     from lib/utils.js
 *
 * EXTERNAL GLOBALS (from non-module scripts):
 *   - PDFLib from vendor/pdf-lib.min.js (via window)
 *
 * ============================================================
 */

import { state } from './lib/state.js';
import { track } from './lib/analytics.js';
import {
  showToast,
  formatFileSize,
  downloadBlob,
  getDownloadFilename,
  makeWhiteTransparent
} from './lib/utils.js';

// Re-export img-to-pdf functions so existing importers don't break
export { addImagesToPDF, imagesToPDF, refreshImgPdfList } from './img-to-pdf.js';

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
  track('download', { tool: 'compress-img' });
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

  // Make white/near-white pixels transparent
  makeWhiteTransparent(canvas, threshold);

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
      track('download', { tool: 'remove-bg' });
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
    if (!blob) { showToast('Gagal membuat gambar. Coba ukuran lebih kecil.', 'error'); return; }
    downloadBlob(blob, getDownloadFilename({originalName: state.originalImageName, extension: extension}));
    track('download', { tool: 'resize-img' });
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
    if (!blob) { showToast('Gagal mengonversi gambar.', 'error'); return; }
    downloadBlob(blob, getDownloadFilename({originalName: state.originalImageName, extension: extension}));
    track('download', { tool: 'convert-img' });
    showToast('Gambar berhasil dikonversi!', 'success');
  }, mimeType, quality);
}

// Exports
export {
  updateCompressPreview,
  downloadCompressedImage,
  updateRemoveBgPreview,
  downloadRemovedBgImage,
  onResizeChange,
  applyResizePercent,
  downloadResizedImage,
  convertImage
};

// Window bridges (for HTML onclick handlers)
window.updateCompressPreview = updateCompressPreview;
window.downloadCompressedImage = downloadCompressedImage;
window.updateRemoveBgPreview = updateRemoveBgPreview;
window.downloadRemovedBgImage = downloadRemovedBgImage;
window.onResizeChange = onResizeChange;
window.applyResizePercent = applyResizePercent;
window.downloadResizedImage = downloadResizedImage;
window.convertImage = convertImage;
