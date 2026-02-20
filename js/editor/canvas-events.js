/*
 * PDFLokal - editor/canvas-events.js (ES Module)
 * Canvas event handling (mouse, touch, drag, resize, double-click)
 * and inline text editing
 */

import { ueState, state, mobileState, CSS_FONT_MAP, UNDO_STACK_LIMIT, DOUBLE_TAP_DELAY, DOUBLE_TAP_DISTANCE, createWhiteoutAnnotation } from '../lib/state.js';
import { showToast } from '../lib/utils.js';
import { ueGetCoords, ueGetResizeHandle, ueGetCurrentCanvas, getTextBounds } from './canvas-utils.js';
import { ueRedrawAnnotations, ueFindAnnotationAt } from './annotations.js';
import { ueSaveEditUndoState } from './undo-redo.js';
import { ueHighlightThumbnail } from './page-rendering.js';
import { ueZoomIn, ueZoomOut } from './zoom-rotate.js';
import {
  uePlaceSignature, ueDrawSignaturePreview,
  ueShowConfirmButton, ueHideConfirmButton, ueUpdateConfirmButtonPosition
} from './signatures.js';

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
  let preChangeState = null;

  // Double-tap detection state
  let touchLastTap = 0;
  let touchLastCoords = null;

  // Pinch-to-zoom state
  let pinchStartDist = 0;
  let isPinching = false;

  function getCanvasAndIndex(target) {
    const canvas = target.closest ? target.closest('.ue-page-slot canvas') : null;
    if (!canvas) return null;
    const slot = canvas.parentElement;
    const pageIndex = parseInt(slot.dataset.pageIndex, 10);
    if (isNaN(pageIndex)) return null;
    return { canvas, pageIndex };
  }

  function infoFromMouse(e) {
    const hit = getCanvasAndIndex(e.target);
    if (!hit) return null;
    const coords = ueGetCoords(e, hit.canvas);
    return { canvas: hit.canvas, pageIndex: hit.pageIndex, x: coords.x, y: coords.y };
  }

  function infoFromTouch(e) {
    const touch = (e.touches && e.touches.length) ? e.touches[0] : e.changedTouches[0];
    const hit = getCanvasAndIndex(e.target);
    if (!hit) return null;
    const coords = ueGetCoords(touch, hit.canvas);
    return { canvas: hit.canvas, pageIndex: hit.pageIndex, x: coords.x, y: coords.y };
  }

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

  function handleDown({ canvas, pageIndex, x, y }) {
    startX = x;
    startY = y;

    if (ueState.pendingSignature && state.signatureImage) {
      uePlaceSignature(x, y);
      return;
    }

    if (ueState.currentTool === 'select') {
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
          return;
        }
      }

      const clicked = ueFindAnnotationAt(x, y);
      if (clicked) {
        const anno = ueState.annotations[clicked.pageIndex][clicked.index];
        if (anno.locked) {
          if (anno.type === 'signature') {
            const annoId = `${clicked.pageIndex}-${clicked.index}`;
            if (ueState.lastLockedToastAnnotation !== annoId) {
              showToast('Tanda tangan terkunci. Klik dua kali untuk membuka kunci.', 'info');
              ueState.lastLockedToastAnnotation = annoId;
            }
          }
          ueState.selectedAnnotation = clicked;
          ueRedrawAnnotations();
          return;
        }
        hasMovedOrResized = false;
        preChangeState = JSON.parse(JSON.stringify(ueState.annotations));
        ueState.selectedAnnotation = clicked;
        ueState.lastLockedToastAnnotation = null;
        ueState.isDragging = true;
        dragOffsetX = x - anno.x;
        dragOffsetY = y - (anno.type === 'text' ? anno.y - anno.fontSize : anno.y);
        ueRedrawAnnotations();
        ueShowConfirmButton(anno, clicked);
        return;
      } else {
        ueState.selectedAnnotation = null;
        ueState.lastLockedToastAnnotation = null;
        ueHideConfirmButton();
        ueRedrawAnnotations();
      }
    }

    if (!ueState.currentTool || ueState.currentTool === 'select') return;
    isDrawing = true;
  }

  function handleMove({ canvas, pageIndex, x, y }) {
    if (ueState.currentTool === 'select' && ueState.selectedAnnotation && !ueState.isResizing && !ueState.isDragging) {
      const anno = ueState.annotations[ueState.selectedAnnotation.pageIndex][ueState.selectedAnnotation.index];
      const handle = ueGetResizeHandle(anno, x, y);
      if (handle) {
        const cursors = { 'tl': 'nwse-resize', 'tr': 'nesw-resize', 'bl': 'nesw-resize', 'br': 'nwse-resize' };
        canvas.style.cursor = cursors[handle];
      } else {
        canvas.style.cursor = 'default';
      }
    }

    if (ueState.pendingSignature && state.signatureImage) {
      ueState.signaturePreviewPos = { x, y };
      ueRedrawAnnotations();
      ueDrawSignaturePreview(x, y);
      return;
    }

    if (ueState.isResizing && ueState.selectedAnnotation && ueState.resizeStartInfo) {
      const anno = ueState.annotations[ueState.selectedAnnotation.pageIndex][ueState.selectedAnnotation.index];
      const info = ueState.resizeStartInfo;
      const handle = ueState.resizeHandle;

      if (anno.type === 'text') {
        const ctx = canvas.getContext('2d');
        let newWidth;
        if (handle === 'br' || handle === 'tr') {
          newWidth = Math.max(20, x - info.x);
        } else {
          newWidth = Math.max(20, info.x + info.width - x);
        }
        const scale = newWidth / info.width;
        const newFontSize = Math.max(6, Math.min(120, info.fontSize * scale));
        anno.fontSize = newFontSize;
        const newBounds = getTextBounds(anno, ctx);

        if (handle === 'br') {
          anno.x = info.x;
          anno.y = info.y + (anno.fontSize - info.fontSize);
        } else if (handle === 'bl') {
          anno.x = info.x + info.width - newBounds.width;
          anno.y = info.y + (anno.fontSize - info.fontSize);
        } else if (handle === 'tr') {
          anno.x = info.x;
          anno.y = info.y + info.height - newBounds.height + (anno.fontSize - info.fontSize);
        } else if (handle === 'tl') {
          anno.x = info.x + info.width - newBounds.width;
          anno.y = info.y + info.height - newBounds.height + (anno.fontSize - info.fontSize);
        }

        hasMovedOrResized = true;
        ueRedrawAnnotations();
        ueUpdateConfirmButtonPosition(anno);
        return;

      } else if (anno.type === 'signature') {
        let newWidth, newHeight, newX, newY;
        if (handle === 'br') {
          newWidth = Math.max(50, x - info.x);
          newHeight = newWidth / info.aspectRatio;
          newX = info.x; newY = info.y;
        } else if (handle === 'bl') {
          newWidth = Math.max(50, info.x + info.width - x);
          newHeight = newWidth / info.aspectRatio;
          newX = info.x + info.width - newWidth; newY = info.y;
        } else if (handle === 'tr') {
          newWidth = Math.max(50, x - info.x);
          newHeight = newWidth / info.aspectRatio;
          newX = info.x; newY = info.y + info.height - newHeight;
        } else if (handle === 'tl') {
          newWidth = Math.max(50, info.x + info.width - x);
          newHeight = newWidth / info.aspectRatio;
          newX = info.x + info.width - newWidth; newY = info.y + info.height - newHeight;
        }
        anno.x = newX; anno.y = newY;
        anno.width = newWidth; anno.height = newHeight;
        hasMovedOrResized = true;
        ueRedrawAnnotations();
        ueUpdateConfirmButtonPosition(anno);
        return;
      }
    }

    if (ueState.isDragging && ueState.selectedAnnotation) {
      const anno = ueState.annotations[ueState.selectedAnnotation.pageIndex][ueState.selectedAnnotation.index];
      if (anno.type === 'text') {
        anno.x = x - dragOffsetX;
        anno.y = y - dragOffsetY + anno.fontSize;
      } else {
        anno.x = x - dragOffsetX;
        anno.y = y - dragOffsetY;
      }
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

  function handleUp({ canvas, pageIndex, x, y }) {
    if (ueState.isResizing) {
      if (hasMovedOrResized && preChangeState) {
        ueState.editUndoStack.push(preChangeState);
        ueState.editRedoStack = [];
        if (ueState.editUndoStack.length > UNDO_STACK_LIMIT) ueState.editUndoStack.shift();
      }
      ueState.isResizing = false;
      ueState.resizeHandle = null;
      ueState.resizeStartInfo = null;
      hasMovedOrResized = false;
      preChangeState = null;
      canvas.style.cursor = 'default';
      return;
    }

    if (ueState.isDragging) {
      if (hasMovedOrResized && preChangeState) {
        ueState.editUndoStack.push(preChangeState);
        ueState.editRedoStack = [];
        if (ueState.editUndoStack.length > UNDO_STACK_LIMIT) ueState.editUndoStack.shift();
      }
      ueState.isDragging = false;
      hasMovedOrResized = false;
      preChangeState = null;
      canvas.style.cursor = 'default';
      return;
    }

    if (!isDrawing) return;
    isDrawing = false;

    if (ueState.currentTool === 'whiteout') {
      const width = Math.abs(x - startX);
      const height = Math.abs(y - startY);
      if (width > 5 && height > 5) {
        ueSaveEditUndoState();
        ueState.annotations[pageIndex].push(createWhiteoutAnnotation({
          x: Math.min(startX, x),
          y: Math.min(startY, y),
          width,
          height
        }));
        ueRedrawAnnotations();
      }
    } else if (ueState.currentTool === 'text') {
      ueState.pendingTextPosition = { x: startX, y: startY };
      window.ueOpenTextModal();
    } else if ((ueState.currentTool === 'signature' || ueState.currentTool === 'paraf') && state.signatureImage) {
      uePlaceSignature(startX, startY);
    }
  }

  function handleDoubleClick({ canvas, pageIndex, x, y }) {
    if (ueState.currentTool !== 'select') return;

    const result = ueFindAnnotationAt(x, y);
    if (!result) return;

    const anno = ueState.annotations[result.pageIndex][result.index];

    // Unlock signature
    if (anno && anno.type === 'signature' && anno.locked) {
      anno.locked = false;
      ueState.lastLockedToastAnnotation = null;
      ueRedrawAnnotations();
      ueShowConfirmButton(anno, result);
      return;
    }

    // Edit text annotation
    if (!anno || anno.type !== 'text' || anno.locked) return;
    ueCreateInlineTextEditor(anno, result.pageIndex, result.index);
  }
}

// ============================================================
// INLINE TEXT EDITING
// ============================================================

function ueCreateInlineTextEditor(anno, pageIndex, index) {
  const existing = document.getElementById('inline-text-editor');
  if (existing) existing.remove();

  const canvas = ueGetCurrentCanvas();
  const wrapper = document.getElementById('ue-canvas-wrapper');
  if (!canvas || !wrapper) return;

  const canvasRect = canvas.getBoundingClientRect();
  const wrapperRect = wrapper.getBoundingClientRect();

  const dpr = ueState.devicePixelRatio;
  const scaleX = canvas.clientWidth / (canvas.width / dpr);
  const scaleY = canvas.clientHeight / (canvas.height / dpr);

  const bounds = getTextBounds(anno);
  const left = bounds.x * scaleX + (canvasRect.left - wrapperRect.left);
  const top = bounds.y * scaleY + (canvasRect.top - wrapperRect.top);
  const fontSize = anno.fontSize * scaleX;

  let fontStyle = '';
  if (anno.italic) fontStyle += 'italic ';
  if (anno.bold) fontStyle += 'bold ';

  const cssFontFamily = CSS_FONT_MAP[anno.fontFamily] || CSS_FONT_MAP['Helvetica'];

  // Hide original text
  anno._editing = true;
  ueRedrawAnnotations();

  const editor = document.createElement('div');
  editor.id = 'inline-text-editor';
  editor.contentEditable = 'true';
  editor.innerText = anno.text;
  editor.style.cssText = `
    position: absolute;
    left: ${left}px;
    top: ${top}px;
    min-width: 20px;
    font: ${fontStyle}${fontSize}px ${cssFontFamily};
    color: ${anno.color || '#000000'};
    background: transparent;
    border: 1px dashed rgba(0, 123, 255, 0.4);
    padding: 0;
    margin: 0;
    line-height: 1.2;
    white-space: pre-wrap;
    outline: none;
    z-index: 10000;
  `;

  const originalText = anno.text;
  let saved = false;

  const saveEdit = () => {
    if (saved) return;
    saved = true;
    const newText = editor.innerText.trim();
    delete anno._editing;

    if (newText && newText !== originalText) {
      const undoState = JSON.parse(JSON.stringify(ueState.annotations));
      ueState.editUndoStack.push(undoState);
      ueState.editRedoStack = [];
      if (ueState.editUndoStack.length > UNDO_STACK_LIMIT) ueState.editUndoStack.shift();
      anno.text = newText;
    }

    ueRedrawAnnotations();
    editor.remove();
  };

  const cancelEdit = () => {
    delete anno._editing;
    ueRedrawAnnotations();
    editor.remove();
  };

  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      saveEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  });

  // On mobile, use longer delay to prevent premature save when virtual keyboard opens
  const blurDelay = mobileState.isTouch ? 300 : 100;
  editor.addEventListener('blur', () => setTimeout(saveEdit, blurDelay));

  wrapper.style.position = 'relative';
  wrapper.appendChild(editor);
  editor.focus();

  // On mobile, reposition editor when virtual keyboard resizes the viewport
  if (window.visualViewport && mobileState.isTouch) {
    const repositionEditor = () => {
      const vv = window.visualViewport;
      const editorRect = editor.getBoundingClientRect();
      // If editor is below the visible viewport (hidden by keyboard), scroll it into view
      if (editorRect.bottom > vv.height + vv.offsetTop) {
        editor.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    };
    window.visualViewport.addEventListener('resize', repositionEditor);
    editor.addEventListener('blur', () => {
      window.visualViewport.removeEventListener('resize', repositionEditor);
    }, { once: true });
  }

  const range = document.createRange();
  range.selectNodeContents(editor);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}
