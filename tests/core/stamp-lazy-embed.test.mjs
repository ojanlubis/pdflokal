/*
 * A DOC FONT THAT FAILS AT save() MUST DECLINE RUNG 1, NOT KILL THE EXPORT.
 * ============================================================================
 * Rail, 2026-09-08 → 09-21: `export / TypeError / undefined-prop`, three
 * sessions, 3-48 retries each, ZERO files, all after Ganti Teks edits.
 * Reproduced on two wild files and on this tracked fixture, with the exact
 * production message: `Cannot read properties of undefined (reading
 * 'italicAngle')`, thrown from pdf-lib's embedFontDescriptor.
 *
 * pdf-lib's embedFont() is LAZY. It succeeds on a TrueType subset with no
 * `post` table; the FontDescriptor is only written at save(), outside every
 * try in core/stamp.js. So rung 1 reports "native", stamps, and the whole
 * export dies. Every Unduh fails the same way, because the edit stays in the
 * document. On the rail, the bake that runs at commit swallows the same throw
 * (editedPageProvider's catch), so those sessions also carry NO `surgery` /
 * `insert` events. That is how to find them.
 *
 * lorem-testing.pdf's FT8 is such a subset (TrueType, no `post`), found by
 * listing every fixture font's tables on 2026-09-21. The text stamped is
 * built from glyphs the subset provably covers, because otherwise rung 1
 * declines on missing glyphs and the test would pass without the guard.
 * Without the guard, test 2 fails with the production error. With it, test 2 passes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveStampFont, stampText, textCoveredBy, fontEmbedsAtSave } from '../../js/core/stamp.js';
import { extractFontMetrics, readPageContents } from '../../js/core/redact.js';
import { walkShowOps } from '../../js/core/text-walk.js';
import { extractFontProgram } from '../../js/core/doc-fonts.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NASTY = (name) => path.join(root, 'tests', 'fixtures', 'nasty', name);

const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};
const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

async function ft8() {
  const srcDoc = await PDFLib.PDFDocument.load(fs.readFileSync(NASTY('lorem-testing.pdf')));
  const srcPage = srcDoc.getPages()[0];
  const rec = walkShowOps(readPageContents(srcPage, PDFLib), extractFontMetrics(srcPage, PDFLib))
    .find((r) => r.fontName === 'FT8');
  assert.ok(rec, 'fixture must still draw with FT8');
  const extracted = extractFontProgram(srcPage, PDFLib, 'FT8');
  assert.ok(extracted.ok, 'FT8 program must be extractable');
  const parsed = fontkit.create(extracted.bytes);
  const covered = parsed.characterSet
    .filter((c) => c > 64 && c < 123).map((c) => String.fromCodePoint(c))
    .filter((ch) => textCoveredBy(parsed, ch)).join('');
  assert.ok(covered.length >= 2, 'need glyphs the subset provably covers');
  return { srcDoc, rec, bytes: extracted.bytes, parsed, text: covered.slice(0, 4) };
}

test('fixture: FT8 embeds without complaint and THROWS at save() (the lazy half, proven)', async () => {
  const { bytes, parsed } = await ft8();
  const doc = await PDFLib.PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(bytes); // no throw here
  doc.addPage().drawText('EG', { font, size: 12 });
  await assert.rejects(() => doc.save(), /italicAngle/);
  assert.equal(fontEmbedsAtSave(parsed), false);
});

test('a Ganti stamp in FT8 declines rung 1 and the document SAVES', async () => {
  const { srcDoc, rec, text } = await ft8();
  const newDoc = await PDFLib.PDFDocument.create();
  newDoc.registerFontkit(fontkit);
  const [copied] = await newDoc.copyPages(srcDoc, [0]);
  const pdfPage = newDoc.addPage(copied);

  const insert = { fontName: rec.fontName, x: rec.x, y: rec.y, ux: rec.ux, uy: rec.uy, size: rec.size, mixedFonts: false };
  const resolved = await resolveStampFont(pdfPage, PDFLib, fontkit, insert, text, { bold: false, italic: false });
  // Exactly what page-surgery.js's planNativeInserts does with the answer.
  if (resolved.ok) stampText(pdfPage, PDFLib, resolved.font, insert, text, '#000000');

  const out = await newDoc.save({ useObjectStreams: true, addDefaultPage: false });
  assert.equal(Buffer.from(out.subarray(0, 5)).toString(), '%PDF-');
  assert.notEqual(resolved.path, 'native', 'rung 1 must not stamp with a font pdf-lib cannot write');
});

test('healthy doc subsets still pass the guard (it does not decline rung 1 wholesale)', async () => {
  for (const [file, pick] of [['undangan-cid.pdf', 3], ['nota-subset.pdf', 0]]) {
    const srcDoc = await PDFLib.PDFDocument.load(fs.readFileSync(NASTY(file)));
    const srcPage = srcDoc.getPages()[0];
    const rec = walkShowOps(readPageContents(srcPage, PDFLib), extractFontMetrics(srcPage, PDFLib))[pick];
    const extracted = extractFontProgram(srcPage, PDFLib, rec.fontName);
    assert.ok(extracted.ok, `${file}: program must be extractable`);
    assert.equal(fontEmbedsAtSave(fontkit.create(extracted.bytes)), true, `${file} ${rec.fontName}`);
  }
});
