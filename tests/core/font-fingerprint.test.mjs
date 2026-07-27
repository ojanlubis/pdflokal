/*
 * core/font-fingerprint.js — RUNG 2 of the style/family ladder
 * (spec-edit-fidelity-instrumentation.md Increment A).
 * ============================================================================
 * The founder's own defect, reproduced directly against org-structure.pdf's
 * REAL bytes (no synthetic fixture needed — the file already carries the
 * exact shape that broke): /Font F1 is `/BaseFont = CIDFont+F1` (Flags=6, no
 * /FontWeight) wrapping an embedded TrueType program whose OWN name is
 * "Arial-BoldMT". Rung 1 (core/font-style.js) must decline this wrapper name
 * as uninformative rather than silently reading its silence as "regular" —
 * that silent-default WAS the bug (decisions.md 2026-07-23). Rung 2 must then
 * read the program itself and find bold FOUR redundant ways (name-table
 * subfamily "Bold", OS/2.usWeightClass 700, OS/2.fsSelection.bold,
 * PANOSE weight byte 7) — this suite pins the first one that fires
 * (program-name, the spec's own stated preference order) plus each lower
 * rung in isolation against other real bundled fonts, so a regression to
 * "trust the label" fails loudly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isInformativeBaseFont, fingerprintProgramBytes,
  resolveFontFingerprint, FAMILY_BUCKET_TO_CLONE,
} from '../../js/core/font-fingerprint.js';

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

// ---- isInformativeBaseFont: the "uninformative name" test -------------------

test('isInformativeBaseFont: generator placeholder tags carry NO signal — must not be read as "regular"', () => {
  // The founder's own defect's exact wrapper name.
  assert.equal(isInformativeBaseFont('CIDFont+F1'), false);
  assert.equal(isInformativeBaseFont('CIDFont+F2'), false);
  // Spec's own listed examples of an uninformative name.
  assert.equal(isInformativeBaseFont('F1'), false);
  assert.equal(isInformativeBaseFont('Font1'), false);
  assert.equal(isInformativeBaseFont('C3'), false);
  assert.equal(isInformativeBaseFont('TT2'), false);
  assert.equal(isInformativeBaseFont(''), false);
  assert.equal(isInformativeBaseFont(undefined), false);
});

test('isInformativeBaseFont: a real family name (with or without a subset prefix) IS informative', () => {
  assert.equal(isInformativeBaseFont('Arial-BoldMT'), true);
  assert.equal(isInformativeBaseFont('ABCDEF+Arial-BoldMT'), true); // canonical pyftsubset 6-letter prefix
  assert.equal(isInformativeBaseFont('Calibri'), true);
  assert.equal(isInformativeBaseFont('TimesNewRomanPS-BoldItalicMT'), true);
});

// ---- fingerprintProgram / fingerprintProgramBytes: rung 2's own sub-ladder --

function loadFontBytes(rel) {
  return new Uint8Array(fs.readFileSync(path.join(root, rel)));
}

test('fingerprintProgramBytes: montserrat-bold.woff2 — name table says "Bold" outright -> program-name rung', () => {
  const bytes = loadFontBytes('fonts/montserrat-bold.woff2');
  const fp = fingerprintProgramBytes(fontkit, bytes);
  assert.equal(fp.ok, true);
  assert.equal(fp.bold, true);
  assert.equal(fp.italic, false);
  assert.equal(fp.styleSource, 'program-name');
  assert.match(fp.programName, /Bold/);
});

test('fingerprintProgramBytes: carlito-subset.ttf — name is silent, OS/2 usWeightClass=400 -> os2 rung, not bold; PANOSE says sans (not serif)', () => {
  const bytes = loadFontBytes('tests/fixtures/nasty/carlito-subset.ttf');
  const fp = fingerprintProgramBytes(fontkit, bytes);
  assert.equal(fp.ok, true);
  assert.equal(fp.bold, false);
  assert.equal(fp.italic, false);
  assert.equal(fp.styleSource, 'os2');
  assert.equal(fp.mono, false);
  // Carlito's own PANOSE serif-style byte is 15 ("Rounded") — a SANS
  // terminal variant, not a serif one (verified directly against this
  // repo's bundled font, not assumed from the PANOSE spec prose alone —
  // bytes 11-15 are ALL sans variants, only 2-10 are genuine serif styles).
  assert.equal(fp.family, 'sans');
});

test('fingerprintProgramBytes: cousine-regular.woff2 — post.isFixedPitch is a DIRECT field, not a measurement -> mono=true', () => {
  const bytes = loadFontBytes('fonts/cousine-regular.woff2');
  const fp = fingerprintProgramBytes(fontkit, bytes);
  assert.equal(fp.ok, true);
  assert.equal(fp.mono, true);
  assert.equal(fp.family, 'mono');
});

test('fingerprintProgramBytes: malformed bytes decline honestly, never throw', () => {
  const fp = fingerprintProgramBytes(fontkit, new Uint8Array([1, 2, 3, 4, 5]));
  assert.equal(fp.ok, false);
});

test('fingerprintProgramBytes: no fontkit at all declines honestly', () => {
  const bytes = loadFontBytes('fonts/montserrat-bold.woff2');
  assert.deepEqual(fingerprintProgramBytes(null, bytes), { ok: false });
});

test('FAMILY_BUCKET_TO_CLONE: exactly the spec\'s stated bucket -> clone-family mapping', () => {
  assert.deepEqual(FAMILY_BUCKET_TO_CLONE, { serif: 'Tinos', mono: 'Cousine', sans: 'Arimo' });
});

// ---- resolveFontFingerprint: the FULL ladder, against the REAL defect ------

async function orgStructurePage() {
  const bytes = fs.readFileSync(NASTY('org-structure.pdf'));
  const doc = await PDFLib.PDFDocument.load(bytes);
  return doc.getPages()[0];
}

test('resolveFontFingerprint: org-structure.pdf /Font F1 — rung 1 declines (uninformative "CIDFont+F1"), rung 2 resolves BOLD from the embedded program', async () => {
  const page = await orgStructurePage();
  const fp = resolveFontFingerprint(page, PDFLib, fontkit, 'F1');
  assert.equal(fp.ok, true);
  assert.equal(fp.baseFont, 'CIDFont+F1');
  assert.equal(fp.embedded, true);
  // THE regression guard: styleSource must NOT be 'pdf-name'/'pdf-flags' —
  // if it were, rung 1 would have (wrongly) claimed authority over an
  // uninformative name. It must be a rung-2 source, and bold must be TRUE —
  // this is the exact founder defect, fixed.
  assert.equal(fp.styleSource, 'program-name');
  assert.equal(fp.bold, true);
  assert.equal(fp.italic, false);
  assert.equal(fp.family, 'sans');
  assert.match(fp.programName, /Arial-BoldMT/);
});

test('resolveFontFingerprint: org-structure.pdf /Font F2 — rung 1 still declines (same uninformative shape), rung 2 correctly says NOT bold', async () => {
  const page = await orgStructurePage();
  const fp = resolveFontFingerprint(page, PDFLib, fontkit, 'F2');
  assert.equal(fp.ok, true);
  assert.equal(fp.baseFont, 'CIDFont+F2');
  // Proves rung 2 isn't just "always say bold" — it correctly reads the
  // REGULAR program's own OS/2.usWeightClass (400) as not-bold.
  assert.equal(fp.styleSource, 'os2');
  assert.equal(fp.bold, false);
});

test('resolveFontFingerprint: an unknown font name on the page declines honestly, in the same shape as a resolved decline', async () => {
  const page = await orgStructurePage();
  const fp = resolveFontFingerprint(page, PDFLib, fontkit, 'NopeNotAResource');
  assert.equal(fp.ok, false);
  assert.equal(fp.bold, false);
  assert.equal(fp.styleSource, 'none');
});

test('resolveFontFingerprint: an INFORMATIVE wrapper name still wins at rung 1 — rung 2 never even attempted', async () => {
  // Real repo asset, same shape font-style.test.mjs's own bold-name test
  // uses: embed montserrat-bold.woff2 under pdf-lib's OWN informative name
  // (it never mangles the font's PostScript name into an uninformative one).
  const pdfDoc = await PDFLib.PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  const page = pdfDoc.addPage([200, 200]);
  const bold = await pdfDoc.embedFont(loadFontBytes('fonts/montserrat-bold.woff2'), { subset: false });
  page.drawText('Tebal', { x: 10, y: 100, size: 24, font: bold, color: PDFLib.rgb(0, 0, 0) });
  const bytes = await pdfDoc.save();
  const loaded = await PDFLib.PDFDocument.load(bytes);
  const loadedPage = loaded.getPages()[0];
  const { PDFName, PDFRef } = PDFLib;
  const fontDictRaw = loadedPage.node.Resources().get(PDFName.of('Font'));
  const fontDict = fontDictRaw instanceof PDFRef ? loadedPage.doc.context.lookup(fontDictRaw) : fontDictRaw;
  const [fontKey] = fontDict.keys();
  const fontName = fontKey.toString().replace(/^\//, '');

  const fp = resolveFontFingerprint(loadedPage, PDFLib, fontkit, fontName);
  assert.equal(fp.ok, true);
  assert.equal(fp.styleSource, 'pdf-name'); // rung 1, not rung 2
  assert.equal(fp.bold, true);
});
