/*
 * PDFLokal - init-ui.js (ES Module)
 * Tool cards, range sliders, signature/paraf pads, modal backdrop close
 */

import { state, mobileState, uePmState } from './lib/state.js';
import {
  showToast, showFullscreenLoading, hideFullscreenLoading,
  setupCanvasDPR
} from './lib/utils.js';
import { showTool, pushWorkspaceState } from './lib/navigation.js';
import { trapFocus, releaseFocus } from './lib/utils.js';
// WHY: editor + mobile-ui were static imports that forced the entire editor module tree
// to load before any homepage UI could initialize. Now loaded on-demand when user
// clicks Merge/Split cards — the only place these functions are used.

// ============================================================
// TOOL CARDS
// ============================================================

export function initToolCards() {
  document.querySelectorAll('.tool-card:not(.disabled)').forEach(card => {
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'button');
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        card.click();
      }
    });
    card.addEventListener('click', () => {
      const tool = card.dataset.tool;

      // Handle merge-pdf and split-pdf separately (don't call showTool)
      if (tool === 'merge-pdf') {
        handleEditorCardWithFilePicker('merge');
        return;
      }
      if (tool === 'split-pdf') {
        handleEditorCardWithFilePicker('split');
        return;
      }

      showTool(tool);
    });
  });
}

// Merge/Split PDF cards (bypasses showTool — keeps home visible during file picking)
function handleEditorCardWithFilePicker(mode) {
  const inputId = mode + '-pdf-input';
  let input = document.getElementById(inputId);
  if (!input) {
    input = document.createElement('input');
    input.type = 'file';
    input.id = inputId;
    input.multiple = true;
    input.accept = '.pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/*';
    input.style.display = 'none';
    document.body.appendChild(input);

    input.addEventListener('change', async (e) => {
      if (e.target.files.length > 0) {
        const filesArray = Array.from(e.target.files);
        input.value = '';

        showFullscreenLoading('Memuat PDF...');

        // WHY: Hide empty state before editor init to prevent flash.
        // Same pattern as routeDroppedFile in init-file-handling.js.
        const emptyState = document.getElementById('ue-empty-state');
        if (emptyState) emptyState.style.display = 'none';

        try {
          const workspace = document.getElementById('unified-editor-workspace');
          if (workspace) {
            const [editor, mobileUi] = await Promise.all([
              import('./editor/index.js'),
              import('./mobile-ui.js')
            ]);

            editor.initUnifiedEditor();
            await editor.ueAddFiles(filesArray);

            document.getElementById('home-view').style.display = 'none';
            workspace.classList.add('active');
            document.body.classList.add('editor-active');
            state.currentTool = 'unified-editor';
            window.scrollTo(0, 0);
            pushWorkspaceState('unified-editor');

            if (mobileState.isTouch) {
              mobileUi.initMobileEditorEnhancements();
              mobileUi.ueMobileUpdatePageIndicator();
            }

            editor.uePmOpenModal();

            setTimeout(() => {
              if (mode === 'split' && !uePmState.extractMode) {
                editor.uePmToggleExtractMode();
              }
              hideFullscreenLoading();
            }, 100);
          }
        } catch (error) {
          console.error('Error loading PDFs:', error);
          hideFullscreenLoading();
          showToast('Gagal memuat PDF', 'error');
        }
      }
    });
  }
  input.click();
}

// ============================================================
// RANGE SLIDERS
// ============================================================

export function initRangeSliders() {
  document.querySelectorAll('.range-slider input[type="range"]').forEach(slider => {
    const valueSpan = slider.parentElement.querySelector('.range-value');
    slider.addEventListener('input', () => {
      valueSpan.textContent = slider.value + '%';
    });
  });
}

// ============================================================
// SIGNATURE PAD
// ============================================================

export function initSignaturePad() {
  const canvas = document.getElementById('signature-canvas');
  if (canvas && typeof SignaturePad !== 'undefined') {
    state.signaturePad = new SignaturePad(canvas, {
      backgroundColor: 'rgb(255, 255, 255)',
      penColor: 'rgb(0, 0, 0)'
    });

    // WHY: Store ref so resize listener can be removed on cleanup (prevents leak).
    if (canvas._resizeHandler) window.removeEventListener('resize', canvas._resizeHandler);
    const resizeCanvas = () => { setupCanvasDPR(canvas); state.signaturePad.clear(); };
    canvas._resizeHandler = resizeCanvas;
    window.addEventListener('resize', resizeCanvas);
    setTimeout(resizeCanvas, 100);
  }
}

// ============================================================
// PARAF PAD
// ============================================================

export function initParafPad() {
  const canvas = document.getElementById('paraf-canvas');
  if (canvas && typeof SignaturePad !== 'undefined') {
    state.parafPad = new SignaturePad(canvas, {
      backgroundColor: 'rgb(255, 255, 255)',
      penColor: 'rgb(0, 0, 0)'
    });

    // WHY: Store ref so resize listener can be removed on cleanup (prevents leak).
    if (canvas._resizeHandler) window.removeEventListener('resize', canvas._resizeHandler);
    const resizeCanvas = () => { setupCanvasDPR(canvas); state.parafPad.clear(); };
    canvas._resizeHandler = resizeCanvas;
    window.addEventListener('resize', resizeCanvas);
    setTimeout(resizeCanvas, 100);
  }
}

// ============================================================
// MODAL BACKDROP CLOSE (click outside to close)
// ============================================================

export function initModalBackdropClose() {
  // Map modal IDs to their close functions
  const modalCloseMap = {
    'signature-modal': 'closeSignatureModal',
    'signature-bg-modal': 'closeSignatureBgModal',
    'text-input-modal': 'closeTextModal',
    'editor-watermark-modal': 'closeEditorWatermarkModal',
    'editor-pagenum-modal': 'closeEditorPageNumModal',
    'editor-protect-modal': 'closeEditorProtectModal',
    'ue-gabungkan-modal': 'uePmCloseModal',
    'paraf-modal': 'closeParafModal',
  };

  document.addEventListener('click', (e) => {
    const target = e.target;
    // Only fire when clicking directly on the backdrop (not its children)
    const closeFn = modalCloseMap[target.id];
    if (closeFn && target.classList.contains('active') && typeof window[closeFn] === 'function') {
      window[closeFn]();
    }
  });

  // Auto focus-trap: observe .active class on all modals
  // WHY: Store observer ref on element so it can be disconnected if needed (prevents leak).
  const modalIds = Object.keys(modalCloseMap).concat('shortcuts-modal');
  modalIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el._modalObserver) el._modalObserver.disconnect();
    const observer = new MutationObserver(() => {
      if (el.classList.contains('active')) {
        trapFocus(el);
      } else if (el._focusTrapHandler) {
        releaseFocus(el);
      }
    });
    el._modalObserver = observer;
    observer.observe(el, { attributes: true, attributeFilter: ['class'] });
  });
}
