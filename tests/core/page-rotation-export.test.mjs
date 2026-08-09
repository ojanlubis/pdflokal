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

// ---------------------------------------------------------------------------
// THE ANNOTATION FRAME — the half the 2026-08-09 fix missed.
//
// buildPdfBytes writes the page's /Rotate from totalPageRotation (base + user)
// but built the annotation drawing frame from `page.rotation` ALONE. Those two
// lines are 57 apart in the same loop. Before that commit both read
// page.rotation and were at least CONSISTENT; after it they contradict each
// other, and on a page carrying an inherited /Rotate the annotation is
// transformed in a frame it was never authored in.
//
// WHY NO EXISTING TEST HERE COULD SEE IT: every case above builds its pages
// with ZERO annotations, and export.js only enters the drawing branch on
// `annotations.length > 0`. The suite was structurally blind — putar-90.pdf
// existed precisely to distinguish the two implementations and was never given
// anything to draw. [[fixture-must-distinguish]]
//
// THE ORACLE IS NOT THE FORMULA (same doctrine as the header). We do not assert
// the transform's output. We put a rectangle where the USER sees it, read back
// where it actually landed in the file, map that into the DISPLAY frame using
// the exported page's OWN /Rotate, and require the two to agree. The display
// mapping below is derived from PDF /Rotate semantics (§7.7.3.3 — the page is
// rotated clockwise when displayed), not from core/export.js, so the verifier
// does not share a parent with the verified.

// A PDF-space rect (bottom-left origin, y-up) as the READER sees it
// (top-left origin, y-down), for a page of MediaBox wU x hU at /Rotate `rot`.
// Each branch is the inverse of the rotation the reader applies; all four were
// checked by hand against a corner of the MediaBox.
function toDisplayRect(rot, { x, y, w, h }, wU, hU) {
  switch (((rot % 360) + 360) % 360) {
    case 90:  return { x: y, y: x, w: h, h: w };
    case 180: return { x: wU - (x + w), y, w, h };
    case 270: return { x: hU - (y + h), y: wU - (x + w), w: h, h: w };
    default:  return { x, y: hU - (y + h), w, h };
  }
}

// pdf-lib draws a rectangle as a TRANSLATED PATH, not an `re` operator:
//   q  <color> rg  1 0 0 1 <tx> <ty> cm  ...  0 0 m  0 H l  W H l  W 0 l  h  f  Q
// Verified by dumping a real export rather than assumed — an `re`-shaped regex
// would have matched nothing and quietly asserted over an empty set.
// Consecutive `cm`s compose; for pure translations that is addition, so the
// origin is the SUM of every translate since the enclosing `q`.
function lastDrawnRect(stream) {
  const at = stream.lastIndexOf('0 0 m');
  assert.notEqual(at, -1, 'no drawn path found in the exported content stream — the whiteout never got drawn, so nothing below is being tested');
  const before = stream.slice(0, at);
  const scope = before.slice(before.lastIndexOf('q'));
  let x = 0, y = 0;
  for (const m of scope.matchAll(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm/g)) {
    x += Number(m[1]); y += Number(m[2]);
  }
  const path = /0 0 m\s+0 (-?[\d.]+) l\s+(-?[\d.]+) (?:-?[\d.]+) l/.exec(stream.slice(at));
  assert.ok(path, 'the drawn path did not have the expected m/l/l shape');
  return { x, y, w: Number(path[2]), h: Number(path[1]) };
}

const VIEW_RECT = { x: 10, y: 10, w: 40, h: 20 }; // deliberately NOT square: a
// missing width/height swap is invisible on a square rect, and 90/270 is
// exactly where the swap lives.

test('buildPdfBytes: an annotation on a page with an inherited /Rotate lands where the user put it', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
  const { readPageContents } = await import('../../js/core/redact.js');

  for (const user of [0, 90, 180, 270]) {
    const { doc, pages } = await buildDoc(PDFLib, { pageIndexes: [0], userRotations: [user] });
    ops.addAnnotation(doc, pages[0].id, model.createAnnotation('whiteout', {
      ...{ x: VIEW_RECT.x, y: VIEW_RECT.y, width: VIEW_RECT.w, height: VIEW_RECT.h },
      color: '#ff00ff',
    }));

    const [outPage] = await exportedPages(PDFLib, fontkit, doc);
    const { width: wU, height: hU } = outPage.getSize();
    const drawn = lastDrawnRect(readPageContents(outPage, PDFLib));
    const onScreen = toDisplayRect(outPage.getRotation().angle, drawn, wU, hU);

    assert.deepEqual(
      onScreen, VIEW_RECT,
      `user rotation ${user} on a /Rotate 90 page: the user drew `
      + `${VIEW_RECT.w}x${VIEW_RECT.h} at (${VIEW_RECT.x},${VIEW_RECT.y}) and the exported file `
      + `shows ${onScreen.w}x${onScreen.h} at (${onScreen.x},${onScreen.y}). `
      + 'export.js builds the annotation frame from page.rotation alone, dropping baseRotation — '
      + 'so the page is written at base+user while its annotations are transformed at user only.',
    );
  }
});

test('CONTROL: an annotation on a page with NO inherited /Rotate is unmoved', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
  const { readPageContents } = await import('../../js/core/redact.js');

  // Page 1 carries no /Rotate, so base+user and user are the SAME NUMBER and
  // both implementations agree. Without this half, a "fix" that simply rotated
  // every annotation would pass the test above and break every ordinary
  // document — which is the entire corpus.
  for (const user of [0, 90, 180, 270]) {
    const { doc, pages } = await buildDoc(PDFLib, { pageIndexes: [1], userRotations: [user] });
    ops.addAnnotation(doc, pages[0].id, model.createAnnotation('whiteout', {
      x: VIEW_RECT.x, y: VIEW_RECT.y, width: VIEW_RECT.w, height: VIEW_RECT.h, color: '#ff00ff',
    }));

    const [outPage] = await exportedPages(PDFLib, fontkit, doc);
    const { width: wU, height: hU } = outPage.getSize();
    const drawn = lastDrawnRect(readPageContents(outPage, PDFLib));
    assert.deepEqual(
      toDisplayRect(outPage.getRotation().angle, drawn, wU, hU), VIEW_RECT,
      `control page, user rotation ${user}: an ordinary page's annotation moved. The fix is wrong.`,
    );
  }
});
