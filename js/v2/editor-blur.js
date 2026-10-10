/*
 * PDFLokal — v2/editor-blur.js  (when the inline text editor's blur commits)
 * ============================================================================
 * The browser fires `blur` on the focused element when its WINDOW deactivates
 * (alt-tab, switching to another app to copy something), but focus never left
 * the element: document.activeElement is still the editor, and focus returns to
 * it with the window. Committing on that blur closed the editor under the
 * person's caret: a cleared Edit line was committed empty, which DELETES it, and
 * the keys typed after coming back hit the app's shortcuts instead of the box.
 *
 * A blur that really moves focus (a tap elsewhere, Enter/Escape's ed.blur(), a
 * dialog opening) has already moved activeElement off the editor when the event
 * runs, so it still commits. Tested by tests/core/editor-blur.test.mjs and
 * tests/editor-window-blur.spec.js.
 */
export function blurLeavesEditor(activeElement, editorEl) {
  return activeElement !== editorEl;
}
