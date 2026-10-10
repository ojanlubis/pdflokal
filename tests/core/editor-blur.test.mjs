/*
 * Headless test for when the inline text editor's blur may commit
 * (js/v2/editor-blur.js, called by js/v2/app.js openTextEditor).
 * Run: npm run test:core
 *
 * THE PROPERTY: switching to another app or window must not close the editor.
 * The browser fires `blur` on the focused element when its WINDOW deactivates,
 * but focus never left the element: document.activeElement is still the editor,
 * and comes back to it when the window does. Committing on that blur deleted a
 * cleared Ganti line (the empty fresh commit is a deletion) and, on desktop,
 * sent the keystrokes typed after returning to the app's shortcuts.
 * A blur that really moves focus (tap elsewhere, Enter/Escape's ed.blur(), a
 * dialog opening) leaves activeElement on something else, and must still commit.
 *
 * tests/editor-window-blur.spec.js proves app.js routes the editor's blur
 * through this rule (a real editor, a synthetic window-style blur).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { blurLeavesEditor } from '../../js/v2/editor-blur.js';

const ed = { id: 'editor' };
const body = { id: 'body' };

test('window deactivation (focus still on the editor) does not commit', () => {
  assert.equal(blurLeavesEditor(ed, ed), false);
});

test('focus moved elsewhere in the page (tap away, Enter, Escape, a dialog) commits', () => {
  assert.equal(blurLeavesEditor(body, ed), true);
  assert.equal(blurLeavesEditor({ id: 'dialog-button' }, ed), true);
});

test('no active element at all (focused node removed) commits', () => {
  assert.equal(blurLeavesEditor(null, ed), true);
});
