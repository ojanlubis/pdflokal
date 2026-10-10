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
 * app.js binds its editor through holdEditor (below), and the last test here
 * reads app.js itself: reverting it to `ed.addEventListener('blur', commit)`
 * fails that test. tests/editor-window-blur.spec.js proves the same in a
 * browser (a real editor, a synthetic window-style blur).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as editorBlur from '../../js/v2/editor-blur.js';

const { blurLeavesEditor } = editorBlur;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

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

// A stand-in editor and document: EventTargets carrying the two fields the
// binder reads. `guard` stands in for leave-guard.js's guardDraft.
function rig(text = '') {
  const ed = Object.assign(new EventTarget(), { textContent: text, isConnected: true });
  const doc = Object.assign(new EventTarget(), { activeElement: ed, visibilityState: 'visible' });
  const calls = { commit: 0, check: null, released: 0 };
  const commit = () => { calls.commit++; };
  const guard = (check) => { calls.check = check; return () => { calls.released++; }; };
  return { ed, doc, calls, commit, guard };
}

test('holdEditor: a window blur keeps the editor; a real focus move commits', () => {
  const { ed, doc, calls, commit, guard } = rig('abc');
  editorBlur.holdEditor(ed, commit, { doc, guard });
  ed.dispatchEvent(new Event('blur'));
  assert.equal(calls.commit, 0, 'focus still on the editor: a window switch');
  doc.activeElement = null;
  ed.dispatchEvent(new Event('blur'));
  assert.equal(calls.commit, 1, 'focus left the editor');
});

test('holdEditor: typed text in an open editor arms the leave guard, no history step', () => {
  // LEAVE GUARD (founder ruling 2026-10-06): held open across a window switch,
  // typed text on a clean document is in no history yet. Quitting the browser
  // from another app must still ask.
  const { ed, doc, calls, commit, guard } = rig('Halo');
  const release = editorBlur.holdEditor(ed, commit, { doc, guard });
  assert.equal(typeof calls.check, 'function', 'the editor registered no leave-guard check');
  assert.equal(calls.check(), false, 'nothing typed: what it opened with');
  ed.textContent = 'Halo dunia';
  assert.equal(calls.check(), true, 'typed text');
  ed.textContent = '';
  assert.equal(calls.check(), true, 'cleared is a change too');
  ed.isConnected = false;
  assert.equal(calls.check(), false, 'an editor removed without its commit has nothing to keep');
  assert.equal(calls.commit, 0, 'the guard alone never commits');
  release();
  assert.equal(calls.released, 1, 'the commit releases the hold');
});

// The function body of openTextEditor in the app as shipped, comments
// stripped, so a call left behind in a comment cannot satisfy the match.
function openTextEditorSource() {
  const src = fs.readFileSync(path.join(ROOT, 'js/v2/app.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  const start = src.indexOf('function openTextEditor(');
  assert.ok(start >= 0, 'openTextEditor not found in js/v2/app.js');
  const end = src.indexOf('\n}\n', start);
  const body = src.slice(start, end);
  // The slice must be the real function, or a doesNotMatch passes for free.
  assert.match(body, /const commit = /, 'openTextEditor body not found whole');
  return body;
}

test('app.js binds the editor through holdEditor, not a bare blur listener', () => {
  const body = openTextEditorSource();
  assert.match(body, /holdEditor\(\s*ed\s*,\s*commit\b/,
    'openTextEditor no longer binds its editor through holdEditor (js/v2/editor-blur.js)');
  assert.doesNotMatch(body, /\.addEventListener\(\s*['"]blur['"]/,
    'openTextEditor binds blur itself again: a window switch would commit and close the editor');
});
