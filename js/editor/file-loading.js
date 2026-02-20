/*
 * PDFLokal - editor/file-loading.js (ES Module)
 * File input handling, PDF and image loading
 */

import { ueState } from '../lib/state.js';
import { showToast, showFullscreenLoading, hideFullscreenLoading, checkFileSize, convertImageToPdf } from '../lib/utils.js';
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
    const isPdf = file.type === 'application/pdf';
    const isImage = file.type.startsWith('image/');

    if (!isPdf && !isImage) {
      showToast(`File ${file.name} bukan PDF atau gambar. Diabaikan.`, 'warning');
      continue;
    }

    if (!checkFileSize(file)) continue;

    try {
      if (isPdf) {
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

  ueState.sourceFiles.push({ name: file.name, bytes });

  const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;

  for (let i = 0; i < pdf.numPages; i++) {
    const page = await pdf.getPage(i + 1);
    const viewport = page.getViewport({ scale: 0.5 });

    // Store dimensions only — actual rendering happens lazily via IntersectionObserver
    ueState.pages.push({
      pageNum: i,
      sourceIndex,
      sourceName,
      rotation: 0,
      canvas: { width: viewport.width, height: viewport.height },
      isFromImage: false
    });

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
    bytes: bytesCopy
  });

  const pdf = await pdfjsLib.getDocument({ data: pdfBytes }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 0.5 });

  // Store dimensions only — actual rendering happens lazily via IntersectionObserver
  ueState.pages.push({
    pageNum: 0,
    sourceIndex,
    sourceName,
    rotation: 0,
    canvas: { width: viewport.width, height: viewport.height },
    isFromImage: true
  });

  ueState.annotations[ueState.pages.length - 1] = [];
}
