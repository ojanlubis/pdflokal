/*
 * PDFLokal - editor/undo-redo.js (ES Module)
 * Undo/redo for both page operations and annotation operations
 */

import { ueState, UNDO_STACK_LIMIT, getRegisteredImage, createPageInfo } from '../lib/state.js';
import { showToast } from '../lib/utils.js';
import { ueRedrawAnnotations } from './annotations.js';

// Clone annotations without duplicating large base64 image strings.
// Signature annotations store imageId (registry key) instead of raw image data.
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

// --- Page operation undo/redo ---

export function ueSaveUndoState() {
  ueState.undoStack.push(JSON.parse(JSON.stringify(ueState.pages.map(p => ({
    pageNum: p.pageNum,
    sourceIndex: p.sourceIndex,
    sourceName: p.sourceName,
    rotation: p.rotation,
    isFromImage: p.isFromImage
  })))));
  ueState.redoStack = [];
  if (ueState.undoStack.length > UNDO_STACK_LIMIT) ueState.undoStack.shift();
}

export function ueUndo() {
  if (ueState.undoStack.length === 0 || ueState.isRestoring) return;
  // Save current state to redo
  ueState.redoStack.push(JSON.parse(JSON.stringify(ueState.pages.map(p => ({
    pageNum: p.pageNum,
    sourceIndex: p.sourceIndex,
    sourceName: p.sourceName,
    rotation: p.rotation,
    isFromImage: p.isFromImage
  })))));

  const prevState = ueState.undoStack.pop();
  ueRestorePages(prevState);
}

export function ueRedo() {
  if (ueState.redoStack.length === 0 || ueState.isRestoring) return;
  // Save current to undo
  ueState.undoStack.push(JSON.parse(JSON.stringify(ueState.pages.map(p => ({
    pageNum: p.pageNum,
    sourceIndex: p.sourceIndex,
    sourceName: p.sourceName,
    rotation: p.rotation,
    isFromImage: p.isFromImage
  })))));

  const nextState = ueState.redoStack.pop();
  ueRestorePages(nextState);
}

async function ueRestorePages(pagesData) {
  ueState.isRestoring = true;
  try {
  // Regenerate pages from pagesData — store dimensions + thumbnail, render lazily
  ueState.pages = [];
  for (const pageData of pagesData) {
    const source = ueState.sourceFiles[pageData.sourceIndex];
    const pdf = await pdfjsLib.getDocument({ data: source.bytes.slice() }).promise;
    const page = await pdf.getPage(pageData.pageNum + 1);
    const viewport = page.getViewport({ scale: 0.5, rotation: pageData.rotation });

    // Re-render thumbnail canvas for sidebar (matches file-loading.js pattern)
    const thumbScale = 150 / page.getViewport({ scale: 1 }).width;
    const thumbVp = page.getViewport({ scale: thumbScale, rotation: pageData.rotation });
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = Math.round(thumbVp.width);
    thumbCanvas.height = Math.round(thumbVp.height);
    await page.render({ canvasContext: thumbCanvas.getContext('2d'), viewport: thumbVp }).promise;

    ueState.pages.push(createPageInfo({
      ...pageData,
      canvas: { width: viewport.width, height: viewport.height },
      thumbCanvas,
    }));
  }
  ueState.pageCaches = {};

  // Use window.* to avoid circular imports with page-rendering and sidebar
  window.ueCreatePageSlots();
  window.ueRenderThumbnails();
  window.ueUpdatePageCount();
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

// --- Annotation undo/redo ---

export function ueSaveEditUndoState() {
  ueState.editUndoStack.push(cloneAnnotations(ueState.annotations));
  ueState.editRedoStack = [];
  if (ueState.editUndoStack.length > UNDO_STACK_LIMIT) ueState.editUndoStack.shift();
}

export function ueUndoAnnotation() {
  if (ueState.editUndoStack.length === 0) return;
  ueState.editRedoStack.push(cloneAnnotations(ueState.annotations));
  ueState.annotations = restoreAnnotations(ueState.editUndoStack.pop());
  ueState.selectedAnnotation = null;
  ueRedrawAnnotations();
}

export function ueRedoAnnotation() {
  if (ueState.editRedoStack.length === 0) return;
  ueState.editUndoStack.push(cloneAnnotations(ueState.annotations));
  ueState.annotations = restoreAnnotations(ueState.editRedoStack.pop());
  ueState.selectedAnnotation = null;
  ueRedrawAnnotations();
}

// Clear page annotations
export function ueClearPageAnnotations() {
  if (ueState.selectedPage < 0) return;
  if (ueState.annotations[ueState.selectedPage].length === 0) return;

  ueSaveEditUndoState();
  ueState.annotations[ueState.selectedPage] = [];
  ueState.selectedAnnotation = null;
  ueRedrawAnnotations();
  showToast('Semua edit di halaman ini dihapus', 'success');
}
