/*
 * PDFLokal - editor/canvas-utils.js (ES Module)
 * Canvas utility functions: coordinate conversion, hit testing, text bounds
 */

import { ueState, CSS_FONT_MAP } from '../lib/state.js';

// Get the canvas element for the currently selected page
export function ueGetCurrentCanvas() {
  const entry = ueState.pageCanvases[ueState.selectedPage];
  return entry ? entry.canvas : null;
}

// Convert mouse/touch event coords to canvas-pixel coords
export function ueGetCoords(e, canvas) {
  const dpr = ueState.devicePixelRatio || window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (canvas.width / canvas.clientWidth / dpr);
  const y = (e.clientY - rect.top) * (canvas.height / canvas.clientHeight / dpr);
  return { x, y };
}

// Calculate accurate bounds for text annotation (handles multi-line)
export function getTextBounds(anno, ctx) {
  if (!ctx) {
    const canvas = ueGetCurrentCanvas();
    ctx = canvas.getContext('2d');
  }

  let fontStyle = '';
  if (anno.italic) fontStyle += 'italic ';
  if (anno.bold) fontStyle += 'bold ';

  const cssFontFamily = CSS_FONT_MAP[anno.fontFamily] || CSS_FONT_MAP['Helvetica'];
  ctx.font = `${fontStyle}${anno.fontSize}px ${cssFontFamily}`;

  const lines = anno.text.split('\n');
  let maxWidth = 0;
  for (const line of lines) {
    const metrics = ctx.measureText(line);
    maxWidth = Math.max(maxWidth, metrics.width);
  }

  const totalHeight = anno.fontSize * lines.length * 1.2;

  return {
    x: anno.x,
    y: anno.y - anno.fontSize,
    width: maxWidth,
    height: totalHeight
  };
}

// Check if (x, y) is on a resize handle of the given annotation
export function ueGetResizeHandle(anno, x, y) {
  if (anno.locked) return null;
  const handleSize = 12;

  let corners;
  if (anno.type === 'text') {
    const bounds = getTextBounds(anno);
    corners = [
      { pos: 'tl', hx: bounds.x, hy: bounds.y },
      { pos: 'tr', hx: bounds.x + bounds.width, hy: bounds.y },
      { pos: 'bl', hx: bounds.x, hy: bounds.y + bounds.height },
      { pos: 'br', hx: bounds.x + bounds.width, hy: bounds.y + bounds.height }
    ];
  } else if (anno.type === 'signature') {
    corners = [
      { pos: 'tl', hx: anno.x, hy: anno.y },
      { pos: 'tr', hx: anno.x + anno.width, hy: anno.y },
      { pos: 'bl', hx: anno.x, hy: anno.y + anno.height },
      { pos: 'br', hx: anno.x + anno.width, hy: anno.y + anno.height }
    ];
  } else {
    return null;
  }

  for (const h of corners) {
    if (Math.abs(x - h.hx) < handleSize && Math.abs(y - h.hy) < handleSize) {
      return h.pos;
    }
  }
  return null;
}
