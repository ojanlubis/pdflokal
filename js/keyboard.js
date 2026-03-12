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

// WHY: Navigation handlers extracted from keydown listener to reduce complexity (S3776).
// Map pattern: key → { handler, preventDefault }. Same pattern as modifier/tool handlers.
const navigationHandlers = {
  'ArrowLeft': { handler: () => { if (ueState.selectedPage > 0) window.ueSelectPage(ueState.selectedPage - 1); }, preventDefault: true },
  'ArrowRight': { handler: () => { if (ueState.selectedPage < ueState.pages.length - 1) window.ueSelectPage(ueState.selectedPage + 1); }, preventDefault: true },
  '?': { handler: () => openShortcutsModal(), preventDefault: true },
  '+': { handler: () => window.ueZoomIn(), preventDefault: true },
  '=': { handler: () => window.ueZoomIn(), preventDefault: true },
  '-': { handler: () => window.ueZoomOut(), preventDefault: true },
  '0': { handler: () => window.ueZoomReset(), preventDefault: true },
};

function handleEscapeKey() {
  const shortcutsModal = document.getElementById('shortcuts-modal');
  if (shortcutsModal?.classList.contains('active')) {
    closeShortcutsModal();
    return;
  }
  if (state.currentTool) showHome();
}

export function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    const activeEl = document.activeElement;
    const isTyping = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable);
    const inEditor = state.currentTool === 'unified-editor';

    if (e.key === 'Escape') { handleEscapeKey(); return; }

    // Modifier combos (Ctrl/Cmd + key)
    if ((e.ctrlKey || e.metaKey) && inEditor && modifierHandlers[key]) {
      e.preventDefault();
      modifierHandlers[key].handler();
      return;
    }

    // Editor tool/navigation shortcuts (only when not typing)
    if (!inEditor || isTyping) return;

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

    const nav = navigationHandlers[e.key];
    if (nav) {
      if (nav.preventDefault) e.preventDefault();
      nav.handler();
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
