/*
 * A TAB typed or pasted into a paragraph (Ganti block) editor must not live in
 * the stored `block.lines` either (headless). Companion to tests/core/text-tab-entry.test.mjs, which
 * normalises `anno.text`; a paragraph also
 * stores the painted lines, and every block renderer (overlay, stamp, export)
 * reads THOSE, not `anno.text`. core/block-edit.js logicalTextOf is the single
 * source of truth for both, so they must stay one string.
 *
 * Also: the commit compares the editor's text against the stored anno.text to
 * decide "did anything change?" (js/v2/app.js). That comparison must be made on
 * the NORMALISED text, or retyping a space as a TAB records a do-nothing undo
 * step and a telemetry event. app.js gets both from editorCommit().
 *
 * Control characters are built with String.fromCodePoint, never typed literally.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  blockAnnotation, logicalTextOf, editorCommit, normaliseBlockLines,
} from '../../js/core/block-edit.js';
import { createAnnotation } from '../../js/core/model.js';
import { toStandardFontSafe } from '../../js/core/text-encode.js';

const TAB = String.fromCodePoint(0x09);
const VT = String.fromCodePoint(0x0b);

const plan = {
  align: 'left', indent: 0, width: 200, leading: 15, size: 11, origin: { x: 72, y: 700 },
  k: 1, disp: { x: 72, y: 92 }, srcLines: 2, srcWords: [2, 1], below: null,
};

test('1. blockAnnotation stores lines the file will hold: logicalTextOf(block.lines) === anno.text', () => {
  const raw = [{ text: `Nama${TAB}Budi`, brk: ' ' }, { text: 'Jakarta', brk: '' }];
  const block = blockAnnotation(plan, raw);
  assert.equal(block.lines[0].text, 'Nama Budi');
  const { text, lines } = editorCommit('', raw);
  const anno = createAnnotation('text', { text, block: blockAnnotation(plan, lines) });
  assert.equal(logicalTextOf(anno.block.lines), anno.text, 'the re-edit prefill and the stamped lines are one fact');
  for (const l of anno.block.lines) assert.equal(toStandardFontSafe(l.text), l.text, 'overlay text === exported text');
});

test('2. a TAB in the break a soft wrap hung (brk) is normalised, and hard still follows brk', () => {
  const block = blockAnnotation(plan, [{ text: 'aa', brk: TAB }, { text: 'bb', brk: `${VT}` }, { text: 'cc', brk: '' }]);
  assert.deepEqual(block.lines.map((l) => l.brk), [' ', '\n', '']);
  assert.deepEqual(block.lines.map((l) => l.hard), [false, true, false]);
  const { text } = editorCommit('', [{ text: 'aa', brk: TAB }, { text: 'bb', brk: '' }]);
  assert.equal(text, 'aa bb');
});

test('3. the no-op guard compares NORMALISED text: a TAB retyped over a space is the same text', () => {
  const stored = createAnnotation('text', { text: 'Nama Budi' });
  const { text } = editorCommit(`Nama${TAB}Budi`, null);
  assert.equal(text, stored.text, 'app.js: `text !== anno.text` must be false');
  // and a line-by-line paragraph commit too
  const lines = [{ text: `Nama${TAB}Budi`, brk: '' }];
  assert.equal(editorCommit('', lines).text, stored.text);
});

test('4. KNOWN-POSITIVE: a real change still differs, visible characters and brk spaces are untouched', () => {
  const stored = createAnnotation('text', { text: 'Nama Budi' });
  assert.notEqual(editorCommit(`Nama${TAB}Budi!`, null).text, stored.text);
  const thin = `Rp${String.fromCodePoint(0x2009)}1`;
  assert.equal(normaliseBlockLines([{ text: thin, brk: ' ' }])[0].text, thin);
  assert.equal(editorCommit('  Halo  ', null).text, 'Halo', 'trim is kept');
  assert.equal(editorCommit(`${TAB}Halo${TAB}`, null).text, 'Halo', 'edge TABs trim like spaces');
});
