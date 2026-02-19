/*
 * ============================================================
 * PDFLokal - js/lib/utils.js
 * Pure Utility Functions
 * ============================================================
 *
 * Stateless helpers used by multiple modules: toast, download,
 * file size formatting, image loading, etc.
 *
 * IMPORTS: state from ./state.js
 * LOAD ORDER: After state.js
 * ============================================================
 */

import { state, MAX_FILE_SIZE_WARNING, MAX_FILE_SIZE_LIMIT } from './state.js';

// ============================================================
// FILE SIZE
// ============================================================

export function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function checkFileSize(file) {
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
// FILENAMES
// ============================================================

// Generate output filename: [original]_[suffix].ext
export function getOutputFilename(suffix, ext = 'pdf', originalName = null) {
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
export function getDownloadFilename(options) {
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

// ============================================================
// DOWNLOAD
// ============================================================

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============================================================
// TOAST NOTIFICATIONS
// ============================================================

export function showToast(message, type = 'info') {
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

// ============================================================
// FULLSCREEN LOADING OVERLAY
// ============================================================

export function showFullscreenLoading(message = 'Memuat PDF...') {
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

export function hideFullscreenLoading() {
  const overlay = document.getElementById('fullscreen-loading-overlay');
  if (overlay) {
    overlay.style.display = 'none';
  }
}

// ============================================================
// IMAGE HELPERS
// ============================================================

export function loadImage(file) {
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

// Helper function to revoke blob URL from an image
export function cleanupImage(img) {
  if (img && img._blobUrl) {
    URL.revokeObjectURL(img._blobUrl);
    img._blobUrl = null;
  }
}

/**
 * Convert image file to single-page PDF
 * @param {File} imageFile - Image file to convert
 * @returns {Promise<Uint8Array>} PDF bytes
 */
export async function convertImageToPdf(imageFile) {
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

// ============================================================
// MISC HELPERS
// ============================================================

export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function debounce(fn, delay) {
  let timeoutId;
  return function(...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn.apply(this, args), delay);
  };
}

// Safe localStorage wrappers (prevents crash in private browsing / quota exceeded)
export function safeLocalGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function safeLocalSet(key, val) {
  try { localStorage.setItem(key, val); } catch { /* ignore */ }
}

// ============================================================
// CANVAS HELPERS
// ============================================================

/**
 * Make white/near-white pixels transparent on a canvas.
 * Used by: Remove Background tool, Signature background removal, Signature upload preview.
 */
export function makeWhiteTransparent(canvas, threshold = 240) {
  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] >= threshold && data[i + 1] >= threshold && data[i + 2] >= threshold) {
      data[i + 3] = 0;
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

/**
 * Set up a canvas for high-DPI rendering.
 * Scales canvas buffer by devicePixelRatio and applies ctx.scale().
 */
export function setupCanvasDPR(canvas) {
  const ratio = Math.max(window.devicePixelRatio || 1, 1);
  canvas.width = canvas.offsetWidth * ratio;
  canvas.height = canvas.offsetHeight * ratio;
  canvas.getContext('2d').scale(ratio, ratio);
  return ratio;
}

// ============================================================
// WINDOW BRIDGE (for non-module scripts and onclick handlers)
// ============================================================

window.formatFileSize = formatFileSize;
window.checkFileSize = checkFileSize;
window.getOutputFilename = getOutputFilename;
window.getDownloadFilename = getDownloadFilename;
window.downloadBlob = downloadBlob;
window.showToast = showToast;
window.showFullscreenLoading = showFullscreenLoading;
window.hideFullscreenLoading = hideFullscreenLoading;
window.loadImage = loadImage;
window.cleanupImage = cleanupImage;
window.convertImageToPdf = convertImageToPdf;
window.escapeHtml = escapeHtml;
window.sleep = sleep;
window.debounce = debounce;
window.safeLocalGet = safeLocalGet;
window.safeLocalSet = safeLocalSet;
