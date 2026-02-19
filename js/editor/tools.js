/*
 * PDFLokal - editor/tools.js (ES Module)
 * Tool selection, modal wrappers, more-tools dropdown, protect modal
 */

import { ueState, state, navHistory } from '../lib/state.js';
import { showToast, downloadBlob, getDownloadFilename } from '../lib/utils.js';
import { pushModalState, showHome } from '../lib/navigation.js';
import { ueHideConfirmButton } from './signatures.js';
import { ueRedrawAnnotations } from './annotations.js';
import { ueSaveEditUndoState } from './undo-redo.js';
import { ueUpdateStatus } from './page-rendering.js';

// Tool selection
export function ueSetTool(tool) {
  ueState.currentTool = tool;

  if (tool !== 'select') {
    ueState.selectedAnnotation = null;
    ueHideConfirmButton();
  }

  if (tool !== 'signature') {
    ueState.pendingSignature = false;
    ueState.signaturePreviewPos = null;
  }

  // Update active state on both old toolbar buttons and floating toolbar buttons
  document.querySelectorAll('#unified-editor-workspace .editor-tool-btn, #floating-toolbar .ft-btn[data-edit-tool]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.editTool === tool);
  });

  ueState.pageCanvases.forEach(pc => {
    pc.canvas.className = 'ue-page-canvas tool-' + tool;
  });

  const toolNames = {
    'select': 'Pilih & pindahkan anotasi',
    'whiteout': 'Klik dan seret untuk menggambar area whiteout',
    'text': 'Klik untuk menambah teks',
    'signature': 'Klik untuk menempatkan tanda tangan'
  };
  ueUpdateStatus(toolNames[tool] || 'Pilih alat untuk mengedit');
}

// openSignatureModal, openTextModal, getTextModalSettings live in js/pdf-tools/.
// tools.js ↔ lifecycle.js is also circular, so ueDismissSignatureHint goes through window.*.
export function ueOpenSignatureModal() {
  window.ueDismissSignatureHint();
  window.openSignatureModal();
}

export function ueOpenTextModal() {
  window.openTextModal();
}

export function ueConfirmText() {
  const settings = window.getTextModalSettings();

  if (!settings.text) {
    showToast('Masukkan teks terlebih dahulu', 'error');
    return;
  }

  ueSaveEditUndoState();
  ueState.annotations[ueState.selectedPage].push({
    type: 'text',
    text: settings.text,
    x: ueState.pendingTextPosition.x,
    y: ueState.pendingTextPosition.y,
    fontSize: settings.fontSize,
    color: settings.color,
    fontFamily: settings.fontFamily,
    bold: settings.bold,
    italic: settings.italic
  });

  document.getElementById('text-input-modal').classList.remove('active');
  ueRedrawAnnotations();
  ueState.pendingTextPosition = null;
  ueSetTool('select');
}

// Watermark modal
export function ueOpenWatermarkModal() {
  document.getElementById('editor-watermark-modal').classList.add('active');
  pushModalState('editor-watermark-modal');
}

// Page number modal
export function ueOpenPageNumModal() {
  document.getElementById('editor-pagenum-modal').classList.add('active');
  pushModalState('editor-pagenum-modal');
}

// More Tools Dropdown
export function toggleMoreTools(e) {
  e.stopPropagation();
  const btn = document.getElementById('more-tools-btn');
  const dropdown = document.getElementById('more-tools-dropdown');

  if (dropdown.classList.contains('active')) {
    dropdown.classList.remove('active');
  } else {
    const rect = btn.getBoundingClientRect();
    dropdown.style.top = (rect.bottom + 4) + 'px';
    dropdown.style.left = rect.left + 'px';
    dropdown.classList.add('active');
  }
}

export function closeMoreTools() {
  document.getElementById('more-tools-dropdown').classList.remove('active');
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
  const container = document.querySelector('.editor-more-tools');
  if (container && !container.contains(e.target)) {
    closeMoreTools();
  }
  // Floating toolbar more dropdown
  const ftWrapper = document.querySelector('.ft-more-wrapper');
  if (ftWrapper && !ftWrapper.contains(e.target)) {
    closeFloatingMore();
  }
});

// Floating toolbar More dropdown
export function toggleFloatingMore(e) {
  e.stopPropagation();
  const dropdown = document.getElementById('ft-more-dropdown');
  if (dropdown) dropdown.classList.toggle('active');
}

export function closeFloatingMore() {
  const dropdown = document.getElementById('ft-more-dropdown');
  if (dropdown) dropdown.classList.remove('active');
}

// Kunci PDF modal
export function ueOpenProtectModal() {
  document.getElementById('editor-protect-modal').classList.add('active');
  document.getElementById('editor-protect-password').value = '';
  document.getElementById('editor-protect-confirm').value = '';
  pushModalState('editor-protect-modal');
}

export function closeEditorProtectModal(skipHistoryBack = false) {
  document.getElementById('editor-protect-modal').classList.remove('active');
  navHistory.currentModal = null;
  if (!skipHistoryBack && navHistory.currentView === 'modal') {
    history.back();
  }
}

export async function applyEditorProtect() {
  const password = document.getElementById('editor-protect-password').value;
  const confirm = document.getElementById('editor-protect-confirm').value;

  if (!password) {
    showToast('Masukkan password', 'error');
    return;
  }

  if (password !== confirm) {
    showToast('Password tidak cocok', 'error');
    return;
  }

  try {
    // ueBuildFinalPDF lives in pdf-export.js; tools ↔ pdf-export is circular.
    const pdfBytes = await window.ueBuildFinalPDF();
    const pdfDoc = await PDFLib.PDFDocument.load(pdfBytes);

    const protectedBytes = await pdfDoc.save({
      userPassword: password,
      ownerPassword: password,
    });

    downloadBlob(new Blob([protectedBytes], { type: 'application/pdf' }), getDownloadFilename({ originalName: ueState.sourceFiles[0]?.name, extension: 'pdf' }));

    closeEditorProtectModal();
    showToast('PDF berhasil dikunci!', 'success');
  } catch (error) {
    console.error('Error protecting PDF:', error);
    showToast('Gagal mengunci PDF', 'error');
  }
}

// Navigate home from editor (with unsaved work warning)
export function editorGoHome(event) {
  if (event) event.preventDefault();

  const hasAnnotations = Object.values(ueState.annotations).some(arr => arr && arr.length > 0);
  const hasRotation = ueState.pages.some(p => p.rotation && p.rotation !== 0);

  if (ueState.pages.length > 0 && (hasAnnotations || hasRotation)) {
    if (!confirm('Kamu punya perubahan yang belum di-download. Yakin ingin kembali ke beranda?')) {
      return;
    }
  }
  showHome();
}
