/*
 * PDFLokal - pdf-tools/text-modal.js (ES Module)
 * Text annotation modal logic
 */

import { state, CSS_FONT_MAP } from '../lib/state.js';
import { showToast } from '../lib/utils.js';
import { openModal, closeModal } from '../lib/navigation.js';

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
export function openTextModal() {
  if (window.changelogAPI) {
    window.changelogAPI.minimize();
  }

  openModal('text-input-modal');

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
  state.pendingTextPosition = null;
  closeModal('text-input-modal', skipHistoryBack);
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

  preview.style.fontFamily = CSS_FONT_MAP[fontFamily] || CSS_FONT_MAP['Helvetica'];
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
  if (window.ueState && window.ueState.pendingTextPosition) {
    window.ueConfirmText();
    return;
  }

  showToast('Posisi teks tidak valid', 'error');
  closeTextModal();
}
