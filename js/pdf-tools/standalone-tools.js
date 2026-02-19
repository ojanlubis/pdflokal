/*
 * PDFLokal - pdf-tools/standalone-tools.js (ES Module)
 * Standalone PDF workspace tools + legacy editor
 *
 * Contains: Merge, Split, Rotate, Pages/Reorder, PDF-to-Image,
 *           Compress, Protect, Legacy Editor (initEditMode through saveEditedPDF)
 */

import { state } from '../lib/state.js';
import {
  showToast,
  formatFileSize,
  downloadBlob,
  getDownloadFilename,
  escapeHtml,
  sleep
} from '../lib/utils.js';
import { enableDragReorder } from './drag-reorder.js';
import { openTextModal } from './text-modal.js';
import { openSignatureModal } from './signature-modal.js';

// ============================================================
// STANDALONE MERGE PDF
// ============================================================

export async function addMergeFiles(files) {
  const fileList = document.getElementById('merge-file-list');

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

  updateMergeAddButton();
  document.getElementById('merge-btn').disabled = state.mergeFiles.length < 2;
  enableDragReorder('merge-file-list', state.mergeFiles);
}

function createFileItem(name, size, thumbnail, index) {
  const div = document.createElement('div');
  div.className = 'file-item';
  div.dataset.index = index;
  div.draggable = true;

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

export async function refreshMergeList() {
  const fileList = document.getElementById('merge-file-list');
  fileList.innerHTML = '';

  if (state.mergeFiles.length === 0) {
    fileList.innerHTML = '<p style="color: var(--text-tertiary); width: 100%; text-align: center;">Seret file PDF ke sini atau gunakan tombol di bawah</p>';
    document.getElementById('merge-btn').disabled = true;
    return;
  }

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
      const addBtnEl = fileList.querySelector('.add-file-btn');
      if (addBtnEl) {
        fileList.insertBefore(fileItem, addBtnEl);
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

export async function mergePDFs() {
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

export async function renderSplitPages() {
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
      <div class="page-item-checkbox">\u2713</div>
    `;

    pageItem.querySelector('canvas').replaceWith(canvas);
    container.appendChild(pageItem);

    state.splitPages.push({ page: i, selected: false });
  }

  document.getElementById('split-mode').onchange = (e) => {
    const rangeInput = document.getElementById('split-range-input');
    rangeInput.style.display = e.target.value === 'range' ? 'flex' : 'none';
  };
}

export function togglePageSelection(element, pageNum, tool) {
  element.classList.toggle('selected');

  if (tool === 'split') {
    const page = state.splitPages.find(p => p.page === pageNum);
    if (page) page.selected = !page.selected;
  } else if (tool === 'pdf-img') {
    const page = state.pdfImgPages.find(p => p.page === pageNum);
    if (page) page.selected = !page.selected;
  }
}

export function selectAllPages() {
  const container = document.getElementById('split-pages');
  container.querySelectorAll('.page-item').forEach(item => {
    item.classList.add('selected');
  });
  state.splitPages.forEach(p => p.selected = true);
}

export function deselectAllPages() {
  const container = document.getElementById('split-pages');
  container.querySelectorAll('.page-item').forEach(item => {
    item.classList.remove('selected');
  });
  state.splitPages.forEach(p => p.selected = false);
}

export async function splitPDF() {
  const mode = document.getElementById('split-mode').value;
  const progress = document.getElementById('split-progress');
  const progressFill = progress.querySelector('.progress-fill');
  const progressText = progress.querySelector('.progress-text');
  const splitBtn = document.getElementById('split-btn');

  const cleanup = () => {
    progress.classList.add('hidden');
    splitBtn.disabled = false;
  };

  progress.classList.remove('hidden');
  splitBtn.disabled = true;

  try {
    const srcDoc = await PDFLib.PDFDocument.load(state.currentPDFBytes);

    if (mode === 'each') {
      for (let i = 0; i < srcDoc.getPageCount(); i++) {
        progressText.textContent = `Memproses halaman ${i + 1}...`;
        progressFill.style.width = `${((i + 1) / srcDoc.getPageCount()) * 100}%`;

        const newDoc = await PDFLib.PDFDocument.create();
        const [page] = await newDoc.copyPages(srcDoc, [i]);
        newDoc.addPage(page);
        const bytes = await newDoc.save();

        downloadBlob(new Blob([bytes], { type: 'application/pdf' }), getDownloadFilename({originalName: state.currentPDFName, suffix: `page${i + 1}`, extension: 'pdf'}));
        await sleep(100);
      }

      showToast('Semua halaman berhasil dipisah!', 'success');

    } else if (mode === 'range') {
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

export async function renderRotatePages() {
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
      <div class="page-item-checkbox">\u2713</div>
    `;

    pageItem.querySelector('canvas').replaceWith(canvas);
    container.appendChild(pageItem);

    state.rotatePages.push({ page: i, rotation: 0, canvas });
  }
}

export function rotateSelected(degrees) {
  const container = document.getElementById('rotate-pages');
  const selected = container.querySelectorAll('.page-item.selected');

  selected.forEach(item => {
    const pageNum = parseInt(item.dataset.page);
    const pageState = state.rotatePages.find(p => p.page === pageNum);
    if (pageState) {
      pageState.rotation = ((pageState.rotation + degrees) % 360 + 360) % 360;
      const canvas = item.querySelector('canvas');
      canvas.style.transform = `rotate(${pageState.rotation}deg)`;
    }
  });
}

export function rotateAll(degrees) {
  state.rotatePages.forEach(pageState => {
    pageState.rotation = ((pageState.rotation + degrees) % 360 + 360) % 360;
  });

  const container = document.getElementById('rotate-pages');
  container.querySelectorAll('.page-item canvas').forEach((canvas, i) => {
    canvas.style.transform = `rotate(${state.rotatePages[i].rotation}deg)`;
  });
}

export async function saveRotatedPDF() {
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

export async function renderPagesGrid() {
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
      <div class="page-item-checkbox">\u2713</div>
      <button class="file-item-remove" onclick="event.stopPropagation(); deletePageFromGrid(${i})">\u00d7</button>
    `;

    pageItem.querySelector('canvas').replaceWith(canvas);
    container.appendChild(pageItem);

    state.pagesOrder.push(i);
  }

  enableDragReorder('pages-grid', state.pagesOrder, true);
}

export function deletePageFromGrid(pageNum) {
  const index = state.pagesOrder.indexOf(pageNum);
  if (index > -1) {
    state.pagesOrder.splice(index, 1);
    const container = document.getElementById('pages-grid');
    const item = container.querySelector(`[data-page="${pageNum}"]`);
    if (item) item.remove();

    container.querySelectorAll('.page-item').forEach((item, i) => {
      item.querySelector('.page-item-number').textContent = i + 1;
    });
  }

  if (state.pagesOrder.length === 0) {
    document.getElementById('pages-btn').disabled = true;
  }
}

export function deleteSelectedPages() {
  const container = document.getElementById('pages-grid');
  const selected = container.querySelectorAll('.page-item.selected');

  selected.forEach(item => {
    const pageNum = parseInt(item.dataset.page);
    deletePageFromGrid(pageNum);
  });
}

export async function saveReorderedPDF() {
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
// PDF TO IMAGE
// ============================================================

export async function renderPdfImgPages() {
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
      <div class="page-item-checkbox">\u2713</div>
    `;

    pageItem.querySelector('canvas').replaceWith(canvas);
    container.appendChild(pageItem);

    state.pdfImgPages.push({ page: i, selected: true });
  }
}

export function selectAllPdfImgPages() {
  const container = document.getElementById('pdf-img-pages');
  container.querySelectorAll('.page-item').forEach(item => item.classList.add('selected'));
  state.pdfImgPages.forEach(p => p.selected = true);
}

export async function convertPDFtoImages() {
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

export async function showPDFPreview(containerId) {
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

export async function compressPDF() {
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
      await sleep(50);
    }

    progressText.textContent = 'Mengoptimasi struktur PDF...';

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

export async function protectPDF() {
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

  protectBtn.disabled = true;
  protectBtn.innerHTML = `
    <svg class="btn-spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 2v4m0 12v4m-7.07-3.93l2.83-2.83m8.48-8.48l2.83-2.83M2 12h4m12 0h4m-3.93 7.07l-2.83-2.83M7.76 7.76L4.93 4.93"/>
    </svg>
    Memproses...
  `;

  try {
    const srcDoc = await PDFLib.PDFDocument.load(state.currentPDFBytes);
    const pdfBytes = await srcDoc.save();

    const encryptedBytes = await window.encryptPDF(
      new Uint8Array(pdfBytes),
      password,
      password
    );

    downloadBlob(new Blob([encryptedBytes], { type: 'application/pdf' }), getDownloadFilename({originalName: state.currentPDFName, extension: 'pdf'}));
    showToast('PDF berhasil diproteksi!', 'success');

  } catch (error) {
    console.error('Error protecting PDF:', error);
    showToast('Gagal memproteksi PDF', 'error');
  } finally {
    protectBtn.disabled = false;
    protectBtn.innerHTML = originalText;
  }
}

// ============================================================
// LEGACY EDITOR (shared annotation tools)
// ============================================================

// Cached PDF page image for smooth dragging
let editPageCache = null;

export async function initEditMode() {
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

  setupEditKeyboardShortcuts();
  await renderEditPage();
  setupEditCanvas();
  updateEditorStatus('Pilih alat untuk mulai mengedit');
}

export async function renderEditPage() {
  const canvas = document.getElementById('edit-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = state.editDevicePixelRatio;

  const page = await state.currentPDF.getPage(state.currentEditPage + 1);

  const wrapper = document.querySelector('.editor-canvas-wrapper');
  const maxWidth = wrapper ? wrapper.clientWidth - 40 : 800;
  const naturalViewport = page.getViewport({ scale: 1 });

  let scale = Math.min(maxWidth / naturalViewport.width, 2);
  scale = Math.max(scale, 1);

  const viewport = page.getViewport({ scale });

  state.editPageScales[state.currentEditPage] = {
    scale: scale,
    pdfWidth: naturalViewport.width,
    pdfHeight: naturalViewport.height,
    canvasWidth: viewport.width,
    canvasHeight: viewport.height
  };

  canvas.width = viewport.width * dpr;
  canvas.height = viewport.height * dpr;
  canvas.style.width = viewport.width + 'px';
  canvas.style.height = viewport.height + 'px';

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  await page.render({ canvasContext: ctx, viewport }).promise;

  editPageCache = ctx.getImageData(0, 0, canvas.width, canvas.height);
  redrawAnnotationsOnly();

  document.getElementById('edit-page-info').textContent =
    `Halaman ${state.currentEditPage + 1} dari ${state.currentPDF.numPages}`;

  document.getElementById('edit-prev').disabled = state.currentEditPage === 0;
  document.getElementById('edit-next').disabled = state.currentEditPage === state.currentPDF.numPages - 1;
}

function redrawAnnotationsOnly() {
  const canvas = document.getElementById('edit-canvas');
  const ctx = canvas.getContext('2d');

  if (editPageCache) {
    ctx.putImageData(editPageCache, 0, 0);
  }

  ctx.setTransform(state.editDevicePixelRatio, 0, 0, state.editDevicePixelRatio, 0, 0);

  const annotations = state.editAnnotations[state.currentEditPage] || [];
  for (let i = 0; i < annotations.length; i++) {
    const anno = annotations[i];
    const isSelected = state.selectedAnnotation &&
                       state.selectedAnnotation.pageNum === state.currentEditPage &&
                       state.selectedAnnotation.index === i;
    drawAnnotationSync(ctx, anno, isSelected);
  }
}

export function drawAnnotationSync(ctx, anno, isSelected = false) {
  switch (anno.type) {
    case 'whiteout':
      ctx.fillStyle = 'white';
      ctx.fillRect(anno.x, anno.y, anno.width, anno.height);
      if (isSelected) {
        drawSelectionHandles(ctx, anno.x, anno.y, anno.width, anno.height);
      }
      break;
    case 'text': {
      let textFontStyle = '';
      if (anno.italic) textFontStyle += 'italic ';
      if (anno.bold) textFontStyle += 'bold ';

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
    }
    case 'signature':
      if (anno.image) {
        if (!anno.cachedImg) {
          const img = new Image();
          img.src = anno.image;
          anno.cachedImg = img;
        }
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
      if (anno.position.includes('center')) {
        ctx.textAlign = 'center';
      } else if (anno.position.includes('right')) {
        ctx.textAlign = 'right';
      } else {
        ctx.textAlign = 'left';
      }
      ctx.fillText(anno.text, anno.x, anno.y);
      ctx.textAlign = 'left';
      break;
  }
}

export function drawAnnotation(ctx, anno, isSelected = false) {
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
      case 'text': {
        ctx.font = `${anno.fontSize}px Arial`;
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
        resolve();
        break;
      }
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

export function drawSelectionHandles(ctx, x, y, width, height) {
  ctx.strokeStyle = '#3B82F6';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 3]);
  ctx.strokeRect(x - 2, y - 2, width + 4, height + 4);
  ctx.setLineDash([]);

  const handleSize = 8;
  ctx.fillStyle = '#3B82F6';

  ctx.fillRect(x - handleSize/2 - 2, y - handleSize/2 - 2, handleSize, handleSize);
  ctx.fillRect(x + width - handleSize/2 + 2, y - handleSize/2 - 2, handleSize, handleSize);
  ctx.fillRect(x - handleSize/2 - 2, y + height - handleSize/2 + 2, handleSize, handleSize);
  ctx.fillRect(x + width - handleSize/2 + 2, y + height - handleSize/2 + 2, handleSize, handleSize);
}

function getCanvasCoordinates(e, canvas) {
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (canvas.width / canvas.clientWidth / state.editDevicePixelRatio);
  const y = (e.clientY - rect.top) * (canvas.height / canvas.clientHeight / state.editDevicePixelRatio);
  return { x, y };
}

function setupEditCanvas() {
  if (state.editCanvasSetup) return;

  const canvas = document.getElementById('edit-canvas');
  if (!canvas) return;

  state.editCanvasSetup = true;

  let isDrawing = false;
  let isDragging = false;
  let isResizing = false;
  let startX, startY;
  let dragOffsetX, dragOffsetY;

  canvas.addEventListener('mousedown', (e) => handlePointerDown(e, canvas));
  canvas.addEventListener('mousemove', (e) => handlePointerMove(e, canvas));
  canvas.addEventListener('mouseup', (e) => handlePointerUp(e, canvas));
  canvas.addEventListener('mouseleave', () => { isDrawing = false; isDragging = false; });

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

    if (state.currentEditTool === 'select') {
      const clickedAnno = findAnnotationAt(x, y);
      if (clickedAnno) {
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

    if (isDragging && state.selectedAnnotation) {
      const anno = state.editAnnotations[state.selectedAnnotation.pageNum][state.selectedAnnotation.index];
      if (anno.type === 'text') {
        anno.x = x - dragOffsetX;
        anno.y = y - dragOffsetY + anno.fontSize;
      } else {
        anno.x = x - dragOffsetX;
        anno.y = y - dragOffsetY;
      }
      redrawAnnotationsOnly();
      return;
    }

    if (!isDrawing || state.currentEditTool !== 'whiteout') return;

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

    if (isDragging) {
      isDragging = false;
      return;
    }

    if (!isDrawing) return;
    isDrawing = false;

    if (state.currentEditTool === 'whiteout') {
      const width = Math.abs(x - startX);
      const height = Math.abs(y - startY);
      if (width > 5 && height > 5) {
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
      const pageScale = state.editPageScales[state.currentEditPage];
      const sigWidth = Math.min(200, pageScale.canvasWidth * 0.3);
      const sigHeight = sigWidth / 2;

      const annotation = {
        type: 'signature',
        image: state.signatureImage,
        x: startX,
        y: startY,
        width: sigWidth,
        height: sigHeight
      };

      const img = new Image();
      img.onload = () => {
        annotation.cachedImg = img;
        renderEditPage();
        updateEditorStatus('Tanda tangan ditambahkan');
      };
      img.onerror = () => {
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
  for (let i = annotations.length - 1; i >= 0; i--) {
    const anno = annotations[i];
    let bounds;

    if (anno.type === 'whiteout' || anno.type === 'signature') {
      bounds = { x: anno.x, y: anno.y, width: anno.width, height: anno.height };
    } else if (anno.type === 'text') {
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

export function setEditTool(tool) {
  state.currentEditTool = tool;
  state.selectedAnnotation = null;

  document.querySelectorAll('.editor-tool-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.editTool === tool);
  });

  const canvas = document.getElementById('edit-canvas');
  if (canvas) {
    canvas.className = 'editor-canvas';
    if (tool) {
      canvas.classList.add(`tool-${tool}`);
    }
  }

  const messages = {
    'select': 'Klik anotasi untuk memilih, seret untuk memindahkan',
    'whiteout': 'Seret untuk menggambar area whiteout',
    'text': 'Klik di mana Anda ingin menambahkan teks',
    'signature': state.signatureImage ? 'Klik untuk menempatkan tanda tangan' : 'Buat tanda tangan terlebih dahulu'
  };
  updateEditorStatus(messages[tool] || 'Pilih alat untuk mulai mengedit');

  renderEditPage();
}

export function updateEditorStatus(message) {
  const statusEl = document.querySelector('#editor-status .status-text');
  if (statusEl) {
    statusEl.textContent = message;
  }
}

export function editPrevPage() {
  if (state.currentEditPage > 0) {
    state.selectedAnnotation = null;
    state.currentEditPage--;
    renderEditPage();
  }
}

export function editNextPage() {
  if (state.currentEditPage < state.currentPDF.numPages - 1) {
    state.selectedAnnotation = null;
    state.currentEditPage++;
    renderEditPage();
  }
}

export function saveUndoState() {
  const currentState = JSON.parse(JSON.stringify(state.editAnnotations));
  state.editUndoStack.push(currentState);
  state.editRedoStack = [];

  if (state.editUndoStack.length > 50) {
    state.editUndoStack.shift();
  }
}

export function undoEdit() {
  if (state.editUndoStack.length === 0) {
    showToast('Tidak ada yang bisa di-undo', 'info');
    return;
  }

  const currentState = JSON.parse(JSON.stringify(state.editAnnotations));
  state.editRedoStack.push(currentState);

  const previousState = state.editUndoStack.pop();

  for (const pageNum in previousState) {
    for (const anno of previousState[pageNum]) {
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

  state.editAnnotations = previousState;
  state.selectedAnnotation = null;
  renderEditPage();
  showToast('Undo berhasil', 'success');
}

export function redoEdit() {
  if (state.editRedoStack.length === 0) {
    showToast('Tidak ada yang bisa di-redo', 'info');
    return;
  }

  const currentState = JSON.parse(JSON.stringify(state.editAnnotations));
  state.editUndoStack.push(currentState);

  const nextState = state.editRedoStack.pop();

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

export function clearCurrentPageAnnotations() {
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

export function deleteSelectedAnnotation() {
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

function setupEditKeyboardShortcuts() {
  const handler = (e) => {
    const editWorkspace = document.getElementById('edit-pdf-workspace');
    if (!editWorkspace || editWorkspace.style.display === 'none') return;

    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undoEdit();
    }
    else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      e.preventDefault();
      redoEdit();
    }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedAnnotation) {
      e.preventDefault();
      deleteSelectedAnnotation();
    }
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
  state.editKeyboardHandler = handler;
}

export async function saveEditedPDF() {
  try {
    const srcDoc = await PDFLib.PDFDocument.load(state.currentPDFBytes);
    const pages = srcDoc.getPages();

    const fontCache = {};

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

      const pageScaleInfo = state.editPageScales[i];
      if (!pageScaleInfo && annotations.length > 0) {
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

      const scaleX = pdfWidth / scaleInfo.canvasWidth;
      const scaleY = pdfHeight / scaleInfo.canvasHeight;

      for (const anno of annotations) {
        if (anno.type === 'whiteout') {
          const pdfX = anno.x * scaleX;
          const pdfY = pdfHeight - (anno.y + anno.height) * scaleY;
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

          const textFont = await getTextFont(anno.fontFamily, anno.bold, anno.italic);

          const pdfX = anno.x * scaleX;
          const pdfY = pdfHeight - anno.y * scaleY;
          const pdfFontSize = anno.fontSize * scaleX;

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
            const isJpeg = anno.image.startsWith('data:image/jpeg');
            const signatureImage = isJpeg
              ? await srcDoc.embedJpg(anno.image)
              : await srcDoc.embedPng(anno.image);
            const pdfX = anno.x * scaleX;
            const pdfY = pdfHeight - (anno.y + anno.height) * scaleY;
            const pdfW = anno.width * scaleX;
            const pdfH = anno.height * scaleY;

            page.drawImage(signatureImage, {
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

          const textWidth = anno.text.length * pdfFontSize * 0.5;
          const font = await srcDoc.embedFont(PDFLib.StandardFonts.Helvetica);

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
          const font = await srcDoc.embedFont(PDFLib.StandardFonts.Helvetica);

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
