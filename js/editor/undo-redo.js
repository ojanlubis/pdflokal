/*
 * PDFLokal - editor/undo-redo.js (ES Module)
 * Unified undo/redo stack for both page operations and annotation operations.
 *
 * WHY unified: Users expect Ctrl+Z to undo the last action regardless of type.
 * Separate stacks meant page reorder/delete was never undoable from the UI.
 * Each entry is tagged { type: 'page' | 'annotation', ... } so the correct
 * restore logic runs on undo/redo.
 */

import { ueState, UNDO_STACK_LIMIT, getRegisteredImage, createPageInfo } from '../lib/state.js';
import { emit } from '../lib/events.js';
import { showToast, loadPdfDocument } from '../lib/utils.js';
import { ueRedrawAnnotations } from './annotations.js';
import { renderPageThumbnail } from './canvas-utils.js';

// WHY: Strips cachedImg (HTMLImageElement, not cloneable) and image (base64 string, huge).
// Stores imageId reference instead — getRegisteredImage() recovers the data on restore.
// Without this, undo stack would clone megabytes of base64 per snapshot.
function cloneAnnotations(annotations) {
  const result = {};
  for (const key in annotations) {
    result[key] = annotations[key].map(anno => {
      const clone = { ...anno };
      // Strip cached HTMLImageElement (not serializable anyway)
      delete clone.cachedImg;
      // For signatures, store only imageId reference (not the full base64 string)
      if (clone.type === 'signature' && clone.imageId) {
        delete clone.image;
      }
      return clone;
    });
  }
  return JSON.parse(JSON.stringify(result));
}

function restoreAnnotations(cloned) {
  // Re-hydrate signature image references from registry
  for (const key in cloned) {
    cloned[key].forEach(anno => {
      if (anno.type === 'signature' && anno.imageId && !anno.image) {
        anno.image = getRegisteredImage(anno.imageId);
      }
    });
  }
  return cloned;
}

// Serialize current page order/rotation for the undo stack (lightweight, no canvases)
function serializePages() {
  return JSON.parse(JSON.stringify(ueState.pages.map(p => ({
    pageNum: p.pageNum,
    sourceIndex: p.sourceIndex,
    sourceName: p.sourceName,
    rotation: p.rotation,
    isFromImage: p.isFromImage
  }))));
}

// ============================================================
// UNIFIED SAVE FUNCTIONS
// ============================================================

// Save page state before reorder/delete/rotate operations
export function ueSaveUndoState() {
  ueState.undoStack.push({ type: 'page', pages: serializePages() });
  ueState.redoStack = [];
  if (ueState.undoStack.length > UNDO_STACK_LIMIT) ueState.undoStack.shift();
}

// Save annotation state before annotation changes
export function ueSaveEditUndoState() {
  ueState.undoStack.push({ type: 'annotation', annotations: cloneAnnotations(ueState.annotations) });
  ueState.redoStack = [];
  if (ueState.undoStack.length > UNDO_STACK_LIMIT) ueState.undoStack.shift();
}

// SINGLE SOURCE OF TRUTH — push a pre-captured annotation snapshot to the unified stack.
// WHY needed: canvas-events.js captures preChangeState before drag/resize starts,
// then pushes it only if the user actually moved something. Can't use ueSaveEditUndoState()
// because that captures state at push time, not at drag-start time.
export function uePushAnnotationSnapshot(snapshot) {
  ueState.undoStack.push({ type: 'annotation', annotations: snapshot });
  ueState.redoStack = [];
  if (ueState.undoStack.length > UNDO_STACK_LIMIT) ueState.undoStack.shift();
}

// ============================================================
// UNIFIED UNDO / REDO
// ============================================================

