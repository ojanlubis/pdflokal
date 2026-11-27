/*
 * user-fonts.test.mjs — a font the user brings (his call 2026-11-27).
 * The file must be a font a PDF can carry, its licence must allow embedding,
 * and the download must embed THAT font, never quietly another one.
 * pdf-lib bitstability memory: asserts structure (the embedded /BaseFont),
 * never raw bytes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as model from '../../js/core/model.js';
import * as ops from '../../js/core/operations.js';
import { buildPdfBytes } from '../../js/core/export.js';
import { inspectFontBytes, embeddingAllowed, userFontKey, userFontCss, isUserFont } from '../../js/core/user-fonts.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};
const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
const TTF = new Uint8Array(fs.readFileSync(path.join(root, 'tests/fixtures/carlito-latin.ttf')));
const WOFF2 = new Uint8Array(fs.readFileSync(path.join(root, 'fonts/carlito-regular.woff2')));
const KEY = userFontKey('0123456789abcdef0123');

async function docWithText(fontFamily) {
  const bytes = fs.readFileSync(path.join(root, 'tests/fixtures/sample-2pages.pdf'));
  const src = await PDFLib.PDFDocument.load(bytes);
  const { width, height } = src.getPages()[0].getSize();
  const doc = model.createDoc();
  const source = ops.addSource(doc, model.createSource({ name: 's.pdf', bytes, numPages: 2 }));
  const page = model.createPage({ source, sourcePageNum: 0, width, height, rotation: 0 });
  ops.addPages(doc, [page]);
  ops.addAnnotation(doc, page.id, model.createAnnotation('text', {
    text: 'Font sendiri', x: 40, y: 40, fontSize: 14, fontFamily, bold: false, italic: false, color: '#000000',
  }));
  return doc;
}

async function baseFonts(bytes) {
  const out = await PDFLib.PDFDocument.load(bytes);
  const names = [];
  for (const [, obj] of out.context.enumerateIndirectObjects()) {
    const t = obj?.get?.(PDFLib.PDFName.of('Type'));
    if (t && String(t) === '/Font') names.push(String(obj.get(PDFLib.PDFName.of('BaseFont'))));
  }
  return names;
}

test('a TTF is a user font; its family name is the label', () => {
  const r = inspectFontBytes(TTF, fontkit);
  assert.equal(r.ok, true);
  assert.match(r.family, /Carlito/);
});

test('a WOFF2 is refused: a PDF cannot carry it, it would print as dots', () => {
  assert.deepEqual(inspectFontBytes(WOFF2, fontkit), { ok: false, reason: 'not-font' });
  assert.deepEqual(inspectFontBytes(new Uint8Array([1, 2, 3, 4, 5]), fontkit), { ok: false, reason: 'not-font' });
});

test('a font whose licence forbids embedding is refused; every other fsType is allowed', () => {
  assert.equal(embeddingAllowed(0x0002), false, 'Restricted License');
  for (const ok of [0, 0x0004, 0x0008, 0x0100, 0x0200, undefined]) assert.equal(embeddingAllowed(ok), true, String(ok));
  const font = fontkit.create(TTF);
  const fake = { create: () => ({ numGlyphs: font.numGlyphs, familyName: 'X', 'OS/2': { fsType: 2 } }) };
  assert.deepEqual(inspectFontBytes(TTF, fake), { ok: false, reason: 'no-embed' });
});

test('the key is content-addressed; the CSS family never borrows the font\'s own name', () => {
  assert.equal(isUserFont(KEY), true);
  assert.equal(isUserFont('Helvetica'), false);
  assert.equal(userFontCss(KEY), 'pdflokal-user-0123456789abcdef');
});

test('the download embeds the user\'s font, subset, and says nothing fell back', async () => {
  const doc = await docWithText(KEY);
  let fellBack = 0;
  const bytes = await buildPdfBytes(doc, {
    PDFLib, fontkit, onFontFallback: () => { fellBack += 1; },
    userFontBytes: async (k) => (k === KEY ? TTF : null),
  });
  const fonts = await baseFonts(bytes);
  assert.ok(fonts.some((n) => /Carlito/.test(n)), `the user's font is in the file, got ${fonts.join(', ')}`);
  assert.equal(fellBack, 0);
});

test('CONTROL: a browser that lost the font falls back to Helvetica WITH the witness', async () => {
  const doc = await docWithText(KEY);
  let fellBack = 0;
  const bytes = await buildPdfBytes(doc, { PDFLib, fontkit, onFontFallback: () => { fellBack += 1; }, userFontBytes: async () => null });
  const fonts = await baseFonts(bytes);
  assert.ok(!fonts.some((n) => /Carlito/.test(n)));
  assert.equal(fellBack, 1);
});
