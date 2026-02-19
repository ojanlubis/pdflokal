/*
 * PDFLokal - pdf-tools/watermark-modal.js (ES Module)
 * Watermark modal logic for both unified editor and legacy editor
 */

import { state, navHistory, ueState } from '../lib/state.js';
import { showToast } from '../lib/utils.js';
import { pushModalState } from '../lib/navigation.js';

export function openEditorWatermarkModal() {
  document.getElementById('editor-watermark-modal').classList.add('active');
  pushModalState('editor-watermark-modal');
}

export function closeEditorWatermarkModal(skipHistoryBack = false) {
  document.getElementById('editor-watermark-modal').classList.remove('active');
  navHistory.currentModal = null;
  if (!skipHistoryBack && navHistory.currentView === 'modal') {
    history.back();
  }
}

export function applyEditorWatermark() {
  const text = document.getElementById('editor-wm-text').value || 'WATERMARK';
  const fontSize = parseInt(document.getElementById('editor-wm-size').value);
  const color = document.getElementById('editor-wm-color').value;
  const opacity = parseInt(document.getElementById('editor-wm-opacity').value) / 100;
  const rotation = parseInt(document.getElementById('editor-wm-rotation').value);
  const applyTo = document.getElementById('editor-wm-pages').value;

  // Check if in unified editor mode
  if (state.currentTool === 'unified-editor') {
    window.ueSaveEditUndoState(); // -> unified-editor.js
    const pageScale = ueState.pageScales[ueState.selectedPage] || { canvasWidth: 600, canvasHeight: 800 };
    const centerX = pageScale.canvasWidth / 2;
    const centerY = pageScale.canvasHeight / 2;

    const watermarkAnno = {
      type: 'watermark',
      text,
      fontSize,
      color,
      opacity,
      rotation,
      x: centerX,
      y: centerY
    };

    if (applyTo === 'all') {
      for (let i = 0; i < ueState.pages.length; i++) {
        if (!ueState.annotations[i]) ueState.annotations[i] = [];
        ueState.annotations[i].push({ ...watermarkAnno });
      }
      showToast('Watermark diterapkan ke semua halaman', 'success');
    } else {
      ueState.annotations[ueState.selectedPage].push(watermarkAnno);
      showToast('Watermark diterapkan', 'success');
    }

    closeEditorWatermarkModal();
    window.ueRedrawAnnotations(); // -> unified-editor.js
    return;
  }

  // Legacy editor path
  window.saveUndoState();

  const canvas = document.getElementById('edit-canvas');
  const pageScale = state.editPageScales[state.currentEditPage];
  const centerX = pageScale.canvasWidth / 2;
  const centerY = pageScale.canvasHeight / 2;

  const watermarkAnno = {
    type: 'watermark',
    text,
    fontSize,
    color,
    opacity,
    rotation,
    x: centerX,
    y: centerY
  };

  if (applyTo === 'all') {
    for (let i = 0; i < state.currentPDF.numPages; i++) {
      state.editAnnotations[i].push({ ...watermarkAnno });
    }
    showToast('Watermark diterapkan ke semua halaman', 'success');
  } else {
    state.editAnnotations[state.currentEditPage].push(watermarkAnno);
    showToast('Watermark diterapkan', 'success');
  }

  closeEditorWatermarkModal();
  window.renderEditPage();
}
