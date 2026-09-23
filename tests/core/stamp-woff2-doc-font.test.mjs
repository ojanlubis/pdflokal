/*
 * RUNG 1 MUST NOT RE-EMBED A WOFF2 PROGRAM IT FOUND IN THE DOCUMENT.
 * ============================================================================
 * Until 2026-09-23 every pdflokal export that used a bundled font carried a
 * raw WOFF2 container as /FontFile2 (tests/core/export-font-program). Those
 * files are in users' hands, and they come back: a user who re-opens one and
 * edits a line reaches rung 1 (tryNativeSubset), which extracts the doc's own
 * program and embeds it verbatim. fontkit parses WOFF2 happily, so no check
 * declined it, and the new edit shipped as dots again, outside pdf.js.
 * Measured by the fixture-regeneration session (PR #138) on the old
 * surat-word / undangan-cid: a rung-1 export carried wOF2 twice.
 *
 * The document here is built exactly the way the bug built it: pdf-lib
 * embedding fonts/arimo-bold.woff2 raw. Against the unguarded rung the stamp
 * resolves path 'native'; guarded, rung 1 declines and the clone rung (real
 * TrueType from fonts/ttf/) takes it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveStampFont } from '../../js/core/stamp.js';
import { extractFontMetrics, readPageContents } from '../../js/core/redact.js';
import { walkShowOps } from '../../js/core/text-walk.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};
const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

test('a doc font that is a WOFF2 container declines rung 1', async () => {
  const bad = await PDFLib.PDFDocument.create();
  bad.registerFontkit(fontkit);
  const f = await bad.embedFont(fs.readFileSync(path.join(root, 'fonts', 'arimo-bold.woff2')));
  bad.addPage([595.28, 841.89]).drawText('No. PPSJ/127/MKT-DEV/IX/2026', { x: 60, y: 700, size: 14, font: f });
  const srcDoc = await PDFLib.PDFDocument.load(await bad.save());

  const newDoc = await PDFLib.PDFDocument.create();
  newDoc.registerFontkit(fontkit);
  const [copied] = await newDoc.copyPages(srcDoc, [0]);
  const pdfPage = newDoc.addPage(copied);
  const rec = walkShowOps(readPageContents(pdfPage, PDFLib), extractFontMetrics(pdfPage, PDFLib))[0];
  assert.ok(rec, 'the built doc must draw one run');

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const buf = fs.readFileSync(path.join(root, String(url)));
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  };
  try {
    const insert = { fontName: rec.fontName, x: rec.x, y: rec.y, ux: rec.ux, uy: rec.uy, size: rec.size, mixedFonts: false };
    const resolved = await resolveStampFont(pdfPage, PDFLib, fontkit, insert, 'PPSJ/128', { bold: true, italic: false });
    assert.notEqual(resolved.path, 'native', 'rung 1 must not re-embed a WOFF2 program');
  } finally {
    globalThis.fetch = realFetch;
  }
});
