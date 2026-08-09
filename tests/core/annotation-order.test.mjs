/*
 * annotation-order.test.mjs — Tip-Ex is a GROUND, not a layer.
 * ============================================================================
 * Founder ruling 2026-08-09, verbatim: "it should be default that the layer
 * order on the canvas is tipex at the bottom and teks at top. by definition.
 * we're not photoshop. we're pdflokal. on text file, people use tipex to
 * either erase a printed text, or to write over those. if they want to erase
 * what they wrote using teks tool, they just got to delete the text, no need
 * to tipeks it."
 *
 * WHAT WAS THERE BEFORE: nothing. No z-order field, no sort, no rank —
 * core/operations.js pushed, and both painters (js/render/page-view.js and
 * js/core/export.js) walked the array in creation order. Cover-under-text
 * worked only BY ACCIDENT, because js/v2/app.js's Ganti path happens to create
 * the cover before its replacement text. The rule turns that accident into a
 * guarantee, and this file is where the guarantee is kept.
 *
 * THE SHARP CASE, and the one that goes red on revert: a text annotation
 * created FIRST and a whiteout dragged over it SECOND. In creation order the
 * whiteout wins and the text disappears under it. Under the rule the text
 * wins — on screen and in the file.
 *
 * ⚠️ THE OTHER HALF OF THIS FILE IS THE NON-MUTATION GUARD, and it is not
 * ceremony. core/page-surgery.js's applyPageSurgery is handed the SAME
 * annotation array and pairs each Ganti cover to its replacement text out of
 * it. Reordering that array in place — rather than sorting a copy — would
 * silently re-pair covers to the wrong text and break the edit engine, with
 * every existing surgery test still green because they each use a single pair.
 *
 * A BLANK SOURCE PAGE ON PURPOSE. Every fixture in tests/fixtures/nasty/
 * carries its own text, so the exported content stream would contain BT/Tj
 * from the DOCUMENT as well as from our annotations, and "which was painted
 * first" could not be read off it. The source here is a one-page PDF with no
 * content at all, so every operator in the output is one we put there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as model from '../../js/core/model.js';
import * as ops from '../../js/core/operations.js';
import { buildPdfBytes } from '../../js/core/export.js';
import { readPageContents } from '../../js/core/redact.js';
import {
  orderedForPaint, annotationRank, annotationZIndex, ANNOTATION_RANK, DEFAULT_RANK,
} from '../../js/core/annotation-order.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};

const W = 400;
const H = 400;

async function blankSourceBytes(PDFLib) {
  const d = await PDFLib.PDFDocument.create();
  d.addPage([W, H]);
  return d.save();
}

async function docWithAnnotations(PDFLib, make) {
  const bytes = await blankSourceBytes(PDFLib);
  const doc = model.createDoc();
  const source = ops.addSource(doc, model.createSource({ name: 'blank.pdf', bytes, numPages: 1 }));
  const page = model.createPage({ source, sourcePageNum: 0, width: W, height: H, rotation: 0 });
  ops.addPages(doc, [page]);
  make(doc, page);
  return { doc, page };
}

const mkWhiteout = () => model.createAnnotation('whiteout', {
  x: 40, y: 40, width: 200, height: 60, color: '#ffffff',
});
const mkText = (text) => model.createAnnotation('text', {
  x: 50, y: 50, width: 180, height: 20,
  text, fontFamily: 'Helvetica', fontSize: 14, color: '#000000',
});

// Which operator appears first in the exported page's content stream. A
// whiteout is pdf-lib's drawRectangle, which emits an explicit m/l path closed
// with `h` and filled with `f` (NOT the `re` shorthand — checked against the
// vendored build's actual output, because guessing the operator is how a
// search returns -1 and an assertion passes for free somewhere else). A text
// annotation is a BT…ET text object. With a blank source page these are the
// only two things in there, so their order IS the paint order.
async function paintOrder(PDFLib, fontkit, doc) {
  const out = await buildPdfBytes(doc, { PDFLib, fontkit });
  const reread = await PDFLib.PDFDocument.load(out);
  const content = readPageContents(reread.getPages()[0], PDFLib);
  const rectAt = content.search(/(^|\s)h\s+f(\s|$)/);
  const textAt = content.search(/(^|\s)BT(\s|$)/);
  assert.notEqual(rectAt, -1, 'no rectangle found in the exported content stream — the whiteout never drew');
  assert.notEqual(textAt, -1, 'no text object found in the exported content stream — the text never drew');
  return rectAt < textAt ? ['whiteout', 'text'] : ['text', 'whiteout'];
}

test('EXPORT, the sharp case: a whiteout created AFTER a text still paints UNDER it', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

  // Creation order: text, THEN the whiteout dragged over it. Before the rule
  // the whiteout painted last and swallowed the text.
  const { doc } = await docWithAnnotations(PDFLib, (d, page) => {
    ops.addAnnotation(d, page.id, mkText('HARUS TERLIHAT'));
    ops.addAnnotation(d, page.id, mkWhiteout());
  });

  assert.deepEqual(
    await paintOrder(PDFLib, fontkit, doc), ['whiteout', 'text'],
    'the whiteout painted OVER the text. Tip-Ex is a ground, not a layer — it goes under, '
    + 'whatever order the two were created in.',
  );
});

test('EXPORT, the ordinary case: a whiteout created FIRST also paints under — the rule is not order-dependent', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

  // This one was already right by accident of insertion order. It must STAY
  // right — a "fix" that merely reverses the array would pass the test above
  // and fail this one, which is why both halves are here.
  const { doc } = await docWithAnnotations(PDFLib, (d, page) => {
    ops.addAnnotation(d, page.id, mkWhiteout());
    ops.addAnnotation(d, page.id, mkText('HARUS TERLIHAT'));
  });

  assert.deepEqual(await paintOrder(PDFLib, fontkit, doc), ['whiteout', 'text']);
});

test('GANTI: the cover stays under its replacement even when the pair is built backwards', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

  // js/v2/app.js builds the cover BEFORE the replacement text, so today's
  // correctness is an accident of insertion order. Built backwards on purpose:
  // the guarantee has to come from the rank, not from the call sequence in one
  // function that could be refactored tomorrow.
  const { doc, page } = await docWithAnnotations(PDFLib, (d, p) => {
    const cover = mkWhiteout();
    cover.replaceBox = { x: cover.x, y: cover.y, w: cover.width, h: cover.height };
    const text = mkText('PENGGANTI');
    ops.addAnnotation(d, p.id, text);
    ops.addAnnotation(d, p.id, cover);
    text.replaceCoverId = cover.id;
  });

  assert.deepEqual(await paintOrder(PDFLib, fontkit, doc), ['whiteout', 'text']);
  // And the pairing itself must be untouched: the text still names its cover.
  const [first, second] = page.annotations;
  assert.equal(first.type, 'text');
  assert.equal(second.type, 'whiteout');
  assert.equal(first.replaceCoverId, second.id, 'the ganti pairing was disturbed');
});

test('THE SURGERY GUARD: page.annotations is NOT reordered by an export', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

  const { doc, page } = await docWithAnnotations(PDFLib, (d, p) => {
    ops.addAnnotation(d, p.id, mkText('SATU'));
    ops.addAnnotation(d, p.id, mkWhiteout());
    ops.addAnnotation(d, p.id, mkText('DUA'));
  });
  const before = page.annotations.map((a) => a.id);

  await buildPdfBytes(doc, { PDFLib, fontkit });

  assert.deepEqual(
    page.annotations.map((a) => a.id), before,
    'the export REORDERED the model. core/page-surgery.js pairs Ganti covers to their '
    + 'replacement text by walking this array in creation order — sort a COPY, never this.',
  );
});

test('orderedForPaint: stable within a rank, and it returns a COPY', () => {
  const t1 = mkText('a');
  const w1 = mkWhiteout();
  const t2 = mkText('b');
  const w2 = mkWhiteout();
  const input = [t1, w1, t2, w2];
  const out = orderedForPaint(input);

  assert.deepEqual(out.map((a) => a.id), [w1.id, w2.id, t1.id, t2.id],
    'whiteouts first in creation order, then everything else in creation order');
  assert.notEqual(out, input, 'orderedForPaint must not hand back the array it was given');
  assert.deepEqual(input.map((a) => a.id), [t1.id, w1.id, t2.id, w2.id], 'the input was mutated');
  // Empty / missing input must not throw — renderPageView calls this on every
  // page, including ones with no annotations at all.
  assert.deepEqual(orderedForPaint([]), []);
  assert.deepEqual(orderedForPaint(undefined), []);
});

test('the rank table says what it means: whiteout below, everything else together', () => {
  assert.equal(ANNOTATION_RANK.whiteout, 0);
  assert.equal(annotationRank({ type: 'whiteout' }), 0);
  // He ruled Tip-Ex to the bottom and NOTHING ELSE. Signature/watermark/
  // pageNumber must share text's rank, or this change has quietly invented an
  // ordering he never asked for.
  for (const type of ['text', 'signature', 'watermark', 'pageNumber']) {
    assert.equal(annotationRank({ type }), DEFAULT_RANK, `${type} must share the default rank`);
  }
  // An unknown future type lands on top rather than under the ground.
  assert.equal(annotationRank({ type: 'something-new' }), DEFAULT_RANK);
  assert.equal(annotationRank(undefined), DEFAULT_RANK);
});

test('SELECTED IS TOP OF ITS OWN BAND — a held Tip-Ex never floats above text', () => {
  const w = { type: 'whiteout' };
  const t = { type: 'text' };
  // The defect this replaced: page-view.js gave the selected annotation
  // z-index 1000 outright, so a Tip-Ex being dragged LOOKED like it was above
  // the text and dropped behind the moment it was released. The screen lied
  // while the user was editing, and the file was the honest one.
  assert.ok(
    annotationZIndex(w, { selected: true }) < annotationZIndex(t, { selected: false }),
    'a SELECTED whiteout still sits below an unselected text',
  );
  // ...but it does lift above its own neighbours, so a buried one stays grabbable.
  assert.ok(annotationZIndex(w, { selected: true }) > annotationZIndex(w, { selected: false }));
  assert.ok(annotationZIndex(t, { selected: true }) > annotationZIndex(t, { selected: false }));
  // Unselected ordering matches the rank order, so DOM order (paint order)
  // decides among equals rather than z-index fighting it.
  assert.ok(annotationZIndex(w) < annotationZIndex(t));
});
