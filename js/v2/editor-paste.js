/*
 * PDFLokal — v2/editor-paste.js  (what a paste puts in the inline text editor)
 * ============================================================================
 * The inline editor (js/v2/app.js openTextEditor) is a contenteditable, and
 * its commit reads ed.textContent. Left to the browser, a paste from Gmail,
 * Docs or Word inserts that app's HTML: each line its own <div>, which the
 * user SEES as separate lines and textContent reads back with no break
 * between them, so the file got the lines glued together. The editor shows
 * only what it commits, so a paste brings in plain text and nothing else.
 *
 * Plain text keeps the lines: the copying app writes them into text/plain as
 * line breaks, and the editor is `white-space: pre` (pre-wrap for a Rung D
 * paragraph), where a '\n' in a text node draws as a new line, reads back in
 * textContent, and is a hard break to block-editor.js readEditorLines.
 */

// The clipboard's plain text with every line break as '\n'. SINGLE SOURCE for
// both the editor's paste and the page-level paste in app.js: a '\r' left in
// would reach the file as a character, not a break.
export function clipboardPlainText(cd) {
  return (cd?.getData('text/plain') || '').replace(/\r\n?/g, '\n');
}

// The editor's paste handler. Always takes the paste over, even with no plain
// text on the clipboard: an image or rich fragment the browser would insert is
// something the commit cannot hold, so it must not appear in the editor either.
//
// Not execCommand('insertText'): Chromium turns each '\n' in it into a new
// paragraph (<div>), which is the very structure textContent drops. A single
// text node at the selection is what Shift+Enter already produces here.
export function pasteAsPlainText(ed, e) {
  e.preventDefault();
  const text = clipboardPlainText(e.clipboardData);
  if (!text) return;
  const doc = ed.ownerDocument;
  const sel = doc.getSelection();
  let range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
  if (!range || !ed.contains(range.commonAncestorContainer)) {
    // No caret in the editor (a paste raised by script, or focus elsewhere):
    // the text goes on the end, never somewhere outside the editor.
    range = doc.createRange();
    range.selectNodeContents(ed);
    range.collapse(false);
  }
  range.deleteContents(); // a selected prefill (Ganti) is replaced, as typing would
  const node = doc.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  if (sel) { sel.removeAllRanges(); sel.addRange(range); }
  // A script mutation fires no `input`, and the editor's input listeners must
  // see a paste as they see typing: line-font-live.js strips characters no
  // font can write (one would kill the export), and app.js openTextEditor
  // locks an OCR edit's appearance and gives the "line got wider" note.
  ed.dispatchEvent(new window.Event('input', { bubbles: true }));
}
