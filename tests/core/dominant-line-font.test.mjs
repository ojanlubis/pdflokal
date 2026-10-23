/*
 * dominantLineFont: WHICH /Font paints a line, and does the line mix fonts?
 * ============================================================================
 * Moved headless (2026-10-10) out of js/v2/app.js into core/redact.js, where
 * it could only ever be exercised through a browser. Pins the seat ruling of
 * 2026-07-28 (option C): FAMILY comes from the DOMINANT run (widest), and a
 * line whose runs use different fonts says so (mixedFonts), because WEIGHT is
 * not answerable for it. `Bld ` (bold, painted first, narrow) + a wide regular
 * run: the dominant font is the REGULAR one, not the first-painted bold.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dominantLineFont, extractFontMetrics, readPageContents } from '../../js/core/redact.js';
import { walkShowOps } from '../../js/core/text-walk.js';
import { groupRunsIntoLines } from '../../js/core/text-lines.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};
const toRuns = (records) => records.filter((r) => r.tokens.some((t) => t.t === 'str')).map((r) => ({
  str: r.tokens.find((t) => t.t === 'str').v, x: r.x, y: r.y, w: r.advanceText ?? 0, h: r.size,
  size: r.size, fontName: r.fontName, fontFamily: '',
  pdf: { x0: r.x, y0: r.y, ux: r.ux, uy: r.uy, len: r.advanceText ?? 0, size: r.size },
}));

async function pageWith(parts) {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
  const doc = await PDFLib.PDFDocument.create();
  doc.registerFontkit(fontkit);
  const fonts = {
    bold: await doc.embedFont(new Uint8Array(fs.readFileSync(path.join(root, 'fonts/montserrat-bold.woff2')))),
    regular: await doc.embedFont(new Uint8Array(fs.readFileSync(path.join(root, 'fonts/carlito-regular.woff2')))),
  };
  const page = doc.addPage([595, 842]);
  let x = 72;
  for (const [text, which] of parts) {
    page.drawText(text, { x, y: 700, size: 12, font: fonts[which] });
    x += fonts[which].widthOfTextAtSize(text, 12);
  }
  const src = (await PDFLib.PDFDocument.load(await doc.save())).getPages()[0];
  const records = walkShowOps(readPageContents(src, PDFLib), extractFontMetrics(src, PDFLib));
  const [line] = groupRunsIntoLines(toRuns(records));
  return { PDFLib, src, line, records };
}

test('a two-font line: the WIDEST run names the font, and the mix is reported', async () => {
  const { PDFLib, src, line, records } = await pageWith([['Bld ', 'bold'], ['regular text continues the same line', 'regular']]);
  assert.equal(line.runs.length, 2, 'known-positive: the fixture really is one line of two runs');
  // Paint order: the bold run first, the regular one second (the strings are
  // Identity-H glyph codes, not readable text).
  const [boldRec, regularRec] = records.filter((r) => r.tokens.some((t) => t.t === 'str'));
  assert.notEqual(boldRec.fontName, regularRec.fontName);
  const regularName = regularRec.fontName;
  const got = dominantLineFont(src, PDFLib, line);
  assert.equal(got.fontName, regularName, 'the first-painted narrow bold run was taken for the line');
  assert.equal(got.mixedFonts, true);
});

test('a one-font line: its font, and no mix', async () => {
  const { PDFLib, src, line, records } = await pageWith([['Satu font saja di baris ini', 'regular']]);
  const got = dominantLineFont(src, PDFLib, line);
  assert.equal(got.fontName, records[0].fontName);
  assert.equal(got.mixedFonts, false);
});
