/*
 * font-style.js — bold/italic detection (headless).
 * ============================================================================
 * parseStyleFromName is pure (no PDFLib) — pins the PostScript-name
 * convention the founder's field bug turned on (Word/LibreOffice/InDesign
 * subset fonts: 'Arial-BoldMT', 'TimesNewRomanPS-BoldItalicMT', …).
 *
 * getFontStyleInfo is the PDFLib adapter — built against a REAL pdf-lib page
 * (same "load the vendored UMD in the current realm" loader the nasty-fixture
 * generator scripts use, see scripts/gen-fixture-*.mjs) so the /BaseFont +
 * FontDescriptor /Flags + /FontWeight reads are proven against the actual
 * object shapes pdf-lib produces, not a hand-rolled mock of them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStyleFromName, getFontStyleInfo } from '../../js/core/font-style.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};

test('parseStyleFromName: PostScript-convention bold/italic/bolditalic names', () => {
  assert.deepEqual(parseStyleFromName('Arial-BoldMT'), { bold: true, italic: false });
  assert.deepEqual(parseStyleFromName('TimesNewRomanPS-BoldItalicMT'), { bold: true, italic: true });
  assert.deepEqual(parseStyleFromName('Arial-ItalicMT'), { bold: false, italic: true });
  assert.deepEqual(parseStyleFromName('ArialMT'), { bold: false, italic: false });
  // Oblique is the italic synonym TrueType families use (e.g. Helvetica-Oblique).
  assert.deepEqual(parseStyleFromName('Helvetica-BoldOblique'), { bold: true, italic: true });
});

test('parseStyleFromName: case-insensitive, and "oblique" counts as italic', () => {
  assert.equal(parseStyleFromName('helvetica-boldoblique').bold, true);
  assert.equal(parseStyleFromName('helvetica-boldoblique').italic, true);
  assert.equal(parseStyleFromName('MONTSERRATTHIN-BOLD').bold, true);
});

test('parseStyleFromName: never throws on undefined/null/empty', () => {
  assert.deepEqual(parseStyleFromName(undefined), { bold: false, italic: false });
  assert.deepEqual(parseStyleFromName(null), { bold: false, italic: false });
  assert.deepEqual(parseStyleFromName(''), { bold: false, italic: false });
});

// WHY save()+load() before reading: pdf-lib only registers an embedded font's
// indirect object into the context lazily, at save time — calling
// context.lookup() on a freshly-embedded (not yet saved) font's ref returns
// undefined. Every REAL caller of this adapter (core/redact.js,
// core/reinsert.js, js/v2/app.js's prepareDocFont) only ever runs against an
// ALREADY-LOADED document (PDFLib.PDFDocument.load(source.bytes)) — so
// round-tripping here isn't a workaround, it's matching production's actual
// input shape.
async function buildAndReload(PDFLib, draw) {
  const pdfDoc = await PDFLib.PDFDocument.create();
  const page = pdfDoc.addPage([200, 200]);
  await draw(pdfDoc, page);
  const bytes = await pdfDoc.save();
  const loaded = await PDFLib.PDFDocument.load(bytes);
  return loaded.getPages()[0];
}

// Resources -> Font has exactly one key on these fixtures — read it back the
// same way core/redact.js's extractFontMetrics does.
function soleFontName(PDFLib, page) {
  const { PDFName, PDFRef } = PDFLib;
  const fontDict = page.node.Resources().get(PDFName.of('Font'));
  const resolved = fontDict instanceof PDFRef ? page.doc.context.lookup(fontDict) : fontDict;
  const [key] = [...resolved.keys()];
  return key.toString().slice(1); // '/F1' -> 'F1'
}

test('getFontStyleInfo: real embedded Bold font (Type0/Identity-H) — name carries Bold', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
  // Real repo asset (also used by core/export.js's Montserrat-Bold embed) —
  // its own PostScript name is 'MontserratThin-Bold' (verified against the
  // vendored fontkit directly), so this is the SAME real-world shape a
  // Word-exported bold heading carries, not a synthetic override.
  const page = await buildAndReload(PDFLib, async (pdfDoc, pg) => {
    pdfDoc.registerFontkit(fontkit);
    const bold = await pdfDoc.embedFont(
      new Uint8Array(fs.readFileSync(path.join(root, 'fonts/montserrat-bold.woff2'))),
      { subset: false },
    );
    pg.drawText('Tebal', { x: 10, y: 100, size: 24, font: bold, color: PDFLib.rgb(0, 0, 0) });
  });

  const info = getFontStyleInfo(page, PDFLib, soleFontName(PDFLib, page));
  assert.equal(info.ok, true);
  assert.match(info.baseFont, /bold/i);
  assert.equal(info.bold, true);
});

test('getFontStyleInfo: standard-14 non-bold font — no false positive', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const page = await buildAndReload(PDFLib, async (pdfDoc, pg) => {
    const helv = await pdfDoc.embedFont(PDFLib.StandardFonts.Helvetica);
    pg.drawText('Biasa', { x: 10, y: 100, size: 14, font: helv, color: PDFLib.rgb(0, 0, 0) });
  });

  const info = getFontStyleInfo(page, PDFLib, soleFontName(PDFLib, page));
  assert.equal(info.ok, true);
  assert.equal(info.bold, false);
  assert.equal(info.italic, false);
});

test('getFontStyleInfo: unknown font name on the page declines honestly', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const page = await buildAndReload(PDFLib, async () => {});
  const info = getFontStyleInfo(page, PDFLib, 'NopeNotAResource');
  assert.equal(info.ok, false);
});
