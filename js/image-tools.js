/*
 * ============================================================
 * PDFLokal - image-tools.js (ES Module)
 * Client-Side Image Processing Tools
 * ============================================================
 *
 * PURPOSE:
 *   All image manipulation tools: compress, resize, convert format,
 *   images-to-PDF, and background removal. Uses Canvas API exclusively.
 *
 * IMPORTS:
 *   - state from lib/state.js
 *   - showToast, formatFileSize, downloadBlob, getDownloadFilename,
 *     loadImage, escapeHtml from lib/utils.js
 *
 * EXTERNAL GLOBALS (from non-module scripts):
 *   - enableDragReorder() from pdf-tools.js (via window)
 *   - PDFLib from vendor/pdf-lib.min.js (via window)
 *
 * ============================================================
 */

import { state } from './lib/state.js';
import {
  showToast,
  formatFileSize,
  downloadBlob,
  getDownloadFilename,
  loadImage,
  escapeHtml
} from './lib/utils.js';

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
  // enableDragReorder is from pdf-tools.js (still a global script)
  window.enableDragReorder('img-pdf-file-list', state.imgToPdfFiles);
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
    <button class="file-item-remove">\u00d7</button>
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
    const addBtnEl = fileList.querySelector('.add-file-btn');
    if (addBtnEl) {
      fileList.insertBefore(fileItem, addBtnEl);
    } else {
      fileList.appendChild(fileItem);
    }
  }

  updateImgPdfAddButton();
  document.getElementById('img-pdf-btn').disabled = state.imgToPdfFiles.length === 0;
  window.enableDragReorder('img-pdf-file-list', state.imgToPdfFiles);
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
        pageWidth = embeddedImg.width;
        pageHeight = embeddedImg.height;
      } else {
        const dimensions = pageSizes[pageSize];

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

// Exports
export {
  updateCompressPreview,
  downloadCompressedImage,
  updateRemoveBgPreview,
  downloadRemovedBgImage,
  onResizeChange,
  applyResizePercent,
  downloadResizedImage,
  convertImage,
  addImagesToPDF,
  imagesToPDF,
  refreshImgPdfList
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
window.addImagesToPDF = addImagesToPDF;
window.imagesToPDF = imagesToPDF;
window.refreshImgPdfList = refreshImgPdfList;
