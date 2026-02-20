/*
 * PDFLokal - editor/file-loading.js (ES Module)
 * File input handling, PDF and image loading
 */

import { ueState, createPageInfo } from '../lib/state.js';
import { showToast, showFullscreenLoading, hideFullscreenLoading, checkFileSize, convertImageToPdf, isPDF, isImage, loadPdfDocument } from '../lib/utils.js';
import { ueCreatePageSlots, ueSelectPage, ueUpdatePageCount } from './page-rendering.js';
import { ueRenderThumbnails } from './sidebar.js';
import { ueSaveUndoState } from './undo-redo.js';

let isLoadingFiles = false;

export function initUnifiedEditorInput() {
  const input = document.getElementById('ue-file-input');
  if (input && !input._ueInitialized) {
    input._ueInitialized = true;
    input.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        showFullscreenLoading('Memuat PDF...');
        try {
          await ueAddFiles(e.target.files);
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
}

// Load files into unified editor
export async function ueAddFiles(files) {
  if (!files || files.length === 0) return;
  if (isLoadingFiles) {
    showToast('File sedang dimuat...', 'info');
    return;
  }

  isLoadingFiles = true;
  ueSaveUndoState();

  try {
  for (const file of files) {
    if (!isPDF(file) && !isImage(file)) {
      showToast(`File ${file.name} bukan PDF atau gambar. Diabaikan.`, 'warning');
      continue;
    }

    if (!checkFileSize(file)) continue;

    try {
      if (isPDF(file)) {
        await handlePdfFile(file);
      } else {
        await handleImageFile(file);
      }
    } catch (error) {
      console.error('Error loading file:', error);
      showToast(error.message || `Gagal memuat ${file.name}`, 'error');
    }
  }

  // Wait one frame for layout reflow (workspace may have just become visible)
  await new Promise(resolve => requestAnimationFrame(resolve));

  // Rebuild page slots for new page count
  ueCreatePageSlots();

  ueRenderThumbnails();
  ueUpdatePageCount();
  document.getElementById('ue-download-btn').disabled = false;

  // Auto-select first page if none selected
  if (ueState.selectedPage === -1 && ueState.pages.length > 0) {
    ueSelectPage(0);
    window.scrollTo(0, 0);
  }
  } finally {
    isLoadingFiles = false;
  }
}

// Handle PDF file loading
async function handlePdfFile(file) {
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  const sourceIndex = ueState.sourceFiles.length;
  const sourceName = file.name.replace('.pdf', '').substring(0, 15);

  ueState.sourceFiles.push({ name: file.name, bytes, numPages: 0 });

  const pdf = await loadPdfDocument(bytes);
  ueState.sourceFiles[sourceIndex].numPages = pdf.numPages;

  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1);
    const viewport = page.getViewport({ scale: 0.5 });

    // Render a small thumbnail canvas for sidebar (cheap at ~150px wide)
    const thumbScale = 150 / page.getViewport({ scale: 1 }).width;
    const thumbVp = page.getViewport({ scale: thumbScale });
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = Math.round(thumbVp.width);
    thumbCanvas.height = Math.round(thumbVp.height);
    const thumbCtx = thumbCanvas.getContext('2d');
    await page.render({ canvasContext: thumbCtx, viewport: thumbVp }).promise;

    ueState.pages.push(createPageInfo({
      pageNum: i,
      sourceIndex,
      sourceName,
      canvas: { width: viewport.width, height: viewport.height },
      thumbCanvas,
    }));

    ueState.annotations[ueState.pages.length - 1] = [];
  }
}

// Handle image file loading (converts to PDF)
async function handleImageFile(file) {
  const pdfBytes = await convertImageToPdf(file);

  const sourceIndex = ueState.sourceFiles.length;
  const sourceName = file.name.replace(/\.(png|jpg|jpeg|webp|gif)$/i, '').substring(0, 15);

  const bytesCopy = pdfBytes.slice();

  ueState.sourceFiles.push({
    name: file.name,
    bytes: bytesCopy,
    numPages: 1
  });

  const pdf = await loadPdfDocument(pdfBytes);
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 0.5 });

  // Render a small thumbnail canvas for sidebar
  const thumbScale = 150 / page.getViewport({ scale: 1 }).width;
  const thumbVp = page.getViewport({ scale: thumbScale });
  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = Math.round(thumbVp.width);
  thumbCanvas.height = Math.round(thumbVp.height);
  const thumbCtx = thumbCanvas.getContext('2d');
  await page.render({ canvasContext: thumbCtx, viewport: thumbVp }).promise;

  ueState.pages.push(createPageInfo({
    pageNum: 0,
    sourceIndex,
    sourceName,
    canvas: { width: viewport.width, height: viewport.height },
    thumbCanvas,
    isFromImage: true,
  }));

  ueState.annotations[ueState.pages.length - 1] = [];
}
