/*
 * PDFLokal - img-to-pdf.js (ES Module)
 * Images-to-PDF conversion tool: add images, reorder, generate PDF
 */

import { state } from './lib/state.js';
import {
  showToast, formatFileSize, downloadBlob,
  getDownloadFilename, loadImage, escapeHtml, isImage
} from './lib/utils.js';
import { enableDragReorder } from './pdf-tools/drag-reorder.js';
import { track } from './lib/analytics.js';

// ============================================================
// IMAGES TO PDF
// ============================================================

// WHY: Button disable has TOCTOU gap — double-click before first tick can start
// two concurrent PDF builds. Flag guard prevents this.
let isGenerating = false;

// SINGLE SOURCE OF TRUTH — thumbnail canvas from an Image element.
// Used by addImagesToPDF and refreshImgPdfList (was duplicated in both).
function createThumbnailDataUrl(img, maxSize = 120) {
  const canvas = document.createElement('canvas');
  const ratio = Math.min(maxSize / img.naturalWidth, maxSize / img.naturalHeight);
  canvas.width = img.naturalWidth * ratio;
  canvas.height = img.naturalHeight * ratio;
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL();
}

async function addImagesToPDF(files) {
  const fileList = document.getElementById('img-pdf-file-list');

  // Clear placeholder and remove empty class
  if (state.imgToPdfFiles.length === 0) {
    fileList.innerHTML = '';
    fileList.classList.remove('empty');
  }

  for (const file of files) {
    if (!isImage(file)) {
      showToast(`${file.name} bukan file gambar`, 'error');
      continue;
    }

    try {
      const img = await loadImage(file);

      const fileItem = createImageFileItem(file.name, formatFileSize(file.size), createThumbnailDataUrl(img), state.imgToPdfFiles.length);
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
    <button class="file-item-remove">\u00d7</button>
  `;

  // WHY: Read dataset.index at click time (not closure capture) so drag-reorder
  // doesn't cause the wrong item to be deleted.
  div.querySelector('.file-item-remove').addEventListener('click', () => {
    removeImgPdfFile(parseInt(div.dataset.index, 10));
  });

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
    const fileItem = createImageFileItem(imgFile.name, '', createThumbnailDataUrl(imgFile.img), i);
    const addBtnEl = fileList.querySelector('.add-file-btn');
    if (addBtnEl) {
      addBtnEl.before(fileItem);
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
  if (isGenerating) return;
  isGenerating = true;

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

      // WHY: file.arrayBuffer() reads from the original File object directly.
      // Previous fetch(img.src) did an unnecessary round-trip through a blob URL.
      const imgBytes = await imgFile.file.arrayBuffer();

      // WHY: Embed-by-type logic is similar to convertImageToPdf() in utils.js,
      // but this function adds page sizing/orientation/centering on top.
      // Extracting a shared helper is deferred — the page-layout logic is tightly coupled.
      let embeddedImg;
      const fileType = imgFile.file.type;

      if (fileType === 'image/png') {
        embeddedImg = await pdfDoc.embedPng(imgBytes);
      } else if (fileType === 'image/jpeg' || fileType === 'image/jpg') {
        embeddedImg = await pdfDoc.embedJpg(imgBytes);
      } else {
        // Convert to PNG for other formats (WebP, GIF, etc.)
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        const pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
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
    track('download', { tool: 'img-to-pdf' });
    showToast('PDF berhasil dibuat!', 'success');

  } catch (error) {
    console.error('Error creating PDF from images:', error);
    showToast('Gagal membuat PDF', 'error');
  } finally {
    isGenerating = false;
    progress.classList.add('hidden');
    document.getElementById('img-pdf-btn').disabled = false;
  }
}

// Exports
export { addImagesToPDF, imagesToPDF, refreshImgPdfList };

// Window bridges (for HTML onclick handlers)
window.addImagesToPDF = addImagesToPDF;
window.imagesToPDF = imagesToPDF;
window.refreshImgPdfList = refreshImgPdfList;
