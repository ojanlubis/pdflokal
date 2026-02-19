/*
 * PDFLokal - pdf-tools/standalone-tools.js (ES Module)
 * Standalone PDF workspace tools: PDF-to-Image, Compress, Protect
 */

import { state } from '../lib/state.js';
import {
  showToast,
  downloadBlob,
  getDownloadFilename,
  sleep
} from '../lib/utils.js';

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

export function togglePageSelection(element, pageNum, tool) {
  element.classList.toggle('selected');

  if (tool === 'pdf-img') {
    const page = state.pdfImgPages.find(p => p.page === pageNum);
    if (page) page.selected = !page.selected;
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
