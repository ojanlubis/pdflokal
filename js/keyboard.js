/*
 * PDFLokal - keyboard.js (ES Module)
 * Keyboard shortcuts, shortcuts modal, and paste handler
 */

import { state, ueState } from './lib/state.js';
import { showHome, openModal, closeModal, closeAllModals, hasOpenModal } from './lib/navigation.js';

// WHY: Escape needs to dismiss any open dropdown before falling through to "exit editor".
// These are the dropdown IDs that can be open inside the editor — kept here as a small
// list because each is opened/closed by hand-rolled toggle functions, not via openModal().
// If a new dropdown is added in the editor, add its ID here too.
const EDITOR_DROPDOWN_IDS = ['ft-more-dropdown', 'mobile-tools-dropdown', 'more-tools-dropdown'];

function closeOpenEditorDropdown() {
  for (const id of EDITOR_DROPDOWN_IDS) {
    const el = document.getElementById(id);
    if (el?.classList.contains('active')) {
      el.classList.remove('active');
      return true;
    }
  }
  // File menu in editor header uses `.open`, not `.active`
  const fileDropdown = document.getElementById('editor-file-dropdown');
  if (fileDropdown?.classList.contains('open')) {
    fileDropdown.classList.remove('open');
    return true;
  }
  return false;
}

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

// WHY: Ctrl+Z while drawing in the signature/paraf modal must rewind the last
// PEN STROKE — not fire the global editor undo (which rolls back a document
// annotation the user can't even see behind the modal). SignaturePad has no
// undo(), but supports the data-rewind pattern. Returns true if it handled the
// key (so the caller consumes it).
function rewindSignaturePadIfOpen(key) {
  if (key !== 'z') return false; // only undo; the pad has no redo
  const sigOpen = document.getElementById('signature-modal')?.classList.contains('active');
  const parafOpen = document.getElementById('paraf-modal')?.classList.contains('active');
  const pad = sigOpen ? state.signaturePad : (parafOpen ? state.parafPad : null);
  if (!pad || typeof pad.toData !== 'function') return false;
  const data = pad.toData();
  if (data.length > 0) pad.fromData(data.slice(0, -1));
  return true; // consume even when empty, so it never falls through to ueUndo
}

// Arrow-key nudge for a selected, non-locked annotation (Shift = 10px). Returns
// true if it moved something. One undo snapshot per burst of taps (debounced),
// so holding/spamming arrows is a single undo entry, not one-per-pixel.
let nudgeUndoTimer = null;
function nudgeSelectedAnnotation(dx, dy) {
  const sel = ueState.selectedAnnotation;
  if (!sel) return false;
  const anno = ueState.annotations[sel.pageIndex]?.[sel.index];
  if (!anno || anno.locked) return false;

  if (!nudgeUndoTimer) window.ueSaveEditUndoState();
  clearTimeout(nudgeUndoTimer);
  nudgeUndoTimer = setTimeout(() => { nudgeUndoTimer = null; }, 500);

  anno.x += dx;
  anno.y += dy;
  window.ueRedrawAnnotations();
  window.ueUpdateConfirmButtonPosition?.(anno);
  window.repositionTextFormatBar?.();
  return true;
}

const NUDGE_VECTORS = {
  ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
};

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

function handleEscapeKey(isTyping) {
  // WHY: When typing in an input/textarea/contentEditable (e.g. inline text editor,
  // signature name field), Escape is the local widget's own cancel gesture — must not
  // bubble up to "navigate home" or close the surrounding workspace.
  if (isTyping) return;

  // WHY (cascade): Escape dismisses the topmost overlay, not the editor itself.
  // Before the cascade existed, Escape from any modal/dropdown fell straight through
  // to showHome() and wiped the user's in-progress edits. Documented in
  // memory/ux-audit-2026-05-30.md (finding C1).
  // Order: open modal -> open dropdown -> finally exit editor as a last resort.
  if (hasOpenModal()) {
    closeAllModals();
    return;
  }
  if (closeOpenEditorDropdown()) return;

  if (state.currentTool) showHome();
}

export function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    const key = e.key.toLowerCase();
    const activeEl = document.activeElement;
    const isTyping = activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA' || activeEl.isContentEditable);
    const inEditor = state.currentTool === 'unified-editor';

    if (e.key === 'Escape') { handleEscapeKey(isTyping); return; }

    // Modifier combos (Ctrl/Cmd + key)
    if ((e.ctrlKey || e.metaKey) && inEditor && modifierHandlers[key]) {
      if (key === 'z' || key === 'y') {
        // Drawing modal open → rewind the pen stroke, not the document.
        if (rewindSignaturePadIfOpen(key)) { e.preventDefault(); return; }
        // Typing in a field / inline text editor → let native undo/redo run.
        if (isTyping) return;
      }
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

    // Arrow keys nudge a selected annotation (Shift = 10px) instead of paging.
    // Only when something's selected; otherwise arrows fall through to page nav.
    if (NUDGE_VECTORS[e.key] && ueState.selectedAnnotation) {
      const mult = e.shiftKey ? 10 : 1;
      const [ux, uy] = NUDGE_VECTORS[e.key];
      if (nudgeSelectedAnnotation(ux * mult, uy * mult)) { e.preventDefault(); return; }
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
