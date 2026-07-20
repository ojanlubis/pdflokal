/*
 * core/compose.js — tier-2 glyph composition (spec-font-fidelity-engine.md §4).
 * ============================================================================
 * Fixture: tests/fixtures/nasty/carlito-subset.ttf — a TRUE subset (pyftsubset,
 * GSUB/GPOS deliberately stripped: the worst-case real-Word shape). Its pinned
 * facts, measured when the fixture was cut (see the spec's prototype receipts):
 *   é composite present (components: empty width-setter + e + acute),
 *   É ABSENT, acute outline present ONLY as an un-cmapped component (no
 *   U+0301, no U+00B4 in cmap) — composition works ONLY via the glyf donor
 *   parse, which is exactly what these tests pin.
 * Ground-truth numbers (full Carlito's own É composite) anchor the placement
 * assertions: E gid=5 advance=1000 bbox maxY=1314; e bbox maxY=993; acute
 * component in é at dx=312, mark bbox y 1123..1399 → donor gap 130.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planComposedChar, planComposedInsert, patchToUnicodeForMarks } from '../../js/core/compose.js';
import { extractFontProgram } from '../../js/core/reinsert.js';
import { planNativeInserts } from '../../js/core/page-surgery.js';
import { readPageContents } from '../../js/core/redact.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};

const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
const SUBSET_BYTES = new Uint8Array(fs.readFileSync(path.join(root, 'tests/fixtures/nasty/carlito-subset.ttf')));
const font = fontkit.create(SUBSET_BYTES);

test('fixture sanity: the subset really has the composable-but-uncovered shape', () => {
  assert.equal(font.hasGlyphForCodePoint('é'.codePointAt(0)), true);
  assert.equal(font.hasGlyphForCodePoint('É'.codePointAt(0)), false);
  assert.equal(font.hasGlyphForCodePoint(0x0301), false); // combining acute not cmapped
  assert.equal(font.hasGlyphForCodePoint(0x00b4), false); // spacing acute not cmapped
});

test('planComposedChar: É composes via the glyf donor parse, placement pinned to ground truth', () => {
  const plan = planComposedChar(font, SUBSET_BYTES, 'É');
  assert.equal(plan.ok, true);
  assert.equal(plan.baseGid, font.glyphForCodePoint(0x45).id);
  assert.equal(plan.baseAdvance, 1000);
  assert.equal(plan.markCp, 0x0301);
  // the mark gid must NOT be any cmapped glyph — it is reachable only as a
  // component (the whole point of rung c)
  const cmappedGids = new Set([...font.characterSet].map((cp) => font.glyphForCodePoint(cp).id));
  assert.equal(cmappedGids.has(plan.markGid), false);
  // vertical: donor gap preserved — E.maxY(1314) + gap(130) − mark.minY(1123) = 321
  assert.equal(Math.round(plan.dy), 321);
  // horizontal: donor dx(312) recentered from e's outline center to E's
  const e = font.glyphForCodePoint(0x65);
  const E = font.glyphForCodePoint(0x45);
  const want = 312 + ((E.bbox.minX + E.bbox.maxX) / 2 - (e.bbox.minX + e.bbox.maxX) / 2);
  assert.equal(Math.round(plan.dx), Math.round(want));
});

test('planComposedChar: every v1 boundary declines with its own typed reason', () => {
  assert.equal(planComposedChar(font, SUBSET_BYTES, 'ß').reason, 'compose-not-decomposable');
  assert.equal(planComposedChar(font, SUBSET_BYTES, 'Ç').reason, 'compose-below-mark'); // cedilla attaches below
  assert.equal(planComposedChar(font, SUBSET_BYTES, 'Ǻ').reason, 'compose-multi-mark'); // A + ring + acute
  // Ĝ decomposes to G + circumflex; G is not in the subset text at all
  assert.equal(planComposedChar(font, SUBSET_BYTES, 'Ĝ').reason, 'compose-base-missing');
  // Ñ: base N is covered, tilde exists in NEITHER cmap NOR any donor composite
  // (the fixture text has no ñ) — the mark resolution ladder runs dry
  assert.equal(planComposedChar(font, SUBSET_BYTES, 'Ñ').reason, 'compose-mark-missing');
});

test('planComposedInsert: full plan — base run + one mark block per É, width = base advances', () => {
  const insert = { fontName: 'F1', x: 72, y: 560, ux: 1, uy: 0, size: 28 };
  const plan = planComposedInsert(font, SUBSET_BYTES, insert, 'KAFÉ ANDRÉA', '#1a1a1f');
  assert.equal(plan.ok, true);
  assert.equal(plan.marks.length, 2);
  // exactly 3 BT blocks: one base run + two absolutely-positioned marks
  assert.equal(plan.snippet.split(' BT ').length - 1, 3);
  // width equals the sum of base advances (É contributes E's advance) — the
  // composed char must not change the line's occupied space
  const per = (cp) => font.glyphForCodePoint(cp).advanceWidth;
  const adv = (s) => [...s].reduce((sum, c) => sum + (c === 'É' ? per(0x45) : per(c.codePointAt(0))), 0)
    + 0; // spaces handled below
  const spaceAdv = font.glyphForCodePoint(32).advanceWidth;
  const units = adv('KAFÉANDRÉA') + spaceAdv;
  assert.ok(Math.abs(plan.width - (units / font.unitsPerEm) * 28) < 0.01);
  // a fully-covered text has nothing to compose — the caller should have
  // taken the native path; this planner declines rather than duplicate it
  assert.equal(planComposedInsert(font, SUBSET_BYTES, insert, 'KAF', '#000000').reason, 'compose-nothing-to-compose');
  // one uncomposable char anywhere declines the WHOLE plan (no partial paint)
  assert.equal(planComposedInsert(font, SUBSET_BYTES, insert, 'KAFÉ Ñ', '#000000').ok, false);
});

test('page-surgery integration: missing-glyph rescues via compose; uncomposable stays twin', async () => {
  // a real Type0/Identity-H PDF around the subset, exactly the export shape
  const doc = await PDFLib.PDFDocument.create();
  doc.registerFontkit(fontkit);
  const embedded = await doc.embedFont(SUBSET_BYTES, { subset: false });
  const page0 = doc.addPage([595, 842]);
  page0.drawText('Kafé Andréa', { x: 72, y: 720, size: 12, font: embedded });
  const loaded = await PDFLib.PDFDocument.load(await doc.save());
  const pdfPage = loaded.getPages()[0];

  const { PDFName, PDFRef, PDFDict } = PDFLib;
  const context = pdfPage.doc.context;
  const res = (v) => (v instanceof PDFRef ? context.lookup(v) : v);
  const fontDict = res(pdfPage.node.Resources().get(PDFName.of('Font')));
  assert.ok(fontDict instanceof PDFDict);
  const fontName = fontDict.keys()[0].toString().replace(/^\//, '');

  const insert = { fontName, x: 72, y: 560, ux: 1, uy: 0, size: 28, mixedFonts: false };
  const annotations = [
    // É is missing from the subset but composable → must paint natively-composed
    { id: 't-compose', type: 'text', replaceCoverId: 'c1', text: 'KAFÉ ANDRÉA', color: '#112233' },
    // S/E/O/R/A are all covered — the decline is genuinely the tilde, which
    // the subset carries nowhere (no ñ donor, no cmap) → whole plan → twin
    { id: 't-twin', type: 'text', replaceCoverId: 'c2', text: 'SEÑORA', color: '#112233' },
  ];
  const skipCovers = new Set(['c1', 'c2']);
  const insertByCover = new Map([['c1', insert], ['c2', { ...insert, y: 520 }]]);

  const before = readPageContents(pdfPage, PDFLib);
  const skipDraw = planNativeInserts(pdfPage, PDFLib, fontkit, annotations, skipCovers, insertByCover);

  assert.ok(skipDraw.has('t-compose'), 'composable edit painted natively (composed)');
  assert.equal(skipDraw.has('t-twin'), false, 'uncomposable edit left for the twin drawer');

  const after = readPageContents(pdfPage, PDFLib);
  const added = after.slice(before.length);
  // one base run + two mark blocks, and nothing painted for the declined edit
  assert.equal(added.split(' BT ').length - 1, 3);
  // the base run substitutes E's gid in É's slot
  const gidE = font.glyphForCodePoint(0x45).id.toString(16).padStart(4, '0');
  assert.ok(added.includes(gidE), 'base run carries E in the composed slot');
}, { timeout: 20000 });

test('patchToUnicodeForMarks: extraction honesty — mark GID gains an NFD bfchar, idempotently', async () => {
  // a real PDF around the subset: pdf-lib emits Type0/Identity-H + ToUnicode
  const doc = await PDFLib.PDFDocument.create();
  doc.registerFontkit(fontkit);
  const embedded = await doc.embedFont(SUBSET_BYTES, { subset: false });
  const page = doc.addPage([595, 842]);
  page.drawText('Kafé Andréa', { x: 72, y: 720, size: 12, font: embedded });
  const loaded = await PDFLib.PDFDocument.load(await doc.save());
  const pdfPage = loaded.getPages()[0];

  const { PDFName, PDFRef, PDFDict, decodePDFRawStream } = PDFLib;
  const context = pdfPage.doc.context;
  const res = (v) => (v instanceof PDFRef ? context.lookup(v) : v);
  const fontDict = res(pdfPage.node.Resources().get(PDFName.of('Font')));
  assert.ok(fontDict instanceof PDFDict);
  const fontName = fontDict.keys()[0].toString().replace(/^\//, '');

  const readCmap = () => {
    const fontObj = res(fontDict.get(PDFName.of(fontName)));
    const stream = res(fontObj.get(PDFName.of('ToUnicode')));
    let s = '';
    for (const b of decodePDFRawStream(stream).decode()) s += String.fromCharCode(b);
    return s;
  };

  const plan = planComposedChar(
    font,
    extractFontProgram(pdfPage, PDFLib, fontName).bytes,
    'É',
  );
  assert.equal(plan.ok, true);
  const marks = [{ gid: plan.markGid, codepoint: plan.markCp }];
  const gidHex = plan.markGid.toString(16).padStart(4, '0');

  assert.equal(readCmap().includes(`<${gidHex}>`), false, 'mark unmapped before patch');
  assert.equal(patchToUnicodeForMarks(pdfPage, PDFLib, fontName, marks), true);
  const after = readCmap();
  assert.ok(after.includes(`<${gidHex}> <0301>`), 'bfchar added');
  assert.ok(after.lastIndexOf('endcmap') > after.indexOf(`<${gidHex}>`), 'entry sits inside the cmap');

  // idempotent: a second patch for the same GID adds nothing
  assert.equal(patchToUnicodeForMarks(pdfPage, PDFLib, fontName, marks), true);
  const twice = readCmap();
  assert.equal(twice.indexOf(`<${gidHex}>`), twice.lastIndexOf(`<${gidHex}>`));

  // and the patched document still saves + reloads cleanly
  const reloaded = await PDFLib.PDFDocument.load(await loaded.save());
  assert.equal(reloaded.getPages().length, 1);
});
