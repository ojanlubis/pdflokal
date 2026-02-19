/*
 * PDFLokal - editor/undo-redo.js (ES Module)
 * Undo/redo for both page operations and annotation operations
 */

import { ueState } from '../lib/state.js';
import { showToast } from '../lib/utils.js';
import { ueRedrawAnnotations } from './annotations.js';

// --- Page operation undo/redo ---

export function ueSaveUndoState() {
  ueState.undoStack.push(JSON.parse(JSON.stringify(ueState.pages.map(p => ({
    pageNum: p.pageNum,
    sourceIndex: p.sourceIndex,
    sourceName: p.sourceName,
    rotation: p.rotation
  })))));
  ueState.redoStack = [];
  if (ueState.undoStack.length > 50) ueState.undoStack.shift();
}

export function ueUndo() {
  if (ueState.undoStack.length === 0) return;
  // Save current state to redo
  ueState.redoStack.push(JSON.parse(JSON.stringify(ueState.pages.map(p => ({
    pageNum: p.pageNum,
    sourceIndex: p.sourceIndex,
    sourceName: p.sourceName,
    rotation: p.rotation
  })))));

  const prevState = ueState.undoStack.pop();
  ueRestorePages(prevState);
}

export function ueRedo() {
  if (ueState.redoStack.length === 0) return;
  // Save current to undo
  ueState.undoStack.push(JSON.parse(JSON.stringify(ueState.pages.map(p => ({
    pageNum: p.pageNum,
    sourceIndex: p.sourceIndex,
    sourceName: p.sourceName,
    rotation: p.rotation
  })))));

  const nextState = ueState.redoStack.pop();
  ueRestorePages(nextState);
}

async function ueRestorePages(pagesData) {
  // Regenerate pages from pagesData
  ueState.pages = [];
  for (const pageData of pagesData) {
    const source = ueState.sourceFiles[pageData.sourceIndex];
    const pdf = await pdfjsLib.getDocument({ data: source.bytes.slice() }).promise;
    const page = await pdf.getPage(pageData.pageNum + 1);
    const viewport = page.getViewport({ scale: 0.5, rotation: pageData.rotation });

    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    ueState.pages.push({
      ...pageData,
      canvas
    });
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
}

// --- Annotation undo/redo ---

export function ueSaveEditUndoState() {
  ueState.editUndoStack.push(JSON.parse(JSON.stringify(ueState.annotations)));
  ueState.editRedoStack = [];
  if (ueState.editUndoStack.length > 50) ueState.editUndoStack.shift();
}

export function ueUndoAnnotation() {
  if (ueState.editUndoStack.length === 0) return;
  ueState.editRedoStack.push(JSON.parse(JSON.stringify(ueState.annotations)));
  ueState.annotations = ueState.editUndoStack.pop();
  ueState.selectedAnnotation = null;
  ueRedrawAnnotations();
}

export function ueRedoAnnotation() {
  if (ueState.editRedoStack.length === 0) return;
  ueState.editUndoStack.push(JSON.parse(JSON.stringify(ueState.annotations)));
  ueState.annotations = ueState.editRedoStack.pop();
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
