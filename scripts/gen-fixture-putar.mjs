#!/usr/bin/env node
/*
 * Generate tests/fixtures/nasty/putar-90.pdf — a PDF that already carries
 * /Rotate 90 in the file itself. Run: `node scripts/gen-fixture-putar.mjs`.
 *
 * WHY THIS FIXTURE EXISTS (bug found 2026-08-09): both export writers called
 * pdf-lib's setRotation with the USER's in-editor rotation alone, and
 * setRotation is ABSOLUTE — so a source document's own inherited /Rotate was
 * discarded on the way out. Rotate such a page once in the editor and the
 * screen shows 180 (core/import.js rasterizes at baseRotation + rotation)
 * while the exported file is 90. Screen and file disagree, and the user finds
 * out only after they have the file.
 *
 * WHY NO EXISTING FIXTURE COVERED IT. `halaman-miring.pdf` sounds like the
 * right one and is not: its content is drawn askew, and the file carries no
 * /Rotate at all (checked — zero matches). EVERY fixture in this directory has
 * baseRotation 0, which is precisely the case where the buggy formula and the
 * correct one agree. A corpus that agrees with both implementations cannot
 * distinguish them, however large it is — see [[fixture-must-distinguish]].
 *
 * THE PAGE IS DELIBERATELY NOT SQUARE (595 × 842 MediaBox, so 842 × 595 as
 * displayed). A square page would make the rotated and unrotated dimensions
 * identical, and the dimension assertion in the test — output display size
 * must equal the model's page.width/height — would pass for free.
 *
 * The corner labels exist so a human opening this file can SEE which way is
 * up without measuring anything.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, 'tests/fixtures/nasty/putar-90.pdf');

const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};

const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');

const W = 595;
const H = 842;

const doc = await PDFLib.PDFDocument.create();
const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);

// Page 1 carries /Rotate 90. Page 2 is the CONTROL — same document, no
// /Rotate — so a test can prove the fix touches the rotated page and leaves
// the ordinary one byte-for-byte alone.
const p1 = doc.addPage([W, H]);
p1.drawText('PUTAR 90', { x: 60, y: H - 90, size: 28, font, color: PDFLib.rgb(0, 0, 0) });
p1.drawText('kiri-atas MediaBox', { x: 60, y: H - 130, size: 12, font, color: PDFLib.rgb(0, 0, 0) });
p1.drawText('kanan-bawah MediaBox', { x: W - 220, y: 60, size: 12, font, color: PDFLib.rgb(0, 0, 0) });
p1.setRotation(PDFLib.degrees(90));

const p2 = doc.addPage([W, H]);
p2.drawText('KONTROL, TANPA ROTATE', { x: 60, y: H - 90, size: 20, font, color: PDFLib.rgb(0, 0, 0) });

fs.writeFileSync(dest, await doc.save());

// Prove the fixture is what it claims BEFORE anyone writes a test against it —
// a silently-regenerated fixture whose /Rotate went missing would turn the
// whole rotation suite into decoration without a single failure, and every
// assertion in it would still pass because the buggy formula agrees with the
// correct one at baseRotation 0. That is the entire trap this file exists to
// avoid, so it is checked here rather than hoped for.
const bytes = fs.readFileSync(dest);
const reread = await PDFLib.PDFDocument.load(bytes);
const [r1, r2] = reread.getPages();
const rot1 = r1.getRotation().angle;
const rot2 = r2.getRotation().angle;
const size1 = r1.getSize();

console.log(`wrote ${path.relative(root, dest)} (${bytes.length.toLocaleString()} bytes, 2 pages)`);
console.log(`  page 1 /Rotate          : ${rot1}`);
console.log(`  page 1 MediaBox         : ${size1.width} x ${size1.height}`);
console.log(`  page 2 /Rotate (control): ${rot2}`);

if (rot1 !== 90 || rot2 !== 0 || size1.width === size1.height) {
  console.error('  FIXTURE IS NOT WHAT IT CLAIMS — do not write tests against it.');
  console.error('  need: page 1 /Rotate 90, page 2 /Rotate 0, and a NON-SQUARE MediaBox.');
  process.exit(1);
}
