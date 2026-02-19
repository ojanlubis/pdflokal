/*
 * PDFLokal - editor/signatures.js (ES Module)
 * Signature placement, preview, confirm, delete
 */

import { ueState, state, mobileState, SIGNATURE_DEFAULT_WIDTH } from '../lib/state.js';
import { showToast } from '../lib/utils.js';
import { ueGetCurrentCanvas } from './canvas-utils.js';
import { ueRedrawAnnotations } from './annotations.js';
import { ueSaveEditUndoState } from './undo-redo.js';

// Place signature on canvas at (x, y)
export async function uePlaceSignature(x, y) {
  const pageIndex = ueState.selectedPage;
  if (pageIndex < 0 || !state.signatureImage) return;

  const img = new Image();
  img.src = state.signatureImage;

  try {
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; });
  } catch {
    showToast('Gagal memuat tanda tangan', 'error');
    return;
  }

  // Save undo AFTER image loads (prevents race with undo during load)
  ueSaveEditUndoState();

  if (!ueState.annotations[pageIndex]) ueState.annotations[pageIndex] = [];

  const aspectRatio = img.width / img.height;
  const sigWidth = SIGNATURE_DEFAULT_WIDTH;
  const sigHeight = sigWidth / aspectRatio;
  const newAnno = {
    type: 'signature',
    image: state.signatureImage,
    x: x - sigWidth / 2,
    y: y - sigHeight / 2,
    width: sigWidth,
    height: sigHeight,
    cachedImg: img,
    locked: false
  };
  ueState.annotations[pageIndex].push(newAnno);

  const newIndex = ueState.annotations[pageIndex].length - 1;
  ueState.selectedAnnotation = { pageIndex, index: newIndex };

  ueState.pendingSignature = false;
  ueState.signaturePreviewPos = null;

  ueRedrawAnnotations();
  ueShowConfirmButton(newAnno, ueState.selectedAnnotation);

  window.ueSetTool('select');
  ueUpdateDownloadButtonState();

  if (mobileState.isTouch && navigator.vibrate) {
    navigator.vibrate(20);
  }

  if (typeof ueMobileUpdateSignButton === 'function') {
    ueMobileUpdateSignButton();
  }
}

// Draw signature preview at cursor
export function ueDrawSignaturePreview(x, y) {
  if (!state.signatureImage) return;

  const canvas = ueGetCurrentCanvas();
  const ctx = canvas.getContext('2d');

  const img = new Image();
  img.src = state.signatureImage;

  if (img.complete) {
    const aspectRatio = img.width / img.height;
    const sigWidth = SIGNATURE_DEFAULT_WIDTH;
    const sigHeight = sigWidth / aspectRatio;

    // Draw semi-transparent preview centered on cursor
    ctx.globalAlpha = 0.6;
    ctx.drawImage(img, x - sigWidth / 2, y - sigHeight / 2, sigWidth, sigHeight);
    ctx.globalAlpha = 1.0;

    // Draw dashed border
    ctx.strokeStyle = '#3B82F6';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.strokeRect(x - sigWidth / 2, y - sigHeight / 2, sigWidth, sigHeight);
    ctx.setLineDash([]);
  }
}

// Show confirm button for signature
export function ueShowConfirmButton(anno, annoRef) {
  if (anno.type !== 'signature' || anno.locked) {
    ueHideConfirmButton();
    return;
  }

  const btn = document.getElementById('signature-btn-wrapper');
  if (!btn) return;
  btn.style.display = 'inline-flex';

  const confirmBtn = document.getElementById('signature-confirm-btn');
  confirmBtn.onclick = () => ueConfirmSignature(annoRef);

  const deleteBtn = document.getElementById('signature-delete-btn');
  deleteBtn.onclick = () => ueDeleteSignature(annoRef);

  ueUpdateConfirmButtonPosition(anno);
}

// Update confirm button position
export function ueUpdateConfirmButtonPosition(anno) {
  const btn = document.getElementById('signature-btn-wrapper');
  if (!btn || btn.style.display === 'none') return;

  const canvas = ueGetCurrentCanvas();
  const wrapper = document.getElementById('ue-canvas-wrapper');
  if (!canvas || !wrapper) return;

  const canvasRect = canvas.getBoundingClientRect();
  const wrapperRect = wrapper.getBoundingClientRect();

  // Convert annotation coords to screen coords
  const scaleX = canvas.clientWidth / (canvas.width / ueState.devicePixelRatio);
  const scaleY = canvas.clientHeight / (canvas.height / ueState.devicePixelRatio);

  const screenX = (anno.x + anno.width / 2) * scaleX + canvasRect.left - wrapperRect.left;
  const screenY = (anno.y + anno.height) * scaleY + canvasRect.top - wrapperRect.top + 8;

  btn.style.left = screenX + 'px';
  btn.style.top = screenY + 'px';
  btn.style.transform = 'translateX(-50%)';
}

// Hide confirm button
export function ueHideConfirmButton() {
  const btn = document.getElementById('signature-btn-wrapper');
  if (btn) {
    btn.style.display = 'none';
  }
}

// Confirm (lock) signature
export function ueConfirmSignature(annoRef) {
  const anno = ueState.annotations[annoRef.pageIndex][annoRef.index];
  if (anno) {
    anno.locked = true;
    ueHideConfirmButton();
    ueState.selectedAnnotation = null;
    ueRedrawAnnotations();
    showToast('Tanda tangan dikonfirmasi', 'success');
  }
}

// Delete signature
export function ueDeleteSignature(annoRef) {
  const anno = ueState.annotations[annoRef.pageIndex][annoRef.index];
  if (anno) {
    ueSaveEditUndoState();
    ueState.annotations[annoRef.pageIndex].splice(annoRef.index, 1);
    ueHideConfirmButton();
    ueState.selectedAnnotation = null;
    ueRedrawAnnotations();
    showToast('Tanda tangan dihapus', 'success');
  }
}

// Update download button state (pulse animation when signatures exist)
export function ueUpdateDownloadButtonState() {
  // Check if any signatures exist
  let hasSignatures = false;
  for (const pageIndex in ueState.annotations) {
    if (ueState.annotations[pageIndex].some(a => a.type === 'signature')) {
      hasSignatures = true;
      break;
    }
  }

  const btn = document.getElementById('ue-download-btn');
  if (btn) btn.classList.toggle('has-signatures', hasSignatures);
}
