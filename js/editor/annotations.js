/*
 * PDFLokal - editor/annotations.js (ES Module)
 * Annotation drawing, rendering, and hit testing
 */

import { ueState, CSS_FONT_MAP } from '../lib/state.js';
import { ueGetCurrentCanvas, getTextBounds } from './canvas-utils.js';

// Redraw annotations on all rendered pages
export function ueRedrawAnnotations() {
  ueState.pageCanvases.forEach((pc, i) => {
    if (pc.rendered) ueRedrawPageAnnotations(i);
  });
}

// Redraw annotations on a specific page's canvas
export function ueRedrawPageAnnotations(index) {
  const entry = ueState.pageCanvases[index];
  if (!entry || !entry.rendered) return;

  const canvas = entry.canvas;
  const ctx = canvas.getContext('2d');

  const cache = ueState.pageCaches[index];
  if (cache) ctx.putImageData(cache, 0, 0);
  ctx.setTransform(ueState.devicePixelRatio, 0, 0, ueState.devicePixelRatio, 0, 0);

  const annotations = ueState.annotations[index] || [];
  annotations.forEach((anno, i) => {
    const isSelected = ueState.selectedAnnotation &&
      ueState.selectedAnnotation.pageIndex === index &&
      ueState.selectedAnnotation.index === i;
    ueDrawAnnotation(ctx, anno, isSelected);
  });
}

// Draw a single annotation
export function ueDrawAnnotation(ctx, anno, isSelected) {
  switch (anno.type) {
    case 'whiteout':
      ctx.fillStyle = 'white';
      ctx.fillRect(anno.x, anno.y, anno.width, anno.height);
      if (isSelected) ueDrawSelectionHandles(ctx, anno.x, anno.y, anno.width, anno.height);
      break;
    case 'text':
      // Skip rendering if currently being edited
      if (anno._editing) break;

      // Build font string with bold/italic and family
      let fontStyle = '';
      if (anno.italic) fontStyle += 'italic ';
      if (anno.bold) fontStyle += 'bold ';

      const cssFontFamily = CSS_FONT_MAP[anno.fontFamily] || CSS_FONT_MAP['Helvetica'];

      ctx.font = `${fontStyle}${anno.fontSize}px ${cssFontFamily}`;
      ctx.fillStyle = anno.color;
      const lines = anno.text.split('\n');
      lines.forEach((line, i) => ctx.fillText(line, anno.x, anno.y + i * anno.fontSize * 1.2));
      if (isSelected) {
        const bounds = getTextBounds(anno, ctx);
        ueDrawSelectionHandles(ctx, bounds.x - 2, bounds.y - 2, bounds.width + 4, bounds.height + 4);
      }
      break;
    case 'signature':
      if (anno.cachedImg && anno.cachedImg.complete) {
        ctx.drawImage(anno.cachedImg, anno.x, anno.y, anno.width, anno.height);
        // Show handles only if selected and not locked
        if (isSelected && !anno.locked) {
          ueDrawSelectionHandles(ctx, anno.x, anno.y, anno.width, anno.height);
        } else if (isSelected && anno.locked) {
          // Draw a subtle locked indicator (just border, no handles)
          ctx.strokeStyle = '#10B981';
          ctx.lineWidth = 2;
          ctx.setLineDash([]);
          ctx.strokeRect(anno.x - 2, anno.y - 2, anno.width + 4, anno.height + 4);
        }
      } else if (anno.image) {
        const img = new Image();
        img.src = anno.image;
        anno.cachedImg = img;
      }
      break;
    case 'watermark':
      ctx.save();
      ctx.translate(anno.x, anno.y);
      ctx.rotate(anno.rotation * Math.PI / 180);
      ctx.font = `${anno.fontSize}px Arial`;
      ctx.fillStyle = anno.color;
      ctx.globalAlpha = anno.opacity;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(anno.text, 0, 0);
      ctx.restore();
      break;
    case 'pageNumber':
      ctx.font = `${anno.fontSize}px Arial`;
      ctx.fillStyle = anno.color;
      ctx.fillText(anno.text, anno.x, anno.y);
      break;
  }
}

// Draw selection handles
export function ueDrawSelectionHandles(ctx, x, y, width, height) {
  ctx.strokeStyle = '#3B82F6';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 3]);
  ctx.strokeRect(x - 2, y - 2, width + 4, height + 4);
  ctx.setLineDash([]);

  const handleSize = 8;
  ctx.fillStyle = '#3B82F6';
  ctx.fillRect(x - handleSize / 2 - 2, y - handleSize / 2 - 2, handleSize, handleSize);
  ctx.fillRect(x + width - handleSize / 2 + 2, y - handleSize / 2 - 2, handleSize, handleSize);
  ctx.fillRect(x - handleSize / 2 - 2, y + height - handleSize / 2 + 2, handleSize, handleSize);
  ctx.fillRect(x + width - handleSize / 2 + 2, y + height - handleSize / 2 + 2, handleSize, handleSize);
}

// Find annotation at position
export function ueFindAnnotationAt(pageIndexOrX, xOrY, maybeY) {
  // Supports both (pageIndex, x, y) and legacy (x, y) signatures
  let pageIndex, x, y;
  if (maybeY !== undefined) {
    pageIndex = pageIndexOrX;
    x = xOrY;
    y = maybeY;
  } else {
    pageIndex = ueState.selectedPage;
    x = pageIndexOrX;
    y = xOrY;
  }

  const annotations = ueState.annotations[pageIndex] || [];
  for (let i = annotations.length - 1; i >= 0; i--) {
    const anno = annotations[i];
    let bounds;
    switch (anno.type) {
      case 'whiteout':
      case 'signature':
        bounds = { x: anno.x, y: anno.y, w: anno.width, h: anno.height };
        break;
      case 'text':
        const textBounds = getTextBounds(anno);
        bounds = { x: textBounds.x, y: textBounds.y, w: textBounds.width, h: textBounds.height };
        break;
      default:
        continue;
    }
    if (x >= bounds.x && x <= bounds.x + bounds.w && y >= bounds.y && y <= bounds.y + bounds.h) {
      return { pageIndex, index: i };
    }
  }
  return null;
}
