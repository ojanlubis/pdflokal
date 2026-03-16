/*
 * PDFLokal - editor/lifecycle.js (ES Module)
 * Editor initialization, reset, signature hints
 */

import { ueState, clearImageRegistry, getDefaultUeState, MAX_CANVAS_DPR } from '../lib/state.js';
import { on } from '../lib/events.js';
import { showToast, showFullscreenLoading, hideFullscreenLoading, safeLocalGet, safeLocalSet } from '../lib/utils.js';
import { initUnifiedEditorInput, ueAddFiles } from './file-loading.js';
import { ueRenderThumbnails } from './sidebar.js';
import { ueSetupScrollSync, ueUpdatePageCount, createPageRenderer, destroyPageRenderer } from './page-rendering.js';

// WHY: Subscribe to pages:changed so page count auto-updates when pages change.
// Replaces manual ueUpdatePageCount() calls scattered across modules.
on('pages:changed', () => ueUpdatePageCount());
import { ueUpdateZoomDisplay } from './zoom-rotate.js';

// Reset unified editor state
export function ueReset() {
  // Reset all value fields to defaults (SSOT — adding a field to getDefaultUeState is enough)
  Object.assign(ueState, getDefaultUeState());

  // Side-effect cleanup (not just value resets)
  destroyPageRenderer();
  clearImageRegistry();
  ueState.zoomLevel = 1.0;
  ueUpdateZoomDisplay();

  document.getElementById('ue-empty-state').style.display = 'flex';
  const pagesContainer = document.getElementById('ue-pages-container');
  if (pagesContainer) {
    pagesContainer.innerHTML = '';
    pagesContainer.style.display = 'none';
  }
  document.getElementById('ue-download-btn').disabled = true;
  ueRenderThumbnails();
  ueUpdatePageCount();
}

// First-use signature tooltip
export function ueShowSignatureHint() {
  const HINT_KEY = 'pdflokal_signature_hint_shown';
  if (safeLocalGet(HINT_KEY)) return;

  const tooltip = document.getElementById('signature-hint-tooltip');
  if (!tooltip) return;

  setTimeout(() => {
    tooltip.classList.add('show');
  }, 500);

  setTimeout(() => {
    ueDismissSignatureHint();
  }, 5500);
}

export function ueDismissSignatureHint() {
  const HINT_KEY = 'pdflokal_signature_hint_shown';
  const tooltip = document.getElementById('signature-hint-tooltip');
  if (tooltip) {
    tooltip.classList.remove('show');
  }
  safeLocalSet(HINT_KEY, 'true');
}

// Initialize when showing unified editor
export function initUnifiedEditor() {
  initUnifiedEditorInput();
  ueState.devicePixelRatio = Math.min(window.devicePixelRatio || 1, MAX_CANVAS_DPR);

  ueShowSignatureHint();

  // Setup drop zone for thumbnails area
  const thumbnails = document.getElementById('ue-thumbnails');
  if (thumbnails && !thumbnails._dropSetup) {
    thumbnails._dropSetup = true;
    thumbnails.addEventListener('dragover', (e) => {
      e.preventDefault();
      thumbnails.classList.add('drag-over');
    });
    thumbnails.addEventListener('dragleave', () => {
      thumbnails.classList.remove('drag-over');
    });
    thumbnails.addEventListener('drop', async (e) => {
      e.preventDefault();
      thumbnails.classList.remove('drag-over');
      if (e.dataTransfer.files.length > 0) {
        showFullscreenLoading('Menambahkan PDF...');
        try {
          await ueAddFiles(e.dataTransfer.files);
        } catch (error) {
          console.error('Error adding PDF:', error);
          showToast('Gagal menambahkan PDF', 'error');
        } finally {
          hideFullscreenLoading();
        }
      }
    });
  }

  // Create renderer instance + setup scroll sync for continuous vertical scroll
  // WHY explicit: constructor does NOT auto-call setupScrollSync() — caller controls
  // when listeners attach. Resize handler is consolidated inside the class.
  createPageRenderer();
  ueSetupScrollSync();
}
