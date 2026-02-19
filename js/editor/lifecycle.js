/*
 * PDFLokal - editor/lifecycle.js (ES Module)
 * Editor initialization, reset, signature hints
 */

import { ueState, state } from '../lib/state.js';
import { showToast, showFullscreenLoading, hideFullscreenLoading } from '../lib/utils.js';
import { initUnifiedEditorInput, ueAddFiles } from './file-loading.js';
import { ueRenderThumbnails } from './sidebar.js';
import { ueCreatePageSlots, ueSetupScrollSync, ueSetWrapperHeight, ueUpdatePageCount, ueRenderVisiblePages } from './page-rendering.js';
import { ueUpdateZoomDisplay } from './zoom-rotate.js';

// Reset unified editor state
export function ueReset() {
  ueState.pages = [];
  ueState.sourceFiles = [];
  ueState.selectedPage = -1;
  ueState.currentTool = null;
  ueState.annotations = {};
  ueState.undoStack = [];
  ueState.redoStack = [];
  ueState.editUndoStack = [];
  ueState.editRedoStack = [];
  ueState.selectedAnnotation = null;
  ueState.pendingTextPosition = null;
  ueState.pageScales = {};
  ueState.pageCaches = {};
  ueState.pageCanvases = [];
  if (ueState.pageObserver) { ueState.pageObserver.disconnect(); ueState.pageObserver = null; }
  ueState.scrollSyncEnabled = true;
  window._ueScrollSyncSetup = false;
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
  if (localStorage.getItem(HINT_KEY)) return;

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
  localStorage.setItem(HINT_KEY, 'true');
}

// Initialize when showing unified editor
export function initUnifiedEditor() {
  initUnifiedEditorInput();
  ueState.devicePixelRatio = window.devicePixelRatio || 1;

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

  // Setup scroll sync for continuous vertical scroll
  ueSetupScrollSync();

  // Setup resize handler
  if (!window._ueResizeHandler) {
    let resizeTimeout;
    window._ueResizeHandler = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        if (state.currentTool === 'unified-editor' && ueState.pages.length > 0) {
          ueSetWrapperHeight();
          ueRenderVisiblePages();
        }
      }, 200);
    };
    window.addEventListener('resize', window._ueResizeHandler);
  }
}
