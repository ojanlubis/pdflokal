/*
 * page-rotation-export.test.mjs — the exported file must face the way the
 * screen does.
 * ============================================================================
 * THE BUG (found 2026-08-09). Both export writers did
 * `setRotation(page.rotation)`, and pdf-lib's setRotation is ABSOLUTE — so a
 * source document's own inherited /Rotate was overwritten and lost. Meanwhile
 * core/import.js rasterizes at `baseRotation + rotation`. A PDF already
 * carrying /Rotate 90, rotated ONCE in the editor, therefore showed 180 on
 * screen and exported at 90. The screen and the file disagreed, and the user
 * only found out after they had the file.
 *
 * WHY NO EXISTING TEST CAUGHT IT, and this is the part worth remembering:
 * every fixture in tests/fixtures/nasty/ has baseRotation 0 — including
 * `halaman-miring.pdf`, whose name promises otherwise (its content is drawn
 * askew; the file carries no /Rotate at all). At baseRotation 0 the buggy
 * formula and the correct one are the SAME NUMBER. The whole corpus agreed
 * with both implementations, so no amount of it could tell them apart.
 * [[fixture-must-distinguish]] — hence `putar-90.pdf`
 * (scripts/gen-fixture-putar.mjs), which self-verifies that it really carries
 * /Rotate 90 and that its MediaBox is not square.
 *
 * THE ORACLE IS NOT THE FORMULA. Asserting only "output /Rotate === base +
 * user" would re-derive the fix and agree with itself. So every case ALSO
 * asserts the claim the user actually makes: the exported page's DISPLAYED
 * dimensions equal the model's own displayed dimensions — page.width/height
 * as core/import.js recorded them from PDF.js's rotate-honouring viewport,
 * swapped by the user's rotation. That is the screen's number and the file's
 * number, compared. It is what goes red on revert, and it cannot be satisfied
 * by a rotation that merely looks arithmetically tidy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as model from '../../js/core/model.js';
import * as ops from '../../js/core/operations.js';
import { buildPdfBytes } from '../../js/core/export.js';
import { buildEditedPageBytes } from '../../js/core/page-surgery.js';
import { totalPageRotation } from '../../js/core/page-rotation.js';
import { extractFontMetrics, readPageContents } from '../../js/core/redact.js';
import { walkShowOps } from '../../js/core/text-walk.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NASTY = (name) => path.join(root, 'tests', 'fixtures', 'nasty', name);
const FIXTURE = 'putar-90.pdf';

const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};

// What a reader SEES, given a raw box and a /Rotate. Used on both sides of
// every comparison below — the model's frame and the exported file's — so what
// is being asserted is that the two AGREE, not that either matches a formula
// this file also owns.
const displayed = (w, h, rot) => (Math.abs(rot) % 180 !== 0 ? { w: h, h: w } : { w, h });

// Build the doc model exactly the way core/import.js builds it:
//   width/height  <- a rotate-HONOURING viewport, so baseRotation is already
//                    baked into them (PDF.js getViewport({scale:1}));
//   baseRotation  <- the document's own /Rotate, read off the file.
// Rebuilt here from pdf-lib rather than run through import.js, which needs
// PDF.js and a DOM. The rotate-honouring part is reproduced explicitly (that
// is what `displayed()` does) so the mirroring is visible rather than assumed.
async function buildDoc(PDFLib, { pageIndexes, userRotations }) {
  const bytes = fs.readFileSync(NASTY(FIXTURE));
  const src = await PDFLib.PDFDocument.load(bytes);
  const doc = model.createDoc();
  const source = ops.addSource(doc, model.createSource({
    name: FIXTURE, bytes, numPages: src.getPageCount(),
  }));
  const pages = pageIndexes.map((idx, i) => {
    const srcPage = src.getPages()[idx];
    const { width: mw, height: mh } = srcPage.getSize();
    const base = srcPage.getRotation().angle;
    const view = displayed(mw, mh, base);
    const page = model.createPage({
      source, sourcePageNum: idx, width: view.w, height: view.h, rotation: userRotations[i],
    });
    page.baseRotation = base;
    return page;
  });
  ops.addPages(doc, pages);
  return { doc, pages, bytes, mediaOf: (idx) => src.getPages()[idx].getSize() };
}

async function exportedPages(PDFLib, fontkit, doc) {
  const out = await buildPdfBytes(doc, { PDFLib, fontkit });
  const reread = await PDFLib.PDFDocument.load(out);
  return reread.getPages();
}

// Every user rotation against a page that ALREADY carries /Rotate 90. The
// second column is what the buggy code produced — kept in the table so the
// revert case is legible rather than a memory.
const ROTATED_CASES = [
  { user: 0, expected: 90, buggy: 90 }, // agrees: the one case that never broke
  { user: 90, expected: 180, buggy: 90 },
  { user: 180, expected: 270, buggy: 180 },
  { user: 270, expected: 0, buggy: 270 },
];

test('buildPdfBytes: a source /Rotate 90 SURVIVES the export and composes with the user rotation', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

  for (const { user, expected, buggy } of ROTATED_CASES) {
    const { doc, pages, mediaOf } = await buildDoc(PDFLib, {
      pageIndexes: [0], userRotations: [user],
    });
    const [outPage] = await exportedPages(PDFLib, fontkit, doc);
    const outRot = outPage.getRotation().angle;

    assert.equal(
      outRot, expected,
      `user rotation ${user} on a /Rotate 90 page exported at ${outRot}, expected ${expected}. `
      + `The pre-fix code produced ${buggy} — setRotation is ABSOLUTE, so the source's own `
      + '/Rotate was discarded instead of composed with.',
    );

    // THE CLAIM THE USER MAKES, checked independently of the arithmetic above:
    // the file faces the way the screen does.
    const media = mediaOf(0);
    const onScreen = displayed(pages[0].width, pages[0].height, pages[0].rotation);
    const inFile = displayed(media.width, media.height, outRot);
    assert.deepEqual(
      inFile, onScreen,
      `user rotation ${user}: the screen shows ${onScreen.w}x${onScreen.h} and the exported file `
      + `is ${inFile.w}x${inFile.h}. Screen and file must not disagree.`,
    );
  }
});

test('CONTROL: an ordinary page (no inherited /Rotate) is untouched — the fix changes only what was broken', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

  // Page 1 of the fixture carries no /Rotate. This is the case the OLD code
  // already got right, and every other fixture in the corpus. If the fix moved
  // it, the fix is wrong. Without this half the suite could not tell a correct
  // change from one that simply rotates everything.
  for (const user of [0, 90, 180, 270]) {
    const { doc, pages, mediaOf } = await buildDoc(PDFLib, {
      pageIndexes: [1], userRotations: [user],
    });
    const [outPage] = await exportedPages(PDFLib, fontkit, doc);
    assert.equal(outPage.getRotation().angle, user, `control page, user rotation ${user}`);

    const media = mediaOf(1);
    assert.deepEqual(
      displayed(media.width, media.height, outPage.getRotation().angle),
      displayed(pages[0].width, pages[0].height, pages[0].rotation),
      `control page at user rotation ${user}: screen and file disagree`,
    );
  }
});

test('buildPdfBytes: a rotated page and a plain page in ONE document each keep their own answer', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

  // Both pages rotated 90 BY THE USER. They must not converge: the inherited
  // /Rotate is per-page document data, not a document-wide setting.
  const { doc } = await buildDoc(PDFLib, { pageIndexes: [0, 1], userRotations: [90, 90] });
  const out = await exportedPages(PDFLib, fontkit, doc);
  assert.equal(out[0].getRotation().angle, 180, 'the /Rotate 90 page must land at 180');
  assert.equal(out[1].getRotation().angle, 90, 'the plain page must land at 90');
});

test('buildEditedPageBytes: the LIVE re-render bakes the same total — or an edited page faces a different way than its neighbours', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

  // WHY THIS MATTERS ON SCREEN, not just in the file: core/import.js's
  // rasterizer treats an EDITED page's baked bytes as authoritative and reads
  // their /Rotate straight back, where a plain page is rendered at
  // baseRotation + rotation. If the two writers disagree, an edited page and
  // an unedited page of the SAME document face different ways in the editor.
  const bytes = fs.readFileSync(NASTY(FIXTURE));
  const srcDoc = await PDFLib.PDFDocument.load(bytes);
  const srcPage = srcDoc.getPages()[0];
  const { width: mw, height: mh } = srcPage.getSize();
  const base = srcPage.getRotation().angle;
  assert.equal(base, 90, 'the fixture stopped carrying /Rotate 90 — regenerate it');

  // A ganti pair (cover + replacement text) over a run the fixture really has,
  // with geometry DERIVED from its own content stream — same self-consistency
  // discipline as export-parity.test.mjs, so the surgery has something real to
  // bite on rather than hand-typed coordinates.
  const fonts = extractFontMetrics(srcPage, PDFLib);
  const records = walkShowOps(readPageContents(srcPage, PDFLib), fonts);
  assert.ok(records.length > 0, 'no show-ops found in the fixture — the derivation broke');
  const rec = records[0];
  const target = { x0: rec.x, y0: rec.y, ux: rec.ux, uy: rec.uy, size: rec.size, len: 300 };

  for (const user of [0, 90]) {
    const doc = model.createDoc();
    const source = ops.addSource(doc, model.createSource({ name: FIXTURE, bytes, numPages: 2 }));
    const view = displayed(mw, mh, base);
    const page = model.createPage({
      source, sourcePageNum: 0, width: view.w, height: view.h, rotation: user,
    });
    page.baseRotation = base;
    ops.addPages(doc, [page]);

    const cover = model.createAnnotation('whiteout', {
      x: 0, y: 0, width: 10, height: 10,
      replaceTargets: [target],
      replaceBox: { x: 0, y: 0, w: 10, h: 10 },
    });
    ops.addAnnotation(doc, page.id, cover);
    const text = model.createAnnotation('text', {
      x: 0, y: 0, width: 200, height: 20,
      text: 'DIGANTI', fontFamily: 'Helvetica', fontSize: 12, color: '#000000',
      replaceCoverId: cover.id,
    });
    ops.addAnnotation(doc, page.id, text);

    const res = await buildEditedPageBytes(srcDoc, page, page.annotations, { PDFLib, fontkit });
    assert.ok(res.bytes, `no edited bytes produced at user rotation ${user} — the surgery declined, `
      + 'so this test would prove nothing about rotation');
    const baked = (await PDFLib.PDFDocument.load(res.bytes)).getPages()[0];
    assert.equal(
      baked.getRotation().angle, (base + user) % 360,
      `the live re-render baked ${baked.getRotation().angle} at user rotation ${user}; `
      + `buildPdfBytes bakes ${(base + user) % 360}. Two writers, one document, two answers.`,
    );
  }
});

test('totalPageRotation: normalises, and an image page has no inherited rotation to add', () => {
  assert.equal(totalPageRotation({ baseRotation: 90, rotation: 90 }), 180);
  assert.equal(totalPageRotation({ baseRotation: 270, rotation: 180 }), 90);
  assert.equal(totalPageRotation({ baseRotation: 90, rotation: 270 }), 0);
  // A negative /Rotate is legal in the wild (PDF 1.7 §7.7.3.3 allows any
  // multiple of 90) — it must come back positive, because pdf-lib's degrees()
  // is written straight into the file and every reader of page.rotation here
  // assumes 0|90|180|270.
  assert.equal(totalPageRotation({ baseRotation: -90, rotation: 0 }), 270);
  // An image page is built by us at the model's own size and has no source
  // document to inherit from. Guarded explicitly, so a stray baseRotation on
  // one cannot start double-counting.
  assert.equal(totalPageRotation({ isFromImage: true, baseRotation: 90, rotation: 90 }), 90);
  // Defensive: garbage in must not produce an off-axis rotation.
  assert.equal(totalPageRotation({}), 0);
  assert.equal(totalPageRotation(null), 0);
});
