/*
 * ROTATING A PAGE KEEPS ITS ANNOTATIONS ON THE PAGE, OVER THEIR CONTENT.
 * ============================================================================
 * Annotation geometry lives in the page's DISPLAYED (rotated) frame. rotatePage
 * used to change only page.rotation, so an A4 portrait page (595x842) with a
 * signature at y=700 became an 842x595 frame with the signature below the
 * bottom edge: off the page on screen and off the MediaBox in the file.
 *
 * The rule (2026-10-10, a behaviour call for the seat to judge): a Tip-Ex box
 * or an edit cover turns WITH the content it covers (its rect rotates, width
 * and height swap); a signature or text keeps reading upright and moves with
 * the spot it marked (its centre follows the content), clamped inside the page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDoc, createSource, createPage, createAnnotation, _resetIds } from '../../js/core/model.js';
import { addSource, addPages, addAnnotation, rotatePage } from '../../js/core/operations.js';

function a4() {
  _resetIds();
  const doc = createDoc();
  const src = addSource(doc, createSource({ name: 'a.pdf', bytes: new Uint8Array([1]), numPages: 1 }));
  addPages(doc, [createPage({ source: src, sourcePageNum: 0, width: 595, height: 842 })]);
  return doc;
}
const display = (p) => (p.rotation % 180 ? { w: p.height, h: p.width } : { w: p.width, h: p.height });
const inside = (a, d) => a.x >= -1e-9 && a.y >= -1e-9 && a.x + (a.width || 0) <= d.w + 1e-9 && a.y + (a.height || 0) <= d.h + 1e-9;

test('1. a signature near the bottom stays on the page, upright, at its content spot', () => {
  const doc = a4();
  const [p] = doc.pages;
  const sig = addAnnotation(doc, p.id, createAnnotation('signature', { x: 100, y: 700, width: 150, height: 60, image: 'data:,' }));
  // Known-positive: in the NEW frame the old numbers really are off the page.
  assert.ok(700 + 60 > 595);
  rotatePage(doc, p.id, 90);
  const s = p.annotations.find((a) => a.id === sig.id);
  const d = display(p);
  assert.ok(inside(s, d), `signature ${JSON.stringify(s)} is off the ${d.w}x${d.h} page`);
  assert.equal(s.width, 150, 'a signature keeps reading upright: its size does not swap');
  // Clockwise: the old centre (175, 730) lands at (842 - 730, 175) = (112, 175).
  assert.ok(Math.abs(s.x + 75 - 112) < 1e-9 && Math.abs(s.y + 30 - 175) < 1e-9, 'it left the content it marked');
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
  for (let i = 0; i < 4; i += 1) rotatePage(doc, p.id, 90);
  const get = (id) => p.annotations.find((a) => a.id === id);
  assert.deepEqual([get(w.id).x, get(w.id).y, get(w.id).width, get(w.id).height], [50, 100, 200, 20]);
  assert.ok(Math.abs(get(t.id).x - 300) < 1e-9 && Math.abs(get(t.id).y - 400) < 1e-9);
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

test('5. text with no stored width/height stays on the page after a turn', () => {
  const doc = a4();
  const [p] = doc.pages;
  // v2 text annotations carry no width/height: the view sizes them from the text.
  const t = addAnnotation(doc, p.id, createAnnotation('text', { x: 40, y: 20, fontSize: 14, text: 'Nomor: 123/ABC/2026' }));
  assert.equal(t.width, undefined, 'VACUITY GUARD: the case under test has no stored size');
  rotatePage(doc, p.id, 90);
  const r = p.annotations.find((a) => a.id === t.id);
  const d = display(p);
  // ~19 chars at 14pt is well over 100pt wide: its left edge must leave room.
  assert.ok(r.x + 100 <= d.w, `text starts at x=${r.x} on a ${d.w}-wide page: it runs off the right edge`);
  assert.equal(r.width, undefined, 'no size is invented onto the stored annotation');
});

test('6. a -90 turn is ONE counter-clockwise turn, clamped once, not three clamped clockwise ones', () => {
  const doc = a4();
  const [p] = doc.pages;
  const s = addAnnotation(doc, p.id, createAnnotation('signature', { x: 10, y: 10, width: 580, height: 100, image: 'data:,' }));
  rotatePage(doc, p.id, -90);
  const r = p.annotations.find((a) => a.id === s.id);
  // Counter-clockwise, the centre (300, 60) lands at (60, 595 - 300) = (60, 295):
  // x = 60 - 290 clamps to 0, y = 295 - 50 = 245.
  assert.deepEqual([r.x, r.y], [0, 245]);
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
