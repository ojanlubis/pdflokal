/*
 * A one-page PDF whose ONLY font is a true subset (tests/fixtures/nasty/
 * carlito-subset.ttf: é present, É absent) wearing a name that routes to NO
 * metric clone — /BaseFont and /FontName rewritten to 'Zeta-Regular'.
 *
 * WHY: every clone pdflokal ships is metric-identical to the font it stands
 * in for (that is what a clone is), so on nota-subset.pdf a per-glyph mix of
 * the doc subset and the Carlito clone paints the SAME width as the clone
 * alone — a width test there cannot tell one font from two. Here the line's
 * only bundled face is the Arimo substitute, whose metrics differ from
 * Carlito's, so "the whole line in one face" and "doc font + a fallback glyph"
 * paint measurably different widths. Built at test time from repo assets so
 * no new binary fixture is committed.
 *
 * Line: 'Kafé Andréa, Jakarta Selatan' at x=72 y=720 size=12 (as nota-subset).
 */
import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};

export async function unroutedSubsetPdf() {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
  const doc = await PDFLib.PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(
    new Uint8Array(fs.readFileSync(path.join(root, 'tests/fixtures/nasty/carlito-subset.ttf'))),
    { subset: false },
  );
  const page = doc.addPage([595, 842]);
  page.drawText('Kafé Andréa, Jakarta Selatan', { x: 72, y: 720, size: 12, font });
  const first = await doc.save();

  // Rename every name a font router could read: the Type0 wrapper, its
  // descendant, and the descriptor.
  const re = await PDFLib.PDFDocument.load(first);
  const { PDFName, PDFDict } = PDFLib;
  const name = PDFName.of('Zeta-Regular');
  for (const [, obj] of re.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (obj.get(PDFName.of('BaseFont'))) obj.set(PDFName.of('BaseFont'), name);
    if (obj.get(PDFName.of('FontName'))) obj.set(PDFName.of('FontName'), name);
  }
  return Buffer.from(await re.save());
}
