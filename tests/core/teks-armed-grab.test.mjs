/*
 * WITH TEKS ARMED, A PRESS ON TEXT THE PERSON TYPED PICKS IT UP.
 * ============================================================================
 * Feedback 100369 ("after adding text, when I try to move it a new empty box
 * appears instead") and 100463 ("Gabisa geser tulisan"). Teks stays armed while
 * a box is open and after a tap-away opens the next one, and interaction.js
 * rule 2 ("an armed tool beats annotation hits") sent every press on the text
 * just written to onPlace: a new empty box on top of it, never a drag. Browser
 * repro on 242aae8: type Halo, click a blank (Halo commits, Teks armed, a new
 * box opens), drag Halo: one more empty box at the press, Halo unmoved.
 *
 * Only text the person typed is picked up. A Tip-Ex cover and a signature still
 * lose to an armed Teks (the founder's "write ON TOP of that cover" use case),
 * and a Ganti replacement (replaceCoverId) is the page's own words.
 * Same stub DOM as render-turn.test.mjs; the real-browser half is
 * tests/teks-armed-grab.spec.js.
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


const { createInteraction } = await import('../../js/render/interaction.js');
const { renderAnnotationEl } = await import('../../js/render/page-view.js');
const model = await import('../../js/core/model.js');
const ops = await import('../../js/core/operations.js');

// Teks armed, one annotation on the page, a mouse press then a 40px drag on it.
function pressAndDrag(type, props, { tool = 'text', withGrab = true } = {}) {
  model._resetIds();
  const doc = model.createDoc();
  const src = ops.addSource(doc, model.createSource({ name: 'a.pdf', bytes: new Uint8Array([1]), numPages: 1 }));
  ops.addPages(doc, [model.createPage({ source: src, sourcePageNum: 0, width: 595, height: 842, rotation: 0 })]);
  const page = doc.pages[0];
  const anno = ops.addAnnotation(doc, page.id, model.createAnnotation(type, props));
  const stage = node('div');
  const handlers = {};
  stage.addEventListener = (t, f) => { handlers[t] = f; };
  stage.removeEventListener = () => {};
  const view = node('div'); view.className = 'pv-page'; view.dataset.pageId = page.id;
  view.getBoundingClientRect = () => ({ left: 0, top: 0 });
  const el = renderAnnotationEl(anno); el.className = `pv-anno pv-anno-${type}`;
  view.appendChild(el);
  stage.appendChild(view);
  const log = { placed: 0, grabbed: 0 };
  let current = tool;
  const ix = createInteraction({
    stage, getDoc: () => doc, getZoom: () => 1, getTool: () => current, history: null,
    onPlace: () => { log.placed += 1; },
    ...(withGrab ? { onGrabText: () => { log.grabbed += 1; current = 'select'; } } : {}),
  });
  const ev = (type_, x, y) => ({ pointerId: 1, pointerType: 'mouse', button: 0, clientX: x, clientY: y, target: el, type: type_, preventDefault() {} });
  handlers.pointerdown(ev('pointerdown', 10, 10));
  handlers.pointermove(ev('pointermove', 50, 10));
  handlers.pointerup(ev('pointerup', 50, 10));
  ix.destroy();
  return { anno, log, page };
}

const TEXT = { text: 'Halo', x: 100, y: 100, fontSize: 18 };

test('1. KNOWN-POSITIVE: with Pilih, dragging a typed text moves it', () => {
  const { anno } = pressAndDrag('text', TEXT, { tool: 'select' });
  assert.equal(anno.x, 140, 'VACUITY GUARD: the harness drag really moves an object');
});

test('2. Teks armed: a press on typed text drags it and places no box', () => {
  const { anno, log } = pressAndDrag('text', TEXT);
  assert.equal(log.placed, 0, 'a new empty box was placed on top of the text');
  assert.equal(log.grabbed, 1, 'the app was told to close the open box and leave Teks');
  assert.equal(anno.x, 140, 'the text moved with the drag');
});

test('3. known-negative: a Tip-Ex cover and a signature still lose to an armed Teks', () => {
  for (const [type, props] of [
    ['whiteout', { x: 100, y: 100, width: 80, height: 20, color: '#ffffff' }],
    ['signature', { image: 'data:,', x: 100, y: 100, width: 80, height: 30 }],
  ]) {
    const { anno, log } = pressAndDrag(type, props);
    assert.equal(log.placed, 1, `${type}: Teks should still write on top`);
    assert.equal(log.grabbed, 0);
    assert.equal(anno.x, 100, `${type} must not have moved`);
  }
});

test('4. known-negative: a Ganti replacement text is the page\'s own words, an armed Teks still places', () => {
  const { log, anno } = pressAndDrag('text', { ...TEXT, replaceCoverId: 'c1' });
  assert.equal(log.placed, 1);
  assert.equal(anno.x, 100);
});

test('5. wiring: app.js hands the press to closeOpenEditor and leaves Teks', async () => {
  const fs = await import('node:fs');
  const app = fs.readFileSync(new URL('../../js/v2/app.js', import.meta.url), 'utf8')
    .replace(/\/\/.*$/gm, '');
  const m = /onGrabText:\s*\(\)\s*=>\s*\{([^}]*)\}/.exec(app);
  assert.ok(m, 'createInteraction is given an onGrabText');
  assert.match(m[1], /closeOpenEditor\(\)/);
  assert.match(m[1], /setTool\('select'\)/);
});
