/*
 * Wiring pin: one inline text editor at a time, and the open one always leaves
 * through its own commit (js/v2/app.js openTextEditor / closeOpenEditor).
 * Run: npm run test:core
 *
 * THE PROPERTY: with Teks armed, tapping a second spot while the first box is
 * still open must give ONE focused box at the second spot, with the first
 * box's text committed and Teks still armed. Before, the new editor claimed the
 * shared editing state, then took focus; the first editor's blur committed it,
 * and that commit cleared the state the NEW editor had just claimed and
 * re-synced the page, which emptied the overlay with the new box in it. Both
 * boxes were gone, Teks was off, and the next Backspace deleted the text just
 * written (the first one was selected and nothing had focus).
 *
 * These checks read app.js itself, comments stripped, because the behaviour is
 * the ORDER of its wiring and there is no DOM here to run it in; the same shape
 * as tests/core/editor-blur.test.mjs's holdEditor pin. They are not the proof
 * the behaviour holds. That is tests/editor-handoff.spec.js (desktop clicks)
 * and tests/mobile/format-bar.spec.js (taps), which drive a real editor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

// app.js as shipped, comments stripped, so a call left behind in a comment
// cannot satisfy a match.
const SRC = fs.readFileSync(path.join(ROOT, 'js/v2/app.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

// A top-level function's body: from its signature to the first closing brace
// at column 0.
function fnBody(signature) {
  const start = SRC.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found in js/v2/app.js`);
  const end = SRC.indexOf('\n}\n', start);
  assert.ok(end > start, `${signature} has no end`);
  return SRC.slice(start, end);
}

// openTextEditor's body, up to its commit (the part that runs on open), and
// the commit itself.
function openTextEditorParts() {
  const body = fnBody('function openTextEditor(');
  const at = body.indexOf('const commit = ');
  // The slice must be the real function, or a doesNotMatch passes for free.
  assert.ok(at > 0, 'openTextEditor body not found whole');
  const open = body.slice(0, at);
  const commitEnd = body.indexOf('\n  };\n', at);
  assert.ok(commitEnd > at, 'commit() body not found whole');
  return { body, open, commit: body.slice(at, commitEnd) };
}

test('a new editor closes the open one BEFORE it claims the shared editing state', () => {
  const { open } = openTextEditorParts();
  const claim = open.indexOf('editingEl = ed;');
  assert.ok(claim > 0, 'openTextEditor no longer claims editingEl');
  const close = open.indexOf('closeOpenEditor();');
  assert.ok(close >= 0 && close < claim,
    'openTextEditor claims editingEl without first closing the open editor: the old editor\'s commit runs later and clears the new one');
  const slot = open.indexOf('const slot = ');
  assert.ok(close < slot,
    'the open editor must close before the page slot and overlay are looked up: its commit re-syncs that overlay');
});

test('closeOpenEditor goes through the open editor\'s own commit', () => {
  const body = fnBody('function closeOpenEditor(');
  assert.match(body, /openEditorCommit\?\.\(\)/, 'closeOpenEditor does not call the open editor\'s commit');
  const { body: ote } = openTextEditorParts();
  assert.match(ote, /openEditorCommit = commit;/, 'openTextEditor does not register its commit as the open editor\'s');
});

test('the handoff keeps the armed tool: Teks stays on for the next blank', () => {
  // The closing commit ends in setTool('select'). Run inside the next
  // editor's open, it disarmed Teks under the new box, and a third tap then
  // closed that box instead of opening another.
  const { open } = openTextEditorParts();
  const m = open.match(/const (\w+) = tool;\s*closeOpenEditor\(\);\s*if \(tool !== \1\) setTool\(\1\);/);
  assert.ok(m, 'openTextEditor does not restore the tool that was armed when the tap landed');
});

test('commit() clears the shared editing state only while it is still its own', () => {
  const { commit } = openTextEditorParts();
  assert.match(commit, /if \(editingEl === ed\) \{\s*editingAnno = null;\s*editingEl = null;\s*editingIsReplace = false;\s*\}/,
    'commit() clears editingEl unconditionally: a late commit of an old editor wipes the open one');
  assert.doesNotMatch(commit.replace(/if \(editingEl === ed\) \{[^}]*\}/, ''), /editingEl = null/,
    'commit() still clears editingEl outside the ownership check');
  assert.match(commit, /if \(openEditorCommit === commit\) openEditorCommit = null;/,
    'commit() does not release the open-editor handle (or releases one that is not its own)');
});

// A file load empties the stage (rebuildStage on Tambah, resetDoc on Ganti).
// An editor held open across a window switch (the person went to Finder to
// drag the file in) was emptied with it, never committed: its typed text was
// gone, and its page-hidden listener lived on to commit it later into the NEW
// document (a phantom undo step, then a TypeError on the old page id).
test('a file load closes the open editor through its commit, before the import touches either document', () => {
  const body = fnBody('async function loadFilesInner(');
  const close = body.indexOf('closeOpenEditor();');
  assert.ok(close >= 0, 'loadFilesInner does not close the open editor: the load empties the stage under it');
  const into = body.indexOf('const into = ');
  assert.ok(into > 0, 'loadFilesInner no longer stages into `into`');
  assert.ok(close < into,
    'the editor must close before the import: its text belongs to the open document and its history step comes before the merge');
});

// An EMPTY new box held open while a format-bar control has focus (size,
// font, custom colour). A window or app switch fires focusout on that control
// with relatedTarget null while activeElement stays on it, exactly the case
// editor-blur.js blurLeavesEditor exists for. The bar's own leave handler read
// only relatedTarget, so it took the switch for a click-away: the box closed,
// Teks disarmed, and the size or colour chosen next landed on the previous text.
test('the format-bar hold stands down while focus is still inside the bar', () => {
  const { body } = openTextEditorParts();
  const m = body.match(/const onBarLeave = \(ev\) => \{([\s\S]*?)\n {4}\};/);
  assert.ok(m, 'onBarLeave not found in openTextEditor');
  const firstLine = m[1].trim().split('\n')[0];
  assert.match(firstLine, /^if \(.*formatBarEl\.contains\(ev\.relatedTarget\).*\) return;$/,
    'onBarLeave no longer stands down first for focus moving between controls');
  assert.match(firstLine, /formatBarEl\.contains\(document\.activeElement\)/,
    'onBarLeave ignores activeElement: a window switch with a control focused closes the held box');
});
