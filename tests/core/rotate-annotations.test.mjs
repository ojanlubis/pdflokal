/*
 * ROTATING A PAGE KEEPS ITS ANNOTATIONS ON THE PAGE, OVER THEIR CONTENT.
 * ============================================================================
 * Annotation geometry lives in the page's DISPLAYED (rotated) frame. rotatePage
 * used to change only page.rotation, so an A4 portrait page (595x842) with a
 * signature at y=700 became an 842x595 frame with the signature below the
 * bottom edge: off the page on screen and off the MediaBox in the file.
 *
 * The rule, FOUNDER RULING 2026-10-11 ("semua harus ngikut rotasi"): EVERY
 * object turns with its page, like ink on paper. A Tip-Ex box or an edit cover
 * turns as a rect (width and height swap); a signature or text keeps its own
 * size and gains a quarter-turn `turn` (0/90/180/270, clockwise), its origin
 * moving as a point. This overrules the 2026-10-10 call that kept signatures
 * and text upright, following their spot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDoc, createSource, createPage, createAnnotation, _resetIds } from '../../js/core/model.js';
import { addSource, addPages, addAnnotation, rotatePage, moveAnnotation, copySignatureToAllPages, duplicateAnnotation } from '../../js/core/operations.js';
import { displayedBox, extentOf } from '../../js/core/annotation-geometry.js';
import { createHistory, record, undo, redo } from '../../js/core/history.js';

function a4() {
  _resetIds();
  const doc = createDoc();
  const src = addSource(doc, createSource({ name: 'a.pdf', bytes: new Uint8Array([1]), numPages: 1 }));
  addPages(doc, [createPage({ source: src, sourcePageNum: 0, width: 595, height: 842 })]);
  return doc;
}
const display = (p) => (p.rotation % 180 ? { w: p.height, h: p.width } : { w: p.width, h: p.height });
const inside = (b, d) => b.x >= -1e-9 && b.y >= -1e-9 && b.x + b.w <= d.w + 1e-9 && b.y + b.h <= d.h + 1e-9;

test('1. a signature near the bottom turns with the page: origin moves as a point, turn 90, size kept', () => {
  const doc = a4();
  const [p] = doc.pages;
  const sig = addAnnotation(doc, p.id, createAnnotation('signature', { x: 100, y: 700, width: 150, height: 60, image: 'data:,' }));
  // Known-positive: in the NEW frame the old numbers really are off the page.
  assert.ok(700 + 60 > 595);
  rotatePage(doc, p.id, 90);
  const s = p.annotations.find((a) => a.id === sig.id);
  const d = display(p);
  // Clockwise, the point (x, y) lands at (H - y, x) = (842 - 700, 100).
  assert.deepEqual([s.x, s.y, s.turn], [142, 100, 90], 'the signature\'s origin turned with the paper');
  assert.deepEqual([s.width, s.height], [150, 60], 'its own size never swaps: the turn carries the orientation');
  const box = displayedBox(s, extentOf(s));
  assert.deepEqual(box, { x: 82, y: 100, w: 60, h: 150 }, 'on screen it is a 60x150 box');
  assert.ok(inside(box, d), `signature box ${JSON.stringify(box)} is off the ${d.w}x${d.h} page`);
  assert.equal(sig.turn, undefined, 'the history snapshot\'s object was not mutated');
});

test('2. a Tip-Ex box turns with the content it covers', () => {
  const doc = a4();
  const [p] = doc.pages;
  const w = addAnnotation(doc, p.id, createAnnotation('whiteout', { x: 50, y: 100, width: 200, height: 20 }));
  rotatePage(doc, p.id, 90);
  const r = p.annotations.find((a) => a.id === w.id);
  assert.deepEqual({ x: r.x, y: r.y, width: r.width, height: r.height }, { x: 842 - 120, y: 50, width: 20, height: 200 });
});

test('3. four quarter turns bring every annotation back to where it started', () => {
  const doc = a4();
  const [p] = doc.pages;
  const w = addAnnotation(doc, p.id, createAnnotation('whiteout', { x: 50, y: 100, width: 200, height: 20 }));
  const t = addAnnotation(doc, p.id, createAnnotation('text', { x: 300, y: 400, fontSize: 14, text: 'halo' }));
  const s = addAnnotation(doc, p.id, createAnnotation('signature', { x: 100, y: 700, width: 150, height: 60, image: 'data:,' }));
  const get = (id) => p.annotations.find((a) => a.id === id);
  const seen = [];
  for (let i = 0; i < 4; i += 1) {
    rotatePage(doc, p.id, 90);
    seen.push([get(t.id).turn || 0, get(s.id).turn || 0]);
  }
  assert.deepEqual(seen, [[90, 90], [180, 180], [270, 270], [0, 0]], 'each quarter adds 90 to text and signature alike');
  assert.deepEqual([get(w.id).x, get(w.id).y, get(w.id).width, get(w.id).height], [50, 100, 200, 20]);
  assert.deepEqual([get(t.id).x, get(t.id).y], [300, 400], 'exact: a turn moves a point, no estimate, no clamp');
  assert.deepEqual([get(s.id).x, get(s.id).y, get(s.id).width, get(s.id).height], [100, 700, 150, 60]);
  assert.equal(get(t.id).turn, undefined, 'a full circle leaves no residue on the model');
  assert.equal(p.rotation, 0);
});

// ---- round-3 hardening (2026-10-10) ------------------------------------------
// An edit cover's replaceBox / ocrBox are its BIRTH rect in the SAME displayed
// frame as the cover (page-surgery.js overlapsBirthBox compares them directly).
// Turning the cover without them made surgery decline: the original text stayed
// in the file under a painted box. tests/core/rotate-merge-edit-surgery.test.mjs
// proves the export consequence; this pins the geometry.
test('4. an edit cover turns WITH its replaceBox / ocrBox, so they still coincide', () => {
  const doc = a4();
  const [p] = doc.pages;
  const box = { x: 60, y: 200, w: 300, h: 18 };
  const c = addAnnotation(doc, p.id, createAnnotation('whiteout', {
    x: box.x, y: box.y, width: box.w, height: box.h, replaceTargets: [{}], replaceBox: { ...box }, ocrBox: { ...box },
  }));
  rotatePage(doc, p.id, 90);
  const r = p.annotations.find((a) => a.id === c.id);
  const rect = { x: r.x, y: r.y, w: r.width, h: r.height };
  assert.notDeepEqual(rect, box, 'VACUITY GUARD: the cover really moved');
  assert.deepEqual(r.replaceBox, rect);
  assert.deepEqual(r.ocrBox, rect);
  assert.deepEqual(c.replaceBox, box, 'the history snapshot\'s nested box was not mutated');
});

test('5. text with no stored width/height turns about its own origin and stays on the page', () => {
  const doc = a4();
  const [p] = doc.pages;
  // v2 text annotations carry no width/height: the view sizes them from the text.
  const t = addAnnotation(doc, p.id, createAnnotation('text', { x: 40, y: 20, fontSize: 14, text: 'Nomor: 123/ABC/2026' }));
  assert.equal(t.width, undefined, 'VACUITY GUARD: the case under test has no stored size');
  rotatePage(doc, p.id, 90);
  const r = p.annotations.find((a) => a.id === t.id);
  assert.deepEqual([r.x, r.y, r.turn], [842 - 20, 40, 90]);
  const box = displayedBox(r, extentOf(r));
  const d = display(p);
  assert.ok(inside(box, d), `turned text box ${JSON.stringify(box)} is off the ${d.w}x${d.h} page`);
  assert.ok(box.h > box.w, 'it now reads down the page: taller than wide');
  assert.equal(r.width, undefined, 'no size is invented onto the stored annotation');
});

test('6. a -90 turn is ONE counter-clockwise turn: turn 270, exact, no clamp needed', () => {
  const doc = a4();
  const [p] = doc.pages;
  const s = addAnnotation(doc, p.id, createAnnotation('signature', { x: 10, y: 10, width: 580, height: 100, image: 'data:,' }));
  rotatePage(doc, p.id, -90);
  const r = p.annotations.find((a) => a.id === s.id);
  // Counter-clockwise, the point (x, y) lands at (y, W - x) = (10, 585).
  assert.deepEqual([r.x, r.y, r.turn], [10, 585, 270]);
  assert.deepEqual(displayedBox(r, extentOf(r)), { x: 10, y: 5, w: 100, h: 580 });
  assert.equal(p.rotation, 270);
});

test('7. a paragraph block\'s display origin moves with its annotation', () => {
  const doc = a4();
  const [p] = doc.pages;
  const t = addAnnotation(doc, p.id, createAnnotation('text', {
    x: 60, y: 200, width: 300, height: 40, fontSize: 12, text: 'a\nb',
    block: { k: 1, disp: { x: 60, y: 212 }, below: 260, lines: ['a', 'b'] },
  }));
  rotatePage(doc, p.id, 90);
  const r = p.annotations.find((a) => a.id === t.id);
  assert.deepEqual([r.block.disp.x - r.x, r.block.disp.y - r.y], [0, 12], 'disp keeps its offset from the annotation');
  assert.deepEqual(t.block.disp, { x: 60, y: 212 }, 'the original block was not mutated');
});

// ---- the turned object stays an object --------------------------------------
test('8. a drag clamps the turned signature by the box the screen shows, not its own w/h', () => {
  const doc = a4();
  const [p] = doc.pages;
  const sig = addAnnotation(doc, p.id, createAnnotation('signature', { x: 100, y: 700, width: 150, height: 60, image: 'data:,' }));
  rotatePage(doc, p.id, 90); // 842 x 595 now; origin (142, 100), box x 82..142, y 100..250
  const s = p.annotations.find((a) => a.id === sig.id);
  moveAnnotation(doc, s.id, -1000, 0);
  assert.equal(s.x, 60, 'dragged hard left, the box stops at the edge: origin x = box width');
  moveAnnotation(doc, s.id, 0, 1000);
  assert.equal(s.y, 595 - 150, 'dragged hard down, the box (150 tall on screen) stops at the bottom');
  moveAnnotation(doc, s.id, 2000, 0);
  assert.equal(s.x, 842, 'dragged hard right, the origin (its right edge on screen) reaches the edge');
});

test('9. a turned object keeps its turn through copy and paste and Semua Hal.', () => {
  _resetIds();
  const doc = createDoc();
  const src = addSource(doc, createSource({ name: 'a.pdf', bytes: new Uint8Array([1]), numPages: 2 }));
  addPages(doc, [0, 1].map((n) => createPage({ source: src, sourcePageNum: n, width: 595, height: 842 })));
  const [p, q] = doc.pages;
  const sig = addAnnotation(doc, p.id, createAnnotation('signature', { x: 100, y: 700, width: 150, height: 60, image: 'data:,' }));
  const txt = addAnnotation(doc, p.id, createAnnotation('text', { x: 40, y: 20, fontSize: 14, text: 'halo' }));
  rotatePage(doc, p.id, 90);
  const s = p.annotations.find((a) => a.id === sig.id);
  const t = p.annotations.find((a) => a.id === txt.id);
  assert.equal(duplicateAnnotation(doc, p.id, s).turn, 90, 'a pasted signature reads the way its source does');
  assert.equal(duplicateAnnotation(doc, p.id, t).turn, 90, 'a pasted text reads the way its source does');
  const [copy] = copySignatureToAllPages(doc, s.id);
  assert.equal(copy.turn, 90, 'Semua Hal. stamps the same box the same way round');
  assert.equal(copySignatureToAllPages(doc, s.id).length, 0, 'and a second tap still finds it already there');
  assert.ok(q.annotations.includes(copy));
});

test('10. undo of a page turn puts the turn back; redo turns it again', () => {
  const doc = a4();
  const [p] = doc.pages;
  addAnnotation(doc, p.id, createAnnotation('signature', { x: 100, y: 700, width: 150, height: 60, image: 'data:,' }));
  const h = createHistory();
  record(h, doc);
  rotatePage(doc, doc.pages[0].id, 90);
  assert.equal(doc.pages[0].annotations[0].turn, 90, 'VACUITY GUARD: the turn happened');
  undo(h, doc);
  const a = doc.pages[0].annotations[0];
  assert.deepEqual([a.x, a.y, a.turn, doc.pages[0].rotation], [100, 700, undefined, 0]);
  redo(h, doc);
  const b = doc.pages[0].annotations[0];
  assert.deepEqual([b.x, b.y, b.turn, doc.pages[0].rotation], [142, 100, 90, 90]);
});

test('11. only text and signatures carry a turn; a whiteout never does', () => {
  const doc = a4();
  const [p] = doc.pages;
  addAnnotation(doc, p.id, createAnnotation('whiteout', { x: 50, y: 100, width: 200, height: 20 }));
  addAnnotation(doc, p.id, createAnnotation('pageNumber', { x: 290, y: 800, text: '1' }));
  rotatePage(doc, p.id, 90);
  assert.deepEqual(p.annotations.map((a) => a.turn), [undefined, undefined]);
});
