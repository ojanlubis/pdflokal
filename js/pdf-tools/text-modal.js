/*
 * PDFLokal - pdf-tools/text-modal.js (ES Module)
 * Text annotation modal logic
 */

import { state, navHistory } from '../lib/state.js';
import { showToast } from '../lib/utils.js';
import { pushModalState } from '../lib/navigation.js';

function initTextModalControls() {
  const boldBtn = document.getElementById('modal-text-bold');
  const italicBtn = document.getElementById('modal-text-italic');
  const colorPresets = document.querySelectorAll('.color-preset-btn');
  const colorPicker = document.getElementById('modal-text-color');

  boldBtn.onclick = () => {
    boldBtn.classList.toggle('active');
    updateTextPreview();
  };

  italicBtn.onclick = () => {
    italicBtn.classList.toggle('active');
    updateTextPreview();
  };

  colorPresets.forEach(btn => {
    btn.onclick = () => {
      const color = btn.dataset.color;
      colorPicker.value = color;
      colorPresets.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      updateTextPreview();
    };
  });

  colorPicker.oninput = () => {
    colorPresets.forEach(b => b.classList.remove('active'));
    updateTextPreview();
  };
}

// Open text annotation modal. Resets all fields to defaults.
// Called from: unified-editor.js (ueOpenTextModal) and legacy editor.
export function openTextModal() {
  if (window.changelogAPI) {
    window.changelogAPI.minimize();
  }

  const modal = document.getElementById('text-input-modal');
  modal.classList.add('active');
  pushModalState('text-input-modal');

  const textInput = document.getElementById('text-input-field');
  textInput.value = '';
  textInput.focus();

  // Reset to defaults
  document.getElementById('modal-font-family').value = 'Helvetica';
  document.getElementById('modal-font-size').value = '16';
  document.getElementById('modal-text-bold').classList.remove('active');
  document.getElementById('modal-text-italic').classList.remove('active');
  document.getElementById('modal-text-color').value = '#000000';

  document.querySelectorAll('.color-preset-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.color === '#000000');
  });

  initTextModalControls();
  updateTextPreview();

  textInput.oninput = updateTextPreview;
  document.getElementById('modal-font-size').oninput = updateTextPreview;
  document.getElementById('modal-font-family').onchange = updateTextPreview;

  textInput.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      confirmTextInput();
    }
  };
}

export function closeTextModal(skipHistoryBack = false) {
  const modal = document.getElementById('text-input-modal');
  modal.classList.remove('active');
  state.pendingTextPosition = null;
  navHistory.currentModal = null;
  if (!skipHistoryBack && navHistory.currentView === 'modal') {
    history.back();
  }
}

export function updateTextPreview() {
  const text = document.getElementById('text-input-field').value || 'Preview teks';
  const fontSize = document.getElementById('modal-font-size').value;
  const color = document.getElementById('modal-text-color').value;
  const fontFamily = document.getElementById('modal-font-family').value;
  const isBold = document.getElementById('modal-text-bold').classList.contains('active');
  const isItalic = document.getElementById('modal-text-italic').classList.contains('active');

  const preview = document.getElementById('text-preview');
  preview.textContent = text;
  preview.style.fontSize = fontSize + 'px';
  preview.style.color = color;
  preview.style.fontWeight = isBold ? 'bold' : 'normal';
  preview.style.fontStyle = isItalic ? 'italic' : 'normal';

  let cssFontFamily = 'Helvetica, Arial, sans-serif';
  if (fontFamily === 'Times-Roman') cssFontFamily = 'Times New Roman, Times, serif';
  else if (fontFamily === 'Courier') cssFontFamily = 'Courier New, Courier, monospace';
  else if (fontFamily === 'Montserrat') cssFontFamily = 'Montserrat, sans-serif';
  else if (fontFamily === 'Carlito') cssFontFamily = 'Carlito, Calibri, sans-serif';
  preview.style.fontFamily = cssFontFamily;
}

// Read current text modal form values.
// Called from: unified-editor.js (ueConfirmText) to create text annotation.
export function getTextModalSettings() {
  return {
    text: document.getElementById('text-input-field').value.trim(),
    fontSize: parseInt(document.getElementById('modal-font-size').value) || 16,
    color: document.getElementById('modal-text-color').value,
    fontFamily: document.getElementById('modal-font-family').value,
    bold: document.getElementById('modal-text-bold').classList.contains('active'),
    italic: document.getElementById('modal-text-italic').classList.contains('active')
  };
}

export function confirmTextInput() {
  // Check if we're in unified editor mode
  if (state.currentTool === 'unified-editor' && window.ueState && window.ueState.pendingTextPosition) {
    window.ueConfirmText(); // -> unified-editor.js
    return;
  }

  const settings = getTextModalSettings();

  if (!settings.text) {
    showToast('Masukkan teks terlebih dahulu', 'error');
    return;
  }

  if (!state.pendingTextPosition) {
    showToast('Posisi teks tidak valid', 'error');
    closeTextModal();
    return;
  }

  window.saveUndoState(); // -> standalone-tools.js (legacy editor)
  state.editAnnotations[state.currentEditPage].push({
    type: 'text',
    text: settings.text,
    x: state.pendingTextPosition.x,
    y: state.pendingTextPosition.y,
    fontSize: settings.fontSize,
    color: settings.color,
    fontFamily: settings.fontFamily,
    bold: settings.bold,
    italic: settings.italic
  });

  closeTextModal();
  window.renderEditPage(); // -> standalone-tools.js (legacy editor)
  window.setEditTool('select');
  window.updateEditorStatus('Teks ditambahkan');
}
