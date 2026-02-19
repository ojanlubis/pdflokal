/*
 * PDFLokal - keyboard.js (ES Module)
 * Keyboard shortcuts, shortcuts modal, and paste handler
 */

import { state, ueState } from './lib/state.js';
import { showHome } from './lib/navigation.js';
import {
  ueDownload, ueUndoAnnotation, ueRedoAnnotation, ueSaveEditUndoState,
  ueSetTool, ueOpenSignatureModal, ueRotateCurrentPage,
  ueRedrawAnnotations, ueSelectPage
} from './editor/index.js';

// ============================================================
// KEYBOARD SHORTCUTS
// ============================================================

export function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();

    const activeEl = document.activeElement;
    const isTyping = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable);

    // Escape - close modals or go back home
    if (e.key === 'Escape') {
      const shortcutsModal = document.getElementById('shortcuts-modal');
      if (shortcutsModal && shortcutsModal.classList.contains('active')) {
        closeShortcutsModal();
        return;
      }
      if (state.currentTool) {
        showHome();
      }
    }

    // Ctrl+S / Cmd+S - Download PDF in unified editor
    if ((e.ctrlKey || e.metaKey) && key === 's') {
      e.preventDefault();
      if (state.currentTool === 'unified-editor' && ueState.pages.length > 0) {
        ueDownload();
      }
    }

    // Ctrl+Z for undo in unified editor
    if (key === 'z' && (e.ctrlKey || e.metaKey) && state.currentTool === 'unified-editor') {
      e.preventDefault();
      ueUndoAnnotation();
    }

    // Ctrl+Y for redo in unified editor
    if (key === 'y' && (e.ctrlKey || e.metaKey) && state.currentTool === 'unified-editor') {
      e.preventDefault();
      ueRedoAnnotation();
    }

    // Keyboard shortcuts for unified editor tools (only when not typing)
    if (state.currentTool === 'unified-editor' && !isTyping) {
      if (ueState.selectedPage >= 0) {
        if (key === 'v' && !e.ctrlKey && !e.metaKey) {
          ueSetTool('select');
        } else if (key === 'w' && !e.ctrlKey && !e.metaKey) {
          ueSetTool('whiteout');
        } else if (key === 't' && !e.ctrlKey && !e.metaKey) {
          ueSetTool('text');
        } else if (key === 's' && !e.ctrlKey && !e.metaKey) {
          ueOpenSignatureModal();
        } else if (key === 'r' && !e.ctrlKey && !e.metaKey) {
          ueRotateCurrentPage();
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          if (ueState.selectedAnnotation) {
            e.preventDefault();
            ueSaveEditUndoState();
            ueState.annotations[ueState.selectedAnnotation.pageIndex].splice(ueState.selectedAnnotation.index, 1);
            ueState.selectedAnnotation = null;
            ueRedrawAnnotations();
          }
        }
      }

      if (e.key === 'ArrowLeft' && ueState.selectedPage > 0) {
        e.preventDefault();
        ueSelectPage(ueState.selectedPage - 1);
      } else if (e.key === 'ArrowRight' && ueState.selectedPage < ueState.pages.length - 1) {
        e.preventDefault();
        ueSelectPage(ueState.selectedPage + 1);
      }

      if (e.key === '?' || (e.shiftKey && key === '/')) {
        e.preventDefault();
        openShortcutsModal();
      }
    }
  });
}

// ============================================================
// KEYBOARD SHORTCUTS MODAL
// ============================================================

export function openShortcutsModal() {
  const modal = document.getElementById('shortcuts-modal');
  if (modal) {
    modal.classList.add('active');
  }
}

export function closeShortcutsModal() {
  const modal = document.getElementById('shortcuts-modal');
  if (modal) {
    modal.classList.remove('active');
  }
}

// Window bridges for onclick handlers
window.openShortcutsModal = openShortcutsModal;
window.closeShortcutsModal = closeShortcutsModal;
