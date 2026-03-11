/*
 * PDFLokal - keyboard.js (ES Module)
 * Keyboard shortcuts, shortcuts modal, and paste handler
 */

import { state, ueState } from './lib/state.js';
import { showHome, openModal, closeModal } from './lib/navigation.js';

// WHY: Editor functions accessed via window.* bridges (set by editor/index.js)
// instead of static import. Static import of editor/index.js pulled in 15 sub-modules
// and blocked homepage from being interactive. All these functions are only called
// when state.currentTool === 'unified-editor', so window bridges are guaranteed set.

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
        window.ueDownload();
      }
    }

    // Ctrl+Z for undo in unified editor
    if (key === 'z' && (e.ctrlKey || e.metaKey) && state.currentTool === 'unified-editor') {
      e.preventDefault();
      window.ueUndo();
    }

    // Ctrl+Y for redo in unified editor
    if (key === 'y' && (e.ctrlKey || e.metaKey) && state.currentTool === 'unified-editor') {
      e.preventDefault();
      window.ueRedo();
    }

    // Keyboard shortcuts for unified editor tools (only when not typing)
    if (state.currentTool === 'unified-editor' && !isTyping) {
      if (ueState.selectedPage >= 0) {
        if (key === 'v' && !e.ctrlKey && !e.metaKey) {
          window.ueSetTool('select');
        } else if (key === 'w' && !e.ctrlKey && !e.metaKey) {
          window.ueSetTool('whiteout');
        } else if (key === 't' && !e.ctrlKey && !e.metaKey) {
          window.ueSetTool('text');
        } else if (key === 's' && !e.ctrlKey && !e.metaKey) {
          window.ueOpenSignatureModal();
        } else if (key === 'p' && !e.ctrlKey && !e.metaKey) {
          window.ueOpenParafModal();
        } else if (key === 'r' && !e.ctrlKey && !e.metaKey) {
          window.ueRotateCurrentPage();
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          if (ueState.selectedAnnotation) {
            e.preventDefault();
            window.ueSaveEditUndoState();
            window.ueRemoveAnnotation(ueState.selectedAnnotation.pageIndex, ueState.selectedAnnotation.index);
            window.ueRedrawAnnotations();
          }
        }
      }

      if (e.key === 'ArrowLeft' && ueState.selectedPage > 0) {
        e.preventDefault();
        window.ueSelectPage(ueState.selectedPage - 1);
      } else if (e.key === 'ArrowRight' && ueState.selectedPage < ueState.pages.length - 1) {
        e.preventDefault();
        window.ueSelectPage(ueState.selectedPage + 1);
      }

      if (e.key === '?' || (e.shiftKey && key === '/')) {
        e.preventDefault();
        openShortcutsModal();
      }

      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        window.ueZoomIn();
      } else if (e.key === '-') {
        e.preventDefault();
        window.ueZoomOut();
      } else if (e.key === '0') {
        e.preventDefault();
        window.ueZoomReset();
      }
    }
  });
}

// ============================================================
// KEYBOARD SHORTCUTS MODAL
// ============================================================

export function openShortcutsModal() {
  openModal('shortcuts-modal');
}

export function closeShortcutsModal() {
  closeModal('shortcuts-modal');
}

// Window bridges for onclick handlers
window.openShortcutsModal = openShortcutsModal;
window.closeShortcutsModal = closeShortcutsModal;
