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
import { createFormatBar, formatTarget, blurCommitsDraft } from '../../js/v2/format-bar.js';

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
  contains(node) { return node === this || this.children.some((c) => c.contains(node)); }
  blur() {}
  fire(type, extra = {}) { for (const fn of this.listeners[type] || []) fn({ target: this, preventDefault() {}, stopPropagation() {}, ...extra }); }
}
globalThis.document = { createElement: (tag) => new StubEl(tag), createElementNS: (_ns, tag) => new StubEl(tag) };
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
  const done = [];
  const el = new StubEl('div');
  const bar = createFormatBar({
    el, getDoc: () => doc, history: createHistory(),
    getTarget: () => formatTarget({ editingAnno: state.editingAnno, editingEl: state.editingEl, selected: state.selected() }),
    onStyled: () => {},
    onDefaults: (d) => draftRestyles.push({ ...d }),
    onControlDone: () => done.push(true),
  });
  return { doc, satu, bar, el, draftRestyles, done };
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

// ---- the empty draft and the two controls that take focus -------------------------
// THE PROPERTY (bug 2026-10-11): the font <select>, the size field and the
// custom colour input take focus, so reaching for one BLURS the inline editor.
// A blur commits; an EMPTY new draft commits to nothing, which closed the box,
// disarmed Teks and left the previously committed text as the bar's target, so
// the size/font the person chose for the next text landed on the old one.
// blurCommitsDraft is the rule app.js's editor blur listener runs.

test('blurring an EMPTY new draft into the bar keeps it open (no commit)', () => {
  const { el } = scene();
  const size = find(el, 'fb-size')[0];
  assert.equal(blurCommitsDraft({ relatedTarget: size, barEl: el, text: '', hasAnno: false, hasDraft: false }), false);
  const font = find(el, 'fb-font')[0];
  assert.equal(blurCommitsDraft({ relatedTarget: font, barEl: el, text: '', hasAnno: false, hasDraft: false }), false);
});

test('every other blur still commits: no target, outside the bar, typed text, an annotation, a Ganti draft', () => {
  const { el } = scene();
  const size = find(el, 'fb-size')[0];
  const base = { relatedTarget: size, barEl: el, text: '', hasAnno: false, hasDraft: false };
  // null = a browser that does not report where focus went: today's behaviour, never a stranded editor.
  assert.equal(blurCommitsDraft({ ...base, relatedTarget: null }), true);
  assert.equal(blurCommitsDraft({ ...base, relatedTarget: new StubEl('div') }), true);
  // Typed text commits and stays selected, so the control styles the new annotation (the designed contract).
  assert.equal(blurCommitsDraft({ ...base, text: 'Dua' }), true);
  assert.equal(blurCommitsDraft({ ...base, hasAnno: true }), true);
  assert.equal(blurCommitsDraft({ ...base, hasDraft: true }), true);
});

test('size typed + Enter while the empty draft is held styles the draft, not the selected text, and hands focus back', () => {
  const { satu, el, draftRestyles, bar, done } = scene();
  const size = find(el, 'fb-size')[0];
  size.fire('focus');
  size.value = '10';
  size.fire('keydown', { key: 'Enter' });
  assert.equal(satu.fontSize ?? 18, 18, 'the committed text keeps its size');
  assert.equal(draftRestyles.at(-1)?.fontSize, 10, 'the draft is restyled');
  assert.equal(bar.getDefaults().fontSize, 10, 'and the next commit inherits it');
  assert.equal(done.length, 1, 'the bar says the control is done, so app.js refocuses the draft');
});

test('font picked while the empty draft is held styles the draft and hands focus back', () => {
  const { satu, el, draftRestyles, done } = scene();
  const font = find(el, 'fb-font')[0];
  font.value = 'Courier';
  font.fire('change');
  assert.equal(satu.fontFamily ?? 'Helvetica', 'Helvetica');
  assert.equal(draftRestyles.at(-1)?.fontFamily, 'Courier');
  assert.equal(done.length, 1);
});

