/*
 * A PASTE INTO THE INLINE TEXT EDITOR TAKES THE CLIPBOARD'S PLAIN TEXT.
 * ============================================================================
 * The bug: a copy from Gmail, Docs or Word carries text/html with each line in
 * its own <div>. The inline editor (js/v2/app.js openTextEditor) is a
 * contenteditable, so the browser's own paste put those <div>s in it: the user
 * SAW two lines. The commit reads ed.textContent, which has no line breaks for
 * block boundaries, so the file got "Jl. Merdeka 10Jakarta Pusat".
 *
 * The fix: the editor takes the paste itself and inserts text/plain, where the
 * copying app already wrote its line breaks as '\n'. The editor is
 * `white-space: pre` (pre-wrap for a paragraph), so a '\n' in a text node both
 * shows as a new line and commits as one.
 *
 * What runs here: which flavour is taken and how its line breaks are
 * normalised (js/v2/editor-paste.js clipboardPlainText), and that app.js wires
 * the editor's paste to it. The DOM insertion itself (Range, caret, the input
 * event) is proven in a browser: tests/v2-system-paste.spec.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { clipboardPlainText } from '../../js/v2/editor-paste.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

// A clipboard as a rich copy leaves it: both flavours, the HTML one first.
const clip = (data) => ({ getData: (type) => data[type] ?? '' });

test('a rich copy yields its plain text, line breaks kept, never the HTML', () => {
  const cd = clip({
    'text/html': '<div>Jl. Merdeka 10</div><div>Jakarta Pusat</div>',
    'text/plain': 'Jl. Merdeka 10\nJakarta Pusat',
  });
  assert.equal(clipboardPlainText(cd), 'Jl. Merdeka 10\nJakarta Pusat');
});

test('Windows (\\r\\n) and old Mac (\\r) line breaks become \\n', () => {
  // WHY: the editor draws and commits only '\n'; a '\r' left in would reach
  // the file as a character, not a break.
  assert.equal(clipboardPlainText(clip({ 'text/plain': 'satu\r\ndua\rtiga' })), 'satu\ndua\ntiga');
});

test('no plain text (an image-only clipboard, or none) yields empty, not a throw', () => {
  assert.equal(clipboardPlainText(clip({ 'text/html': '<img src="x">' })), '');
  assert.equal(clipboardPlainText(null), '');
  assert.equal(clipboardPlainText(undefined), '');
});

test('app.js wires the editor paste and the page paste to the one reader', () => {
  // The browser spec proves the behaviour; this is the cheap tripwire that
  // goes red in the headless suite if the editor's listener is dropped.
  const src = fs.readFileSync(path.join(ROOT, 'js/v2/app.js'), 'utf8');
  assert.match(src, /ed\.addEventListener\('paste',\s*\(e\)\s*=>\s*pasteAsPlainText\(ed,\s*e\)\)/);
  assert.match(src, /clipboardPlainText\(cd\)/, 'the page-level paste must read text through the same normaliser');
});
