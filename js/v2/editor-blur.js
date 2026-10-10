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
 *
 * holdEditor is the one place app.js's openTextEditor binds these rules, so
 * the test can read app.js for the call (a bare blur listener there is the
 * reverted shape).
 */
import { guardDraft } from './leave-guard.js';

export function blurLeavesEditor(activeElement, editorEl) {
  return activeElement !== editorEl;
}

// Binds the editor's ways out. Returns the release, which app.js's commit()
// calls: commit() is the only path out of the editor.
//
// LEAVE GUARD: held open across a window switch, typed text on a clean
// document is in no history yet, so quitting the browser from another app
// lost it without the leave prompt. While the editor is open, text that
// differs from what it opened with counts as unsaved work (leave-guard.js
// guardDraft), and no history step is recorded for it. The check is live:
// an editor removed without its commit reads false.
//
// HIDDEN: an Android app switch (and a desktop tab switch) fires
// visibilitychange 'hidden', and a hidden tab may be killed. Typed text is
// committed there (hideCommits), so it is in the document and its history
// rather than only in the editor.
export function holdEditor(ed, commit, { doc = document, guard = guardDraft } = {}) {
  const opened = ed.textContent;
  ed.addEventListener('blur', () => { if (blurLeavesEditor(doc.activeElement, ed)) commit(); });
  const onVisibility = () => {
    if (doc.visibilityState === 'hidden' && hideCommits(ed.textContent, opened)) commit();
  };
  doc.addEventListener('visibilitychange', onVisibility);
  const releaseGuard = guard(() => ed.isConnected && ed.textContent !== opened);
  return () => {
    doc.removeEventListener('visibilitychange', onVisibility);
    releaseGuard();
  };
}

// Whether the page going hidden commits the editor: only when it holds typed,
// non-blank text. An empty commit DELETES a cleared Edit line (app.js commit()),
// which is the window-switch bug above arriving by another event; an untouched
// editor has nothing to keep, and stays open for the person coming back.
export function hideCommits(text, opened) {
  return text !== opened && text.trim() !== '';
}
