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

// WHY: Handler maps replace giant if/else chains to reduce cognitive complexity (S3776).
// Each map entry is { handler, preventDefault }. Maps are checked in priority order.

// Modifier shortcuts (Ctrl/Cmd + key) — always active in editor
const modifierHandlers = {
  s: { handler: () => { if (ueState.pages.length > 0) window.ueDownload(); } },
  z: { handler: () => window.ueUndo() },
  y: { handler: () => window.ueRedo() },
};

// Tool shortcuts (single key, no modifier) — only when page selected and not typing
const toolHandlers = {
  v: () => window.ueSetTool('select'),
  w: () => window.ueSetTool('whiteout'),
  t: () => window.ueSetTool('text'),
  s: () => window.ueOpenSignatureModal(),
  p: () => window.ueOpenParafModal(),
  r: () => window.ueRotateCurrentPage(),
};

function handleDeleteKey(e) {
  if (ueState.selectedAnnotation) {
    e.preventDefault();
    window.ueSaveEditUndoState();
    window.ueRemoveAnnotation(ueState.selectedAnnotation.pageIndex, ueState.selectedAnnotation.index);
    window.ueRedrawAnnotations();
  }
}

function handleEditorNavigation(e) {
  const key = e.key;
  if (key === 'ArrowLeft' && ueState.selectedPage > 0) {
    e.preventDefault();
    window.ueSelectPage(ueState.selectedPage - 1);
  } else if (key === 'ArrowRight' && ueState.selectedPage < ueState.pages.length - 1) {
    e.preventDefault();
    window.ueSelectPage(ueState.selectedPage + 1);
  } else if (key === '?' || (e.shiftKey && e.key.toLowerCase() === '/')) {
    e.preventDefault();
    openShortcutsModal();
  } else if (key === '+' || key === '=') {
    e.preventDefault();
    window.ueZoomIn();
  } else if (key === '-') {
    e.preventDefault();
    window.ueZoomOut();
  } else if (key === '0') {
    e.preventDefault();
    window.ueZoomReset();
  }
}

export function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    const activeEl = document.activeElement;
    const isTyping = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable);
    const inEditor = state.currentTool === 'unified-editor';

    // Escape — close modals or go home
    if (e.key === 'Escape') {
      const shortcutsModal = document.getElementById('shortcuts-modal');
      if (shortcutsModal?.classList.contains('active')) {
        closeShortcutsModal();
        return;
      }
      if (state.currentTool) showHome();
      return;
    }

    // Modifier combos (Ctrl/Cmd + key)
    if ((e.ctrlKey || e.metaKey) && inEditor && modifierHandlers[key]) {
      e.preventDefault();
      modifierHandlers[key].handler();
      return;
    }

    // Editor tool/navigation shortcuts (only when not typing)
    if (inEditor && !isTyping) {
      if (ueState.selectedPage >= 0) {
        if (!e.ctrlKey && !e.metaKey && toolHandlers[key]) {
          toolHandlers[key]();
          return;
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
          handleDeleteKey(e);
          return;
        }
      }
      handleEditorNavigation(e);
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
