/*
 * PDFLokal - pdf-tools/signature-modal.js (ES Module)
 * Signature capture, upload, and background removal modal logic
 */

import { state, navHistory, ueState } from '../lib/state.js';
import { showToast, loadImage } from '../lib/utils.js';
import { pushModalState } from '../lib/navigation.js';

export function openSignatureModal() {
  if (window.changelogAPI) {
    window.changelogAPI.minimize();
  }

  const modal = document.getElementById('signature-modal');
  modal.classList.add('active');
  window.setEditTool('signature');
  pushModalState('signature-modal');

  // Default to upload tab
  switchSignatureTab('upload');

  setTimeout(() => {
    const canvas = document.getElementById('signature-canvas');
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = canvas.offsetWidth * ratio;
    canvas.height = canvas.offsetHeight * ratio;
    canvas.getContext('2d').scale(ratio, ratio);
    if (state.signaturePad) state.signaturePad.clear();
  }, 100);
}

export function closeSignatureModal(skipHistoryBack = false) {
  const modal = document.getElementById('signature-modal');
  modal.classList.remove('active');
  navHistory.currentModal = null;
  if (!skipHistoryBack && navHistory.currentView === 'modal') {
    history.back();
  }
}

export function clearSignature() {
  if (state.signaturePad) {
    state.signaturePad.clear();
  }
}

export function useSignature() {
  if (state.signaturePad && !state.signaturePad.isEmpty()) {
    const signatureCanvas = document.getElementById('signature-canvas');

    // Create a temporary canvas for background removal
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = signatureCanvas.width;
    tempCanvas.height = signatureCanvas.height;
    const ctx = tempCanvas.getContext('2d');

    ctx.drawImage(signatureCanvas, 0, 0);

    // Apply background removal (make white pixels transparent)
    const imageData = ctx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
    const data = imageData.data;
    const threshold = 240;

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];

      if (r >= threshold && g >= threshold && b >= threshold) {
        data[i + 3] = 0;
      }
    }

    ctx.putImageData(imageData, 0, 0);
    state.signatureImage = optimizeSignatureImage(tempCanvas);

    closeSignatureModal();
    if (state.currentTool === 'unified-editor') {
      window.ueSetTool('signature'); // -> unified-editor.js
      ueState.pendingSignature = true;
      ueState.signaturePreviewPos = null;
    } else {
      window.setEditTool('signature');
    }
    showToast('Klik pada PDF untuk menempatkan tanda tangan', 'success');
  } else {
    showToast('Buat tanda tangan terlebih dahulu', 'error');
  }
}

export function switchSignatureTab(tab) {
  document.querySelectorAll('.signature-tab').forEach(btn => {
    const text = btn.textContent.toLowerCase().trim();
    const shouldBeActive = (tab === 'upload' && text === 'upload gambar') ||
                          (tab === 'draw' && text === 'gambar');
    btn.classList.toggle('active', shouldBeActive);
  });

  document.getElementById('signature-draw-tab').classList.toggle('active', tab === 'draw');
  document.getElementById('signature-upload-tab').classList.toggle('active', tab === 'upload');

  if (tab === 'draw') {
    setTimeout(() => {
      const canvas = document.getElementById('signature-canvas');
      if (canvas && state.signaturePad) {
        const ratio = Math.max(window.devicePixelRatio || 1, 1);
        canvas.width = canvas.offsetWidth * ratio;
        canvas.height = canvas.offsetHeight * ratio;
        canvas.getContext('2d').scale(ratio, ratio);
        state.signaturePad.clear();
      }
    }, 100);
  }
}

export async function loadSignatureImage(file) {
  try {
    const img = await loadImage(file);
    state.signatureUploadImage = img;

    closeSignatureModal(true);
    openSignatureBgModal();
  } catch (error) {
    showToast('Gagal memuat gambar', 'error');
    throw error;
  }
}

export function openSignatureBgModal() {
  if (window.changelogAPI) {
    window.changelogAPI.minimize();
  }

  const modal = document.getElementById('signature-bg-modal');
  modal.classList.add('active');

  history.replaceState({
    view: 'modal',
    modal: 'signature-bg-modal',
    tool: navHistory.currentWorkspace
  }, '', null);
  navHistory.currentView = 'modal';
  navHistory.currentModal = 'signature-bg-modal';

  document.getElementById('sig-bg-original').src = state.signatureUploadImage.src;
  updateSignatureBgPreview();
}

export function closeSignatureBgModal(skipHistoryBack = false) {
  const modal = document.getElementById('signature-bg-modal');
  modal.classList.remove('active');

  if (state.signatureUploadImage && state.signatureUploadImage._blobUrl) {
    URL.revokeObjectURL(state.signatureUploadImage._blobUrl);
  }
  state.signatureUploadImage = null;
  state.signatureUploadCanvas = null;

  navHistory.currentModal = null;
  if (!skipHistoryBack && navHistory.currentView === 'modal') {
    history.back();
  }
}

export function updateSignatureBgPreview() {
  if (!state.signatureUploadImage) return;

  const threshold = parseInt(document.getElementById('sig-bg-threshold').value);
  document.getElementById('sig-bg-threshold-value').textContent = threshold;

  const canvas = document.getElementById('sig-bg-preview');
  const ctx = canvas.getContext('2d');

  canvas.width = state.signatureUploadImage.naturalWidth;
  canvas.height = state.signatureUploadImage.naturalHeight;

  ctx.drawImage(state.signatureUploadImage, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    if (r >= threshold && g >= threshold && b >= threshold) {
      data[i + 3] = 0;
    }
  }

  ctx.putImageData(imageData, 0, 0);
  state.signatureUploadCanvas = canvas;
}

export function optimizeSignatureImage(sourceCanvas) {
  const MAX_SIZE = 1500;
  let canvas = sourceCanvas;

  if (sourceCanvas.width > MAX_SIZE || sourceCanvas.height > MAX_SIZE) {
    const scale = Math.min(MAX_SIZE / sourceCanvas.width, MAX_SIZE / sourceCanvas.height);
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = Math.floor(sourceCanvas.width * scale);
    tempCanvas.height = Math.floor(sourceCanvas.height * scale);
    const ctx = tempCanvas.getContext('2d');
    ctx.drawImage(sourceCanvas, 0, 0, tempCanvas.width, tempCanvas.height);
    canvas = tempCanvas;
  }

  const ctx = canvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  let hasTransparency = false;

  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) {
      hasTransparency = true;
      break;
    }
  }

  if (hasTransparency) {
    return canvas.toDataURL('image/png');
  } else {
    return canvas.toDataURL('image/jpeg', 0.85);
  }
}

export function useSignatureFromUpload() {
  if (!state.signatureUploadCanvas) {
    showToast('Tidak ada gambar untuk digunakan', 'error');
    return;
  }

  state.signatureImage = optimizeSignatureImage(state.signatureUploadCanvas);

  closeSignatureBgModal();
  if (state.currentTool === 'unified-editor') {
    window.ueSetTool('signature'); // -> unified-editor.js
    ueState.pendingSignature = true;
    ueState.signaturePreviewPos = null;
    window.ueUpdateStatus('Klik untuk menempatkan tanda tangan'); // -> unified-editor.js
  } else {
    window.setEditTool('signature');
    window.updateEditorStatus('Klik untuk menempatkan tanda tangan');
  }
  showToast('Klik pada PDF untuk menempatkan tanda tangan', 'success');
}
