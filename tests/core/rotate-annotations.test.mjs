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