test('custom colour: a drag tick does not hand focus back, closing the picker does', () => {
  const { satu, el, draftRestyles, done } = scene();
  const custom = find(el, 'fb-color-custom')[0];
  custom.value = '#123456';
  custom.fire('input');
  assert.equal(done.length, 0, 'mid-drag the picker still has focus');
  custom.fire('change');
  assert.equal(done.length, 1);
  assert.equal(satu.color, '#000000');
  assert.equal(draftRestyles.at(-1)?.color, '#123456');
});

// ---- paragraph alignment (his ask 2026-11-12) ---------------------------------------
// THE PROPERTY: rata kiri/tengah/kanan styles the same target every other
// control does (the draft while typing, else the selected text), with one undo
// step; while an Edit PARAGRAPH draft is open it changes that draft's plan and
// nothing in the model (the commit carries it), and only then is justify offered.
const alignBtn = (el, v) => find(el, 'fb-align-btn').find((b) => b.dataset.align === v);

test('rata tengah while typing a new text sets the draft, not the selected committed text', () => {
  const { satu, el, draftRestyles, bar } = scene();
  alignBtn(el, 'center').fire('click');
  assert.equal(satu.align, undefined, 'the committed text must not change');
  assert.equal(draftRestyles.at(-1)?.align, 'center', 'the draft is restyled');
  assert.equal(bar.getDefaults().align, 'center', 'and the next commit inherits it');
  assert.equal(alignBtn(el, 'justify').hidden, true, 'no justify for typed text: it has no fixed width');
});

test('rata kanan on a selected committed text changes it, one undo step', () => {
  const { doc, satu } = scene();
  const history = createHistory();
  const el = new StubEl('div');
  createFormatBar({
    el, getDoc: () => doc, history,
    getTarget: () => formatTarget({ editingAnno: null, editingEl: null, selected: findAnnotation(doc, doc.selection.annotationId).annotation }),
    onStyled: () => {},
  });
  alignBtn(el, 'right').fire('click');
  assert.equal(findAnnotation(doc, satu.id).annotation.align, 'right');
  assert.equal(history.undoStack.length, 1, 'one undo step');
  alignBtn(el, 'right').fire('click');
  assert.equal(history.undoStack.length, 1, 'a second tap on the same alignment is no step');
});

test('an Edit paragraph draft: alignment changes its plan only, justify offered, the rest of the bar hidden', () => {
  const { doc, satu } = scene();
  const plan = { align: 'justify' };
  const restyled = [];
  const el = new StubEl('div');
  const bar = createFormatBar({
    el, getDoc: () => doc, history: createHistory(),
    getTarget: () => formatTarget({ editingAnno: null, editingEl: { draft: true }, selected: satu }),
    getBlockPlan: () => plan,
    onBlockAlign: (a) => restyled.push(a),
    onStyled: () => { throw new Error('the model must not change while the paragraph is a draft'); },
    onDefaults: () => {},
  });
  bar.sync(true);
  assert.equal(el.classList.has('fb-align-only'), true, 'only alignment shows on an edit');
  assert.equal(alignBtn(el, 'justify').hidden, false, 'justify is offered for a paragraph');
  assert.equal(alignBtn(el, 'justify').attrs['aria-pressed'], 'true', 'the paragraph\'s own alignment is shown');
  alignBtn(el, 'center').fire('click');
  assert.equal(plan.align, 'center');
  assert.deepEqual(restyled, ['center']);
  assert.equal(satu.align, undefined, 'the selected text behind the draft is untouched');
  assert.equal(bar.getDefaults().align, 'left', 'a paragraph choice is not sticky for the next Teks');
});

test('a committed paragraph selected afterwards offers no alignment (its lines are baked)', () => {
  const { doc } = scene();
  const para = addAnnotation(doc, doc.pages[0].id, createAnnotation('text', { x: 1, y: 1, text: 'p', block: { align: 'left', lines: [] } }));
  const el = new StubEl('div');
  const bar = createFormatBar({
    el, getDoc: () => doc, history: createHistory(),
    getTarget: () => para, getBlockPlan: () => null, onStyled: () => {},
  });
  bar.sync(true);
  assert.equal(find(el, 'fb-align')[0].hidden, true);
});
