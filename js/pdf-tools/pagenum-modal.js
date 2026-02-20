/*
 * PDFLokal - pdf-tools/pagenum-modal.js (ES Module)
 * Page number modal logic for both unified editor and legacy editor
 */

import { state, ueState, createPageNumberAnnotation } from '../lib/state.js';
import { showToast } from '../lib/utils.js';
import { openModal, closeModal } from '../lib/navigation.js';

export function openEditorPageNumModal() {
  openModal('editor-pagenum-modal');
}

export function closeEditorPageNumModal(skipHistoryBack = false) {
  closeModal('editor-pagenum-modal', skipHistoryBack);
}

export function applyEditorPageNumbers() {
  const position = document.getElementById('editor-pn-position').value;
  const format = document.getElementById('editor-pn-format').value;
  const fontSize = parseInt(document.getElementById('editor-pn-size').value);
  const startNum = parseInt(document.getElementById('editor-pn-start').value) || 1;

  // Check if in unified editor mode
  if (state.currentTool === 'unified-editor') {
    const totalPages = ueState.pages.length;
    window.ueSaveEditUndoState(); // -> unified-editor.js

    for (let i = 0; i < totalPages; i++) {
      const pageNum = startNum + i;
      let text;

      switch (format) {
        case 'page-of':
          text = `Halaman ${pageNum} dari ${totalPages + startNum - 1}`;
          break;
        case 'dash':
          text = `- ${pageNum} -`;
          break;
        default:
          text = `${pageNum}`;
      }

      const pageScale = ueState.pageScales[i] || ueState.pageScales[ueState.selectedPage] || { canvasWidth: 600, canvasHeight: 800 };
      const canvasWidth = pageScale.canvasWidth;
      const canvasHeight = pageScale.canvasHeight;
      const margin = 30;

      let x, y;
      switch (position) {
        case 'bottom-left':
          x = margin; y = canvasHeight - margin; break;
        case 'bottom-right':
          x = canvasWidth - margin; y = canvasHeight - margin; break;
        case 'top-center':
          x = canvasWidth / 2; y = margin + fontSize; break;
        case 'top-left':
          x = margin; y = margin + fontSize; break;
        case 'top-right':
          x = canvasWidth - margin; y = margin + fontSize; break;
        default:
          x = canvasWidth / 2; y = canvasHeight - margin;
      }

      if (!ueState.annotations[i]) ueState.annotations[i] = [];
      ueState.annotations[i].push(createPageNumberAnnotation({
        text, fontSize, x, y, position
      }));
    }

    closeEditorPageNumModal();
    window.ueRedrawAnnotations(); // -> unified-editor.js
    showToast('Nomor halaman ditambahkan ke semua halaman', 'success');
    return;
  }

  // Legacy editor path
  const totalPages = state.currentPDF.numPages;
  window.saveUndoState();

  for (let i = 0; i < totalPages; i++) {
    const pageNum = startNum + i;
    let text;

    switch (format) {
      case 'page-of':
        text = `Halaman ${pageNum} dari ${totalPages + startNum - 1}`;
        break;
      case 'dash':
        text = `- ${pageNum} -`;
        break;
      default:
        text = `${pageNum}`;
    }

    const pageScale = state.editPageScales[i] || state.editPageScales[state.currentEditPage];
    const canvasWidth = pageScale?.canvasWidth || 600;
    const canvasHeight = pageScale?.canvasHeight || 800;
    const margin = 30;

    let x, y;
    switch (position) {
      case 'bottom-left':
        x = margin; y = canvasHeight - margin; break;
      case 'bottom-right':
        x = canvasWidth - margin; y = canvasHeight - margin; break;
      case 'top-center':
        x = canvasWidth / 2; y = margin + fontSize; break;
      case 'top-left':
        x = margin; y = margin + fontSize; break;
      case 'top-right':
        x = canvasWidth - margin; y = margin + fontSize; break;
      default:
        x = canvasWidth / 2; y = canvasHeight - margin;
    }

    state.editAnnotations[i].push(createPageNumberAnnotation({
      text, fontSize, x, y, position
    }));
  }

  closeEditorPageNumModal();
  window.renderEditPage();
  showToast('Nomor halaman ditambahkan ke semua halaman', 'success');
}
