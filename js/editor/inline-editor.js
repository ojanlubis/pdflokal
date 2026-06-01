/*
 * PDFLokal - editor/inline-editor.js (ES Module)
 * Inline text editing overlay for double-click editing of text annotations
 */

import { ueState, mobileState, buildCanvasFont } from '../lib/state.js';
import { ueGetCurrentCanvas, getTextBounds } from './canvas-utils.js';
import { ueRedrawAnnotations, ueRemoveAnnotation } from './annotations.js';
import { uePushAnnotationSnapshot } from './undo-redo.js';

// WHY: opts.isNew = true when the annotation was just created via canvas click
// (inline-on-first-create flow). Differs from the dblclick-on-existing path in
// two ways:
//   1. If user cancels (Escape) or saves with empty text, we remove the orphan
//      annotation — there was no original text to preserve.
//   2. On save, we capture the formatting back into ueState.lastTextOptions so
//      the next text annotation reuses it.
export function ueCreateInlineTextEditor(anno, opts = {}) {
  const isNew = !!opts.isNew;
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

  const removeOrphan = () => {
    // Find the orphan annotation by reference (page index may have changed if
    // pages were reordered during the edit, though unlikely) and remove it.
    for (const [pageKey, list] of Object.entries(ueState.annotations)) {
      const idx = list.indexOf(anno);
      if (idx >= 0) {
        ueRemoveAnnotation(Number(pageKey), idx);
        return;
      }
    }
  };

  // WHY: After an isNew annotation closes (saved OR abandoned), drop the user
  // into select mode. Otherwise the next canvas tap immediately spawns another
  // empty annotation — a trap where Escape doesn't really cancel because the
  // tool stays armed. Matches signature/whiteout post-action behavior.
  const switchToSelectIfNew = () => {
    if (isNew && typeof window.ueSetTool === 'function') window.ueSetTool('select');
  };

  const saveEdit = () => {
    if (saved) return;
    saved = true;
    const newText = editor.innerText.trim();
    delete anno._editing;

    // WHY: When a click-to-create annotation gets no text, leaving it would
    // pollute the document with invisible empty annotations and the undo
    // stack would have a wasted snapshot. Treat empty-on-save like cancel.
    if (isNew && !newText) {
      removeOrphan();
      ueRedrawAnnotations();
      editor.remove();
      switchToSelectIfNew();
      return;
    }

    if (newText && newText !== originalText) {
      uePushAnnotationSnapshot(JSON.parse(JSON.stringify(ueState.annotations)));
      anno.text = newText;
    }

    // WHY: Capture this annotation's formatting so the next text creation
    // reuses it. Sari fills 8 contract fields once-and-for-all in Helvetica
    // 12pt → all 8 land in Helvetica 12pt without re-picking.
    if (isNew) {
      ueState.lastTextOptions = {
        fontSize: anno.fontSize,
        color: anno.color,
        fontFamily: anno.fontFamily,
        bold: !!anno.bold,
        italic: !!anno.italic,
      };
    }

    ueRedrawAnnotations();
    editor.remove();
    switchToSelectIfNew();
  };

  const cancelEdit = () => {
    // WHY saved=true: removing the editor below triggers blur, which queues saveEdit
    // via setTimeout(blurDelay). Without this guard, Escape-cancelled edits would still
    // commit ~100-300ms later and pollute the undo stack.
    saved = true;
    delete anno._editing;
    // Click-to-create annotations have no "original" state to preserve — drop them.
    if (isNew) removeOrphan();
    ueRedrawAnnotations();
    editor.remove();
    switchToSelectIfNew();
  };

  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      saveEdit();
    } else if (e.key === 'Escape') {
      // WHY stopPropagation: the editor removes itself synchronously, so by the bubble
      // phase activeElement has fallen back to <body>. Without this, the global Escape
      // handler in keyboard.js sees no contentEditable and navigates the user home.
      e.preventDefault();
      e.stopPropagation();
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
