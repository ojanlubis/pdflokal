/*
 * PDFLokal - pdf-tools/watermark-modal.js (ES Module)
 * Watermark modal logic for both unified editor and legacy editor
 */

import { ueState, createWatermarkAnnotation } from '../lib/state.js';
import { showToast } from '../lib/utils.js';
import { openModal, closeModal } from '../lib/navigation.js';
import { ueAddAnnotation } from '../editor/annotations.js';
import { track } from '../lib/analytics.js';

export function openEditorWatermarkModal() {
  openModal('editor-watermark-modal');
}

export function closeEditorWatermarkModal(skipHistoryBack = false) {
  closeModal('editor-watermark-modal', skipHistoryBack);
}

export function applyEditorWatermark() {
  const text = document.getElementById('editor-wm-text').value || 'WATERMARK';
  const fontSize = Number.parseInt(document.getElementById('editor-wm-size').value);
  const color = document.getElementById('editor-wm-color').value;
  const opacity = Number.parseInt(document.getElementById('editor-wm-opacity').value) / 100;
  const rotation = Number.parseInt(document.getElementById('editor-wm-rotation').value);
  const applyTo = document.getElementById('editor-wm-pages').value;

  window.ueSaveEditUndoState();
  const pageScale = ueState.pageScales[ueState.selectedPage] || { canvasWidth: 600, canvasHeight: 800 };
  const centerX = pageScale.canvasWidth / 2;
  const centerY = pageScale.canvasHeight / 2;

  if (applyTo === 'all') {
    for (let i = 0; i < ueState.pages.length; i++) {
      ueAddAnnotation(i, createWatermarkAnnotation({
        text, fontSize, color, opacity, rotation,
        x: centerX, y: centerY
      }));
    }
    showToast('Watermark diterapkan ke semua halaman', 'success');
  } else {
    ueAddAnnotation(ueState.selectedPage, createWatermarkAnnotation({
      text, fontSize, color, opacity, rotation,
      x: centerX, y: centerY
    }));
    showToast('Watermark diterapkan', 'success');
  }

  track('editor_action', { action: 'watermark' });
  closeEditorWatermarkModal();
  window.ueRedrawAnnotations();
}
