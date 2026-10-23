/*
 * A TURNED TEXT OR SIGNATURE IS DRAWN TURNED, AND STAYS A WORKING OBJECT.
 * ============================================================================
 * Founder ruling 2026-10-11 ("semua harus ngikut rotasi"): a page turn turns
 * every object on it. The model carries a quarter `turn` and moves the
 * object's ORIGIN as a point (core/annotation-geometry.js turnAnnotation); the
 * screen must rotate the element about exactly that origin, or the word on
 * screen and the word in the file (core/export.js objectPoint) part ways.
 *
 * Driven against the real render code (render/page-view.js,
 * render/interaction.js, core/edit-hit.js) with a stub DOM just big enough for
 * them, like swap-raster-race.test.mjs. The browser half (that CSS really
 * paints it there) is tests/rotate-everything.spec.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

function node(tag) {
  const n = {
    tag, className: '', style: {}, dataset: {}, children: [], parent: null, textContent: '',
    classList: {
      set: new Set(),
      add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); },
    },
    appendChild(c) { c.parent = n; n.children.push(c); return c; },
    contains(c) { for (let p = c; p; p = p.parent) if (p === n) return true; return false; },
    querySelector(sel) {
      const want = sel.replace(/^\./, '');
      const walk = (x) => {
        for (const c of x.children) {
          if (c.tag === want || c.className.split(' ').includes(want)) return c;
          const d = walk(c);
          if (d) return d;
        }
        return null;
      };
      return walk(n);
    },
    closest(sel) {
      const want = sel.replace(/^\./, '');
      for (let p = n; p; p = p.parent) if (p.className.split(' ').includes(want)) return p;
      return null;
    },
    setPointerCapture() {},
    get offsetWidth() { return 150; },
  };
  return n;
}
globalThis.document = { createElement: node };

const { renderAnnotationEl } = await import('../../js/render/page-view.js');
const { createInteraction } = await import('../../js/render/interaction.js');
const { hitTestEditedLine } = await import('../../js/core/edit-hit.js');
const model = await import('../../js/core/model.js');
const ops = await import('../../js/core/operations.js');

const TEXT = { id: 't', type: 'text', text: 'Disetujui', x: 822, y: 40, fontSize: 18 };
const SIG = { id: 's', type: 'signature', image: 'data:,', x: 142, y: 100, width: 150, height: 60 };

test('1. a turned plain text rotates about its text origin, inside the 10px padding ring', () => {
  const el = renderAnnotationEl({ ...TEXT, turn: 90 });
  assert.equal(el.style.transform, 'rotate(90deg)');
  assert.equal(el.style.transformOrigin, '10px 10px', 'the padding ring puts x/y 10px in from the box corner');
  assert.equal(el.dataset.turn, '90');
});

test('2. a turned signature and a turned paragraph rotate about their box corner', () => {
  const sig = renderAnnotationEl({ ...SIG, turn: 270 });
  assert.equal(sig.style.transform, 'rotate(270deg)');
  assert.equal(sig.style.transformOrigin, '0 0');
  const block = renderAnnotationEl({
    ...TEXT, turn: 180, block: { k: 1, leading: 14, width: 200, align: 'left', lines: [{ text: 'a' }, { text: 'b' }] },
  });
  assert.equal(block.style.transform, 'rotate(180deg)');
  assert.equal(block.style.transformOrigin, '0 0');
});

test('3. known-negative: an unturned object carries no transform at all', () => {
  for (const a of [TEXT, SIG]) {
    const el = renderAnnotationEl(a);
    assert.ok(!el.style.transform, `${a.type} got a transform it never asked for`);
    assert.equal(el.dataset.turn, undefined);
  }
});

function resizeDrag(sigProps, { dx, dy }) {
  model._resetIds();
  const doc = model.createDoc();
  const src = ops.addSource(doc, model.createSource({ name: 'a.pdf', bytes: new Uint8Array([1]), numPages: 1 }));
  ops.addPages(doc, [model.createPage({ source: src, sourcePageNum: 0, width: 595, height: 842, rotation: 90 })]);
  const page = doc.pages[0];
  const anno = ops.addAnnotation(doc, page.id, model.createAnnotation('signature', sigProps));
  const stage = node('div');
  const handlers = {};
  stage.addEventListener = (t, f) => { handlers[t] = f; };
  stage.removeEventListener = () => {};
  const view = node('div'); view.className = 'pv-page'; view.dataset.pageId = page.id;
  const el = renderAnnotationEl(anno); el.className = 'pv-anno pv-anno-signature';
  view.appendChild(el);
  const ix = createInteraction({ stage, getDoc: () => doc, getZoom: () => 1, getTool: () => 'select', history: null });
  ix.setSelected(el, anno);
  const handle = el.querySelector('.pv-handle');
  assert.ok(handle, 'VACUITY GUARD: the selected signature has its resize handle');
  const ev = (x, y) => ({ pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y, target: handle, type: 'pointermove', preventDefault() {} });
  handlers.pointerdown(ev(0, 0));
  handlers.pointermove(ev(dx, dy));
  return anno;
}

test('4. resizing a turned signature reads the drag in its own frame: dragging its handle outward grows it', () => {
  // Turned 90, its own bottom-right corner (the handle) sits bottom-LEFT on
  // screen and its own width runs DOWN: a 30px drag down is 30 of width.
  const turned = resizeDrag({ image: 'data:,', x: 142, y: 100, width: 150, height: 60, turn: 90 }, { dx: 0, dy: 30 });
  assert.equal(turned.width, 180);
  assert.equal(turned.height, 72, 'aspect kept');
  // Known-negative: unturned, the same drag down is not width at all.
  const upright = resizeDrag({ image: 'data:,', x: 142, y: 100, width: 150, height: 60 }, { dx: 0, dy: 30 });
  assert.equal(upright.width, 150);
});

test('5. a turned Ganti replacement\'s painted overflow is still a tap target (it runs down, not right)', () => {
  // Cover's birth box, already turned with the page: a 14-wide, 80-tall strip.
  const cover = { id: 'c1', type: 'whiteout', x: 600, y: 100, width: 14, height: 80, replaceTargets: [{}], replaceBox: { x: 600, y: 100, w: 14, h: 80 } };
  const replacement = { id: 'r1', type: 'text', x: 614, y: 100, fontSize: 12, text: 'jauh lebih panjang', replaceCoverId: 'c1', turn: 90 };
  const page = { annotations: [cover, replacement] };
  const measure = () => 240; // painted 240 along its own reading direction: y 100..340 on screen
  const opts = { measure, minHit: 22 };
  assert.equal(hitTestEditedLine(page, 607, 300, opts)?.cover, cover, 'the overflow below the birth box reopens the edit');
  assert.equal(hitTestEditedLine(page, 800, 107, opts), null, 'and nothing to the RIGHT of it does: that is the unturned extent');
});
