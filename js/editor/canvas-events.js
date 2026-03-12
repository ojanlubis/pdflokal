/*
 * PDFLokal - editor/canvas-events.js (ES Module)
 * Canvas event handling (mouse, touch, drag, resize, double-click)
 */

import { ueState, state, DOUBLE_TAP_DELAY, DOUBLE_TAP_DISTANCE, createWhiteoutAnnotation } from '../lib/state.js';
import { emit } from '../lib/events.js';
import { showToast } from '../lib/utils.js';
import { ueGetCoords, ueGetResizeHandle, getTextBounds } from './canvas-utils.js';
import { ueRedrawAnnotations, ueFindAnnotationAt, ueAddAnnotation } from './annotations.js';
import { ueSaveEditUndoState, uePushAnnotationSnapshot } from './undo-redo.js';
import { ueCreateInlineTextEditor } from './inline-editor.js';
import { ueHighlightThumbnail } from './page-rendering.js';
import { ueZoomIn, ueZoomOut } from './zoom-rotate.js';
import { track } from '../lib/analytics.js';
import {
  uePlaceSignature, ueDrawSignaturePreview,
  ueShowConfirmButton, ueHideConfirmButton, ueUpdateConfirmButtonPosition
} from './signatures.js';

function getCanvasAndIndex(target) {
  const canvas = target.closest ? target.closest('.ue-page-slot canvas') : null;
  if (!canvas) return null;
  const slot = canvas.parentElement;
  const pageIndex = Number.parseInt(slot.dataset.pageIndex, 10);
  if (Number.isNaN(pageIndex)) return null;
  return { canvas, pageIndex };
}

// WHY: Module-level helpers (not closure-dependent) moved out of ueSetupCanvasEvents
// to satisfy S7721 ("move function to outer scope").
function infoFromMouse(e) {
  const hit = getCanvasAndIndex(e.target);
  if (!hit) return null;
  const coords = ueGetCoords(e, hit.canvas);
  return { canvas: hit.canvas, pageIndex: hit.pageIndex, x: coords.x, y: coords.y };
}

function infoFromTouch(e) {
  const touch = (e.touches?.length) ? e.touches[0] : e.changedTouches[0];
  const hit = getCanvasAndIndex(e.target);
  if (!hit) return null;
  const coords = ueGetCoords(touch, hit.canvas);
  return { canvas: hit.canvas, pageIndex: hit.pageIndex, x: coords.x, y: coords.y };
}

function resizeTextAnnotation(anno, info, handle, canvas, x) {
  const ctx = canvas.getContext('2d');
  const newWidth = (handle === 'br' || handle === 'tr')
    ? Math.max(20, x - info.x)
    : Math.max(20, info.x + info.width - x);
  const scale = newWidth / info.width;
  anno.fontSize = Math.max(6, Math.min(120, info.fontSize * scale));
  const newBounds = getTextBounds(anno, ctx);
  const fontDelta = anno.fontSize - info.fontSize;

  if (handle === 'br') {
    anno.x = info.x;
    anno.y = info.y + fontDelta;
  } else if (handle === 'bl') {
    anno.x = info.x + info.width - newBounds.width;
    anno.y = info.y + fontDelta;
  } else if (handle === 'tr') {
    anno.x = info.x;
    anno.y = info.y + info.height - newBounds.height + fontDelta;
  } else {
    anno.x = info.x + info.width - newBounds.width;
    anno.y = info.y + info.height - newBounds.height + fontDelta;
  }
}

function resizeSignatureAnnotation(anno, info, handle, x) {
  const newWidth = (handle === 'br' || handle === 'tr')
    ? Math.max(50, x - info.x)
    : Math.max(50, info.x + info.width - x);
  const newHeight = newWidth / info.aspectRatio;

  if (handle === 'br') {
    anno.x = info.x; anno.y = info.y;
  } else if (handle === 'bl') {
    anno.x = info.x + info.width - newWidth; anno.y = info.y;
  } else if (handle === 'tr') {
    anno.x = info.x; anno.y = info.y + info.height - newHeight;
  } else {
    anno.x = info.x + info.width - newWidth; anno.y = info.y + info.height - newHeight;
  }
  anno.width = newWidth;
  anno.height = newHeight;
}

