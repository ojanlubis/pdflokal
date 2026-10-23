/*
 * A TAB (or VT / FF / LS / PS) must not live in the model (headless).
 *
 * The screen shows an annotation's text with `white-space: pre`, so a TAB draws
 * as a tab-stop gap; the export draws it as ONE space (core/text-encode.js).
 * Text after the TAB sat further right on screen than in the downloaded file.
 * The model is what both read, so it must hold what the file will hold: the
 * characters are normalised when text ENTERS the model, and the two agree.
 *
 * Build the control characters with String.fromCodePoint, never typed
 * literally: they are invisible (see text-encode.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDoc, createSource, createPage, createAnnotation, _resetIds } from '../../js/core/model.js';
import { addSource, addPages, addAnnotation, updateAnnotation } from '../../js/core/operations.js';
import { toStandardFontSafe } from '../../js/core/text-encode.js';

const TAB = String.fromCodePoint(0x09);
const VT = String.fromCodePoint(0x0b);
const FF = String.fromCodePoint(0x0c);
const LS = String.fromCodePoint(0x2028);
const PS = String.fromCodePoint(0x2029);

function fixture() {
  _resetIds();
  const doc = createDoc();
  const src = addSource(doc, createSource({ name: 'a.pdf', bytes: new Uint8Array([1]), numPages: 1 }));
  const [page] = addPages(doc, [createPage({ source: src, sourcePageNum: 0, width: 600, height: 800 })]);
  return { doc, page };
}

test('1. a text annotation created with a TAB stores the single space the file will hold', () => {
  const a = createAnnotation('text', { text: `Nama${TAB}Budi`, x: 10, y: 10 });
  assert.equal(a.text, 'Nama Budi');
  assert.equal(toStandardFontSafe(a.text), a.text, 'screen text and exported text are the same string');
});

test('2. an edit that brings a TAB in (the editor commit) is normalised too', () => {
  const { doc, page } = fixture();
  const a = addAnnotation(doc, page.id, createAnnotation('text', { text: 'Nama', x: 10, y: 10 }));
  updateAnnotation(doc, a.id, { text: `Nama${TAB}Budi${TAB}${TAB}Jakarta` });
  assert.equal(a.text, 'Nama Budi  Jakarta', 'one space per TAB, none merged: the file draws one space per TAB');
  assert.equal(toStandardFontSafe(a.text), a.text);
});

test('3. VT, FF, LS and PS become the newline the file breaks the line on', () => {
  const a = createAnnotation('text', { text: `a${VT}b${FF}c${LS}d${PS}e` });
  assert.equal(a.text, 'a\nb\nc\nd\ne');
  assert.equal(toStandardFontSafe(a.text), a.text);
});

test('4. a patch that does not touch text leaves it alone, and other annotations are not rewritten', () => {
  const { doc, page } = fixture();
  const t = addAnnotation(doc, page.id, createAnnotation('text', { text: 'Halo', x: 1, y: 1 }));
  updateAnnotation(doc, t.id, { color: '#d33131' });
  assert.equal(t.text, 'Halo');
  const w = addAnnotation(doc, page.id, createAnnotation('whiteout', { x: 1, y: 1, width: 5, height: 5 }));
  assert.equal(w.text, undefined, 'a cover carries no text and must not gain one');
});

test('5. KNOWN-POSITIVE: visible characters are not rewritten at entry', () => {
  // The export sanitiser maps thin space etc. only for the font; the model keeps
  // what the user can see (core/text-encode.js header).
  const thin = `Rp${String.fromCodePoint(0x2009)}1.000`;
  assert.equal(createAnnotation('text', { text: thin }).text, thin);
  assert.equal(createAnnotation('text', { text: 'Nama\nBudi' }).text, 'Nama\nBudi');
});
