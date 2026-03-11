/*
 * PDFLokal - editor/inline-editor.js (ES Module)
 * Inline text editing overlay for double-click editing of text annotations
 */

import { ueState, mobileState, buildCanvasFont } from '../lib/state.js';
import { emit } from '../lib/events.js';
import { ueGetCurrentCanvas, getTextBounds } from './canvas-utils.js';
import { ueRedrawAnnotations } from './annotations.js';
import { uePushAnnotationSnapshot } from './undo-redo.js';

export function ueCreateInlineTextEditor(anno, pageIndex) {
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

  // Hide original text
  anno._editing = true;
  ueRedrawAnnotations();

  const editor = document.createElement('div');
  editor.id = 'inline-text-editor';
  editor.contentEditable = 'true';
  editor.setAttribute('role', 'textbox');
  editor.setAttribute('aria-label', 'Edit teks anotasi');
  editor.innerText = anno.text;
  editor.style.cssText = `
    position: absolute;
    left: ${left}px;
    top: ${top}px;
    min-width: 20px;
    font: ${buildCanvasFont(anno, fontSize)};
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
      uePushAnnotationSnapshot(JSON.parse(JSON.stringify(ueState.annotations)));
      anno.text = newText;
      emit('annotations:modified', { pageIndex });
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

  // WHY 300ms on mobile: Virtual keyboard open/close fires blur on the text editor.
  // 300ms delay prevents premature save when user taps keyboard toolbar buttons.
  // Shorter delay causes text loss on slower devices.
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