// WHY: Extracted from handleSelectDown to reduce cognitive complexity (S3776).
// Handles the locked annotation click — shows toast for signatures, selects annotation.
function handleLockedAnnotationClick(anno, clicked) {
  if (anno.type === 'signature') {
    const annoId = `${clicked.pageIndex}-${clicked.index}`;
    if (ueState.lastLockedToastAnnotation !== annoId) {
      showToast('Tanda tangan terkunci. Klik dua kali untuk membuka kunci.', 'info');
      ueState.lastLockedToastAnnotation = annoId;
    }
  }
  ueState.selectedAnnotation = clicked;
  ueRedrawAnnotations();
}

// WHY: Extracted from handleMove to reduce cognitive complexity (S3776).
function updateResizeCursor(canvas, x, y) {
  if (!ueState.selectedAnnotation) return;
  const anno = ueState.annotations[ueState.selectedAnnotation.pageIndex]?.[ueState.selectedAnnotation.index];
  if (!anno) return;
  const handle = ueGetResizeHandle(anno, x, y);
  const cursors = { 'tl': 'nwse-resize', 'tr': 'nesw-resize', 'bl': 'nesw-resize', 'br': 'nwse-resize' };
  canvas.style.cursor = handle ? cursors[handle] : 'default';
}

export function ueSetupCanvasEvents() {
  if (ueState.eventsSetup) return;
  ueState.eventsSetup = true;

  const container = document.getElementById('ue-pages-container');
  if (!container) return;

  // Closure state for drag/draw operations
  let isDrawing = false;
  let startX, startY;
  let dragOffsetX, dragOffsetY;
  let hasMovedOrResized = false;
  // WHY deep clone: preChangeState captures full annotation state before resize/drag via
  // JSON.parse(JSON.stringify()). Shallow clone would share nested object references,
  // making the undo snapshot mutate along with live state.
  let preChangeState = null;

  // Double-tap detection state
  let touchLastTap = 0;
  let touchLastCoords = null;

  // Pinch-to-zoom state
  let pinchStartDist = 0;
  let isPinching = false;

  container.addEventListener('mousedown', (e) => {
    const info = infoFromMouse(e);
    if (!info) return;
    if (info.pageIndex !== ueState.selectedPage) {
      ueState.selectedPage = info.pageIndex;
      ueHighlightThumbnail(info.pageIndex);
    }
    handleDown(info);
  });
  container.addEventListener('mousemove', (e) => {
    const info = infoFromMouse(e);
    if (!info) return;
    handleMove(info);
  });
  container.addEventListener('mouseup', (e) => {
    const info = infoFromMouse(e);
    if (!info) return;
    handleUp(info);
  });
  container.addEventListener('dblclick', (e) => {
    const info = infoFromMouse(e);
    if (!info) return;
    handleDoubleClick(info);
  });
  container.addEventListener('mouseleave', () => {
    isDrawing = false;
    ueState.isDragging = false;
    ueState.isResizing = false;
    if (ueState.pendingSignature) {
      ueState.signaturePreviewPos = null;
      ueRedrawAnnotations();
    }
  });

  container.addEventListener('touchstart', (e) => {
    // Pinch-to-zoom: detect 2-finger touch
    // WHY manual distance calc instead of e.scale: e.scale is unreliable across browsers
    // (missing in Firefox, inconsistent in Safari). Manual Pythagorean distance is cross-browser safe.
    if (e.touches.length === 2) {
      isPinching = true;
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchStartDist = Math.sqrt(dx * dx + dy * dy);
      e.preventDefault();
      return;
    }

    const info = infoFromTouch(e);
    if (!info) return;

    const toolActive = ueState.currentTool && ueState.currentTool !== 'select';
    const hitAnno = ueState.currentTool === 'select' &&
      ueFindAnnotationAt(info.pageIndex, info.x, info.y);
    const pendingSig = ueState.pendingSignature && state.signatureImage;
    if (toolActive || hitAnno || pendingSig) {
      e.preventDefault();
    }

    if (info.pageIndex !== ueState.selectedPage) {
      ueState.selectedPage = info.pageIndex;
      ueHighlightThumbnail(info.pageIndex);
    }

    // Double-tap detection
    const now = Date.now();
    if (now - touchLastTap < DOUBLE_TAP_DELAY && touchLastCoords) {
      const distance = Math.sqrt(
        Math.pow(info.x - touchLastCoords.x, 2) +
        Math.pow(info.y - touchLastCoords.y, 2)
      );
      if (distance < DOUBLE_TAP_DISTANCE) {
        handleDoubleClick(info);
        return;
      }
    }
    touchLastTap = now;
    touchLastCoords = { x: info.x, y: info.y };
    handleDown(info);
  }, { passive: false });

  container.addEventListener('touchmove', (e) => {
    // Pinch-to-zoom: track finger distance
    if (isPinching && e.touches.length === 2) {
      e.preventDefault();
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const delta = dist - pinchStartDist;
      if (Math.abs(delta) > 30) {
        if (delta > 0) ueZoomIn(); else ueZoomOut();
        pinchStartDist = dist;
      }
      return;
    }

    const info = infoFromTouch(e);
    if (!info) return;
    if (ueState.isDragging || ueState.isResizing || isDrawing ||
        (ueState.currentTool && ueState.currentTool !== 'select')) {
      e.preventDefault();
    }
    handleMove(info);
  }, { passive: false });

  container.addEventListener('touchend', (e) => {
    if (isPinching) {
      isPinching = false;
      return;
    }
    const info = infoFromTouch(e);
    if (!info) return;
    e.preventDefault();
    handleUp(info);
  }, { passive: false });

  // --- Event handlers ---

  // WHY: Extracted from handleDown to reduce cognitive complexity (S3776).
  // Returns true if the event was fully handled (caller should return early).
  function handleSelectDown(x, y) {
    // Check resize handle on already-selected annotation
    if (ueState.selectedAnnotation) {
      const anno = ueState.annotations[ueState.selectedAnnotation.pageIndex][ueState.selectedAnnotation.index];
      const handle = ueGetResizeHandle(anno, x, y);
      if (handle) {
        hasMovedOrResized = false;
        preChangeState = JSON.parse(JSON.stringify(ueState.annotations));
        ueState.isResizing = true;
        ueState.resizeHandle = handle;

        if (anno.type === 'text') {
          const bounds = getTextBounds(anno);
          ueState.resizeStartInfo = {
            x: anno.x, y: anno.y, fontSize: anno.fontSize,
            width: bounds.width, height: bounds.height
          };
        } else {
          ueState.resizeStartInfo = {
            x: anno.x, y: anno.y,
            width: anno.width, height: anno.height,
            aspectRatio: anno.width / anno.height
          };
        }
        return true;
      }
    }

    // Check if clicked on an annotation
    const clicked = ueFindAnnotationAt(x, y);
    if (clicked) {
      const anno = ueState.annotations[clicked.pageIndex][clicked.index];
      if (anno.locked) {
        handleLockedAnnotationClick(anno, clicked);
        return true;
      }
      hasMovedOrResized = false;
      preChangeState = JSON.parse(JSON.stringify(ueState.annotations));
      ueState.selectedAnnotation = clicked;
      ueState.lastLockedToastAnnotation = null;
      ueState.isDragging = true;
      dragOffsetX = x - anno.x;
      // WHY fontSize offset: Text annotations use baseline Y (bottom of first line),
      // not top-left. Subtract fontSize to get bounding box top for drag offset.
      dragOffsetY = y - (anno.type === 'text' ? anno.y - anno.fontSize : anno.y);
      ueRedrawAnnotations();
      ueShowConfirmButton(anno, clicked);
      return true;
    }

    // Clicked empty space — deselect
    ueState.selectedAnnotation = null;
    ueState.lastLockedToastAnnotation = null;
    ueHideConfirmButton();
    ueRedrawAnnotations();
    return false;
  }

  function handleDown({ x, y }) {
    startX = x;
    startY = y;

    if (ueState.pendingSignature && state.signatureImage) {
      uePlaceSignature(x, y);
      return;
    }

    if (ueState.currentTool === 'select') {
      if (handleSelectDown(x, y)) return;
    }

    if (!ueState.currentTool || ueState.currentTool === 'select') return;
    isDrawing = true;
  }

  function handleMove({ canvas, x, y }) {
    if (ueState.currentTool === 'select' && !ueState.isResizing && !ueState.isDragging) {
      updateResizeCursor(canvas, x, y);
    }

    if (ueState.pendingSignature && state.signatureImage) {
      ueState.signaturePreviewPos = { x, y };
      ueRedrawAnnotations();
      ueDrawSignaturePreview(x, y);
      return;
    }

    if (ueState.isResizing && ueState.selectedAnnotation && ueState.resizeStartInfo) {
      const anno = ueState.annotations[ueState.selectedAnnotation.pageIndex][ueState.selectedAnnotation.index];
      if (anno.type === 'text') {
        resizeTextAnnotation(anno, ueState.resizeStartInfo, ueState.resizeHandle, canvas, x);
      } else if (anno.type === 'signature') {
        resizeSignatureAnnotation(anno, ueState.resizeStartInfo, ueState.resizeHandle, x);
      }
      hasMovedOrResized = true;
      ueRedrawAnnotations();
      ueUpdateConfirmButtonPosition(anno);
      return;
    }

    if (ueState.isDragging && ueState.selectedAnnotation) {
      const anno = ueState.annotations[ueState.selectedAnnotation.pageIndex][ueState.selectedAnnotation.index];
      anno.x = x - dragOffsetX;
      anno.y = anno.type === 'text' ? y - dragOffsetY + anno.fontSize : y - dragOffsetY;
      hasMovedOrResized = true;
      ueRedrawAnnotations();
      ueUpdateConfirmButtonPosition(anno);
      return;
    }

    if (!isDrawing || ueState.currentTool !== 'whiteout') return;
    ueRedrawAnnotations();
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.strokeStyle = '#3B82F6';
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 3]);
    ctx.fillRect(Math.min(startX, x), Math.min(startY, y), Math.abs(x - startX), Math.abs(y - startY));
    ctx.strokeRect(Math.min(startX, x), Math.min(startY, y), Math.abs(x - startX), Math.abs(y - startY));
    ctx.setLineDash([]);
  }

  // WHY: Resize and drag share the same commit-and-cleanup pattern.
  // Extracted to reduce cognitive complexity in handleUp.
  function commitGesture(pageIndex, canvas) {
    if (hasMovedOrResized && preChangeState) {
      uePushAnnotationSnapshot(preChangeState);
      emit('annotations:modified', { pageIndex });
    }
    hasMovedOrResized = false;
    preChangeState = null;
    canvas.style.cursor = 'default';
  }

  function handleUp({ canvas, pageIndex, x, y }) {
    if (ueState.isResizing) {
      commitGesture(pageIndex, canvas);
      ueState.isResizing = false;
      ueState.resizeHandle = null;
      ueState.resizeStartInfo = null;
      return;
    }

    if (ueState.isDragging) {
      commitGesture(pageIndex, canvas);
      ueState.isDragging = false;
      return;
    }

    if (!isDrawing) return;
    isDrawing = false;

    if (ueState.currentTool === 'whiteout') {
      const width = Math.abs(x - startX);
      const height = Math.abs(y - startY);
      if (width > 5 && height > 5) {
        ueSaveEditUndoState();
        ueAddAnnotation(pageIndex, createWhiteoutAnnotation({
          x: Math.min(startX, x),
          y: Math.min(startY, y),
          width,
          height
        }));
        track('editor_action', { action: 'whiteout' });
        ueRedrawAnnotations();
      }
    } else if (ueState.currentTool === 'text') {
      ueState.pendingTextPosition = { x: startX, y: startY };
      window.ueOpenTextModal();
    } else if ((ueState.currentTool === 'signature' || ueState.currentTool === 'paraf') && state.signatureImage) {
      uePlaceSignature(startX, startY);
    }
  }

  function handleDoubleClick({ x, y }) {
    if (ueState.currentTool !== 'select') return;

    const result = ueFindAnnotationAt(x, y);
    if (!result) return;

    const anno = ueState.annotations[result.pageIndex][result.index];

    // Unlock signature
    if (anno?.type === 'signature' && anno.locked) {
      anno.locked = false;
      ueState.lastLockedToastAnnotation = null;
      ueRedrawAnnotations();
      ueShowConfirmButton(anno, result);
      return;
    }

    // Edit text annotation
    if (!anno || anno.type !== 'text' || anno.locked) return;
    ueCreateInlineTextEditor(anno, result.pageIndex);
  }
}
