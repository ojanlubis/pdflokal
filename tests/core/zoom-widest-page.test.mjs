/*
 * A DOCUMENT OPENS FITTED TO ITS WIDEST PAGE, NOT TO PAGE 1.
 *
 * Reproduced 2026-11-03 on main 4a892d1: a PDF whose page 1 is an A5 (420pt)
 * and whose pages 2-3 are A4 (595pt) opened at page 1's fit, so on a 375px
 * phone the A4 pages rendered 509px wide and on a 1280px desktop 1677px. A
 * single file is never width-normalised (normalizePageWidths only acts on a
 * merge), so the mixed widths reach the view as they are. Founder ruling
 * 2026-11-03: the view fits the widest page. A uniform document must open at
 * exactly the zoom it always did.
 *
 * The document is built through the real model and operations, so the widths
 * handed to core/zoom.js are the ones a load actually leaves behind.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { openingZoom, zoomAfterLoad, ZOOM_MAX, OPENING_GUTTER_TOUCH, OPENING_GUTTER_DESKTOP } = await import('../../js/core/zoom.js');
const model = await import('../../js/core/model.js');
const ops = await import('../../js/core/operations.js');

const PHONE = { viewport: 375, desktop: false };
const DESKTOP = { viewport: 1280, desktop: true };

// One PDF, so one source: what a single opened file leaves in the model.
function singleFile(sizes) {
  model._resetIds();
  const doc = model.createDoc();
  const src = ops.addSource(doc, model.createSource({ name: 'campur.pdf', bytes: new Uint8Array([1]), numPages: sizes.length }));
  ops.addPages(doc, sizes.map(([width, height], i) => model.createPage({ source: src, sourcePageNum: i, width, height })));
  assert.deepEqual(ops.normalizePageWidths(doc), [], 'VACUITY GUARD: a single file is not normalised');
  return doc;
}

// What showEditor asks for on a first load.
function firstLoadZoom(doc, view) {
  return zoomAfterLoad({ ...view, firstLoad: true, existingRescaled: false, current: 1, pageWidths: doc.pages.map((p) => p.width) });
}

const A5 = [420, 595];
const A4 = [595, 842];

for (const [name, view, gutter] of [['phone', PHONE, OPENING_GUTTER_TOUCH], ['desktop', DESKTOP, OPENING_GUTTER_DESKTOP]]) {
  test(`${name}: an A5 page 1 before A4 pages opens at the A4's fit`, () => {
    const doc = singleFile([A5, A4, A4]);
    assert.deepEqual(doc.pages.map((p) => p.width), [420, 595, 595], 'VACUITY GUARD: the widths are mixed');
    const z = firstLoadZoom(doc, view);
    assert.ok(Math.abs(z - (view.viewport - gutter) / 595) < 1e-9, `zoom ${z}`);
    for (const p of doc.pages) {
      assert.ok(p.width * z <= view.viewport - gutter + 1e-6, `a ${p.width}pt page renders ${Math.round(p.width * z)}px in a ${view.viewport}px view`);
    }
  });
}

test('the widest page decides wherever it sits in the document', () => {
  assert.equal(openingZoom({ ...PHONE, pageWidths: [420, 595, 595] }), openingZoom({ ...PHONE, pageWidths: [595, 420, 595] }));
  assert.equal(openingZoom({ ...PHONE, pageWidths: [420, 420, 595] }), openingZoom({ ...PHONE, pageWidths: [595] }));
});

test('a uniform document opens at exactly the zoom it always did', () => {
  // The numbers the page-1 fit gave before the widest-page rule: for one width
  // the two rules are the same rule.
  assert.equal(firstLoadZoom(singleFile([A4, A4, A4]), PHONE), (375 - 16) / 595);
  assert.equal(firstLoadZoom(singleFile([A4, A4, A4]), DESKTOP), (1280 - 96) / 595);
  // The caps hold: mobile never above 1, desktop never above ZOOM_MAX.
  assert.equal(firstLoadZoom(singleFile([[200, 400], [200, 400]]), PHONE), 1);
  assert.equal(firstLoadZoom(singleFile([[200, 400], [200, 400]]), DESKTOP), ZOOM_MAX);
});

test('the floor still lets a huge photo page open whole', () => {
  // A 3024pt photo page beside an A4: the fit (0.114 on a 375px phone) is below
  // the usual 0.3 floor, and the floor follows it down rather than holding 0.3.
  const z = openingZoom({ ...PHONE, pageWidths: [595, 3024] });
  assert.ok(Math.abs(z - (375 - 16) / 3024) < 1e-9, `zoom ${z}`);
});

test('no pages, or only degenerate ones, opens at 1', () => {
  assert.equal(openingZoom({ ...PHONE, pageWidths: [] }), 1);
  assert.equal(openingZoom({ ...PHONE, pageWidths: [0, NaN] }), 1);
});
