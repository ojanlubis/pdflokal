/*
 * Headless test for the format bar's target rule (js/v2/format-bar.js).
 * Run: npm run test:core
 *
 * THE PROPERTY: while a NEW text is being typed (editor open, no annotation
 * yet), B / I / colour / size and Ctrl+B/I style that DRAFT, not the previously
 * committed text that app.js leaves selected. The bar is driven for real
 * (createFormatBar on a stub DOM); the target comes from formatTarget, the
 * same function app.js passes as getTarget.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDoc, createSource, createPage, createAnnotation, findAnnotation, _resetIds } from '../../js/core/model.js';
import { addSource, addPages, addAnnotation, selectAnnotation } from '../../js/core/operations.js';
import { createHistory } from '../../js/core/history.js';
import { createFormatBar, formatTarget } from '../../js/v2/format-bar.js';

// Just enough DOM for createFormatBar's build + click wiring.
class StubEl {
  constructor(tag) {
    this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {};
    this.style = {}; this.attrs = {}; this.value = ''; this.className = '';
    const set = new Set();
    this.classList = { toggle: (c, on) => (on ? set.add(c) : set.delete(c)), has: (c) => set.has(c) };
  }
  set innerHTML(_v) { this.children = []; }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] || []) fn({ target: this, preventDefault() {}, stopPropagation() {} }); }
}
globalThis.document = { createElement: (tag) => new StubEl(tag) };
const find = (root, cls) => {
  const all = [];
  const walk = (e) => { all.push(e); e.children.forEach(walk); };
  walk(root);
  return all.filter((e) => e.className.split(' ').includes(cls));
};

// Two texts on one page: "Satu" committed and still selected, "Dua" being typed.
function scene() {
  _resetIds();
  const doc = createDoc();
  const src = addSource(doc, createSource({ name: 'a.pdf', bytes: new Uint8Array([1]), numPages: 1 }));
  addPages(doc, [createPage({ source: src, sourcePageNum: 0, width: 595, height: 842 })]);
  const satu = addAnnotation(doc, doc.pages[0].id, createAnnotation('text', { x: 10, y: 20, text: 'Satu', bold: false, color: '#000000' }));
  selectAnnotation(doc, satu.id);

  const state = { editingAnno: null, editingEl: { draft: true }, selected: () => findAnnotation(doc, doc.selection.annotationId)?.annotation || null };
  const draftRestyles = [];
  const el = new StubEl('div');
  const bar = createFormatBar({
    el, getDoc: () => doc, history: createHistory(),
    getTarget: () => formatTarget({ editingAnno: state.editingAnno, editingEl: state.editingEl, selected: state.selected() }),
    onStyled: () => {},
    onDefaults: (d) => draftRestyles.push({ ...d }),
  });
  return { doc, satu, bar, el, draftRestyles };
}

test('B while typing a new text styles the draft, not the selected committed text', () => {
  const { satu, el, draftRestyles, bar } = scene();
  find(el, 'fb-bold')[0].fire('click');
  assert.equal(satu.bold, false, 'the committed text must not change');
  assert.equal(draftRestyles.at(-1)?.bold, true, 'the draft is restyled');
  assert.equal(bar.getDefaults().bold, true, 'and the next commit inherits it');
});

test('Ctrl+B / Ctrl+I (toggleBold/toggleItalic) while typing a new text style the draft', () => {
  const { satu, bar, draftRestyles } = scene();
  bar.toggleBold();
  bar.toggleItalic();
  assert.equal(satu.bold, false);
  assert.equal(satu.italic ?? false, false);
  assert.deepEqual([draftRestyles.at(-1).bold, draftRestyles.at(-1).italic], [true, true]);
});

test('colour swatch while typing a new text styles the draft, not the selected committed text', () => {
  const { satu, el, draftRestyles } = scene();
  find(el, 'fb-color').find((b) => b.dataset.color === '#d33131').fire('click');
  assert.equal(satu.color, '#000000');
  assert.equal(draftRestyles.at(-1).color, '#d33131');
});

test('with no editor open the bar still styles the selected committed text', () => {
  const { doc, satu } = scene();
  const bar = createFormatBar({
    el: new StubEl('div'), getDoc: () => doc, history: createHistory(),
    getTarget: () => formatTarget({ editingAnno: null, editingEl: null, selected: findAnnotation(doc, doc.selection.annotationId).annotation }),
    onStyled: () => {},
  });
  bar.toggleBold();
  assert.equal(satu.bold, true);
});

test('editing an existing annotation styles that annotation', () => {
  const t = { id: 'x' };
  assert.equal(formatTarget({ editingAnno: t, editingEl: {}, selected: { id: 'y' } }), t);
});
