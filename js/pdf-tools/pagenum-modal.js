/*
 * PDFLokal - pdf-tools/pagenum-modal.js (ES Module)
 * Page number modal logic for both unified editor and legacy editor
 */

import { ueState, createPageNumberAnnotation } from '../lib/state.js';
import { showToast } from '../lib/utils.js';
import { openModal, closeModal } from '../lib/navigation.js';
import { ueAddAnnotation } from '../editor/annotations.js';
import { track } from '../lib/analytics.js';

export function openEditorPageNumModal() {
  openModal('editor-pagenum-modal');
}

export function closeEditorPageNumModal(skipHistoryBack = false) {
  closeModal('editor-pagenum-modal', skipHistoryBack);
}

export function applyEditorPageNumbers() {
  const position = document.getElementById('editor-pn-position').value;
  const format = document.getElementById('editor-pn-format').value;
  const fontSize = Number.parseInt(document.getElementById('editor-pn-size').value);
  const startNum = Number.parseInt(document.getElementById('editor-pn-start').value) || 1;

  const totalPages = ueState.pages.length;
  window.ueSaveEditUndoState();

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

    ueAddAnnotation(i, createPageNumberAnnotation({
      text, fontSize, x, y, position
    }));
  }

  track('editor_action', { action: 'pagenum' });
  closeEditorPageNumModal();
  window.ueRedrawAnnotations();
  showToast('Nomor halaman ditambahkan ke semua halaman', 'success');
}
