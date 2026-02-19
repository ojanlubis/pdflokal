/*
 * PDFLokal - editor/zoom-rotate.js (ES Module)
 * Zoom in/out/reset and page rotation
 */

import { ueState } from '../lib/state.js';
import { showToast } from '../lib/utils.js';
import { ueRenderVisiblePages, ueRenderSelectedPage } from './page-rendering.js';
import { ueRenderThumbnails } from './sidebar.js';
import { ueSaveUndoState } from './undo-redo.js';

export function ueZoomIn() {
  ueState.zoomLevel = Math.min(ueState.zoomLevel + 0.25, 3);
  ueUpdateZoomDisplay();
  ueRenderVisiblePages();
}

export function ueZoomOut() {
  ueState.zoomLevel = Math.max(ueState.zoomLevel - 0.25, 0.5);
  ueUpdateZoomDisplay();
  ueRenderVisiblePages();
}

export function ueZoomReset() {
  ueState.zoomLevel = 1.0;
  ueUpdateZoomDisplay();
  ueRenderVisiblePages();
}

// Rotate current page 90 degrees clockwise
export function ueRotateCurrentPage() {
  if (ueState.pages.length === 0 || ueState.selectedPage < 0) return;

  ueSaveUndoState();

  const page = ueState.pages[ueState.selectedPage];
  page.rotation = ((page.rotation || 0) + 90) % 360;

  ueRenderSelectedPage();
  ueRenderThumbnails();

  showToast('Halaman diputar', 'success');
}

export function ueUpdateZoomDisplay() {
  const display = document.getElementById('ue-zoom-level');
  if (display) {
    display.textContent = Math.round(ueState.zoomLevel * 100) + '%';
  }
}