export function ueUndo() {
  if (ueState.undoStack.length === 0 || ueState.isRestoring) return;

  const entry = ueState.undoStack.pop();

  if (entry.type === 'page') {
    ueState.redoStack.push({ type: 'page', pages: serializePages() });
    ueRestorePages(entry.pages);
    showToast('Undo halaman', 'info');
  } else if (entry.type === 'annotation') {
    ueState.redoStack.push({ type: 'annotation', annotations: cloneAnnotations(ueState.annotations) });
    ueState.annotations = restoreAnnotations(entry.annotations);
    ueState.selectedAnnotation = null;
    ueRedrawAnnotations();
    showToast('Undo edit', 'info');
  }
}

export function ueRedo() {
  if (ueState.redoStack.length === 0 || ueState.isRestoring) return;

  const entry = ueState.redoStack.pop();

  if (entry.type === 'page') {
    ueState.undoStack.push({ type: 'page', pages: serializePages() });
    ueRestorePages(entry.pages);
    showToast('Redo halaman', 'info');
  } else if (entry.type === 'annotation') {
    ueState.undoStack.push({ type: 'annotation', annotations: cloneAnnotations(ueState.annotations) });
    ueState.annotations = restoreAnnotations(entry.annotations);
    ueState.selectedAnnotation = null;
    ueRedrawAnnotations();
    showToast('Redo edit', 'info');
  }
}

// ============================================================
// PAGE RESTORE (async — reloads PDFs, re-renders thumbnails)
// ============================================================

async function ueRestorePages(pagesData) {
  // WHY: isRestoring flag prevents scroll-sync and other listeners from interfering
  // while pages are being rebuilt async during undo/redo.
  ueState.isRestoring = true;
  try {
  // Regenerate pages from pagesData — store dimensions + thumbnail, render lazily
  ueState.pages = [];
  for (const pageData of pagesData) {
    const source = ueState.sourceFiles[pageData.sourceIndex];
    const pdf = await loadPdfDocument(source.bytes);
    const page = await pdf.getPage(pageData.pageNum + 1);
    const viewport = page.getViewport({ scale: 0.5, rotation: pageData.rotation });

    const thumbCanvas = await renderPageThumbnail(page, { rotation: pageData.rotation });

    ueState.pages.push(createPageInfo({
      ...pageData,
      canvas: { width: viewport.width, height: viewport.height },
      thumbCanvas,
    }));
  }
  ueState.pageCaches = {};

  // Use window.* to avoid circular imports with page-rendering
  window.ueCreatePageSlots();
  emit('pages:changed', { source: 'restore' });
  if (ueState.selectedPage >= ueState.pages.length) {
    ueState.selectedPage = ueState.pages.length - 1;
  }
  if (ueState.selectedPage >= 0) {
    window.ueSelectPage(ueState.selectedPage);
  }
  } catch (err) {
    console.error('Undo restore failed:', err);
    showToast('Gagal mengembalikan perubahan', 'error');
  } finally {
    ueState.isRestoring = false;
  }
}

// ============================================================
// CONVENIENCE
// ============================================================

// WHY: Clears edits on the CURRENT page only, not the whole document.
// UX audit (C3): previous label "Hapus Semua" was ambiguous — users feared
// it would wipe every page. Confirm() guards against accidental clears
// since the action is undoable but still surprising on mobile thumb taps.
export function ueClearPageAnnotations() {
  if (ueState.selectedPage < 0) return;
  // WHY ?.length: closes Sentry JAVASCRIPT-7. annotations[selectedPage] can be
  // undefined when the index map gets out of sync (e.g. selection survives a
  // page-reorder or delete that didn't reseat the per-page bucket). Treat the
  // missing bucket as "nothing to clear".
  if (!ueState.annotations[ueState.selectedPage]?.length) return;

  const pageNum = ueState.selectedPage + 1;
  if (!confirm(`Hapus semua edit di Halaman ${pageNum}? Halaman lain tidak terpengaruh.`)) return;

  ueSaveEditUndoState();
  ueState.annotations[ueState.selectedPage] = [];
  ueState.selectedAnnotation = null;
  ueRedrawAnnotations();
  showToast(`Edit di Halaman ${pageNum} dihapus`, 'success');
}
