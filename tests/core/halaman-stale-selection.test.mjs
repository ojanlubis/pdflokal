/*
 * Halaman keeps no selection from a document that is gone — js/v2/page-manager.js.
 * ============================================================================
 * THE DEFECT: "Ganti" by drop (or Buka Baru) with the Halaman sheet open left
 * `selected` holding the OLD document's page ids. The bar still said "2 dipilih",
 * and Ekstrak filtered the NEW document's pages by those ids -> [] -> a 0-page
 * PDF downloaded with a success toast.
 *
 * Two fences, each guarded alone so neither can hide the other going missing:
 *   1. invalidateThumbs() (the "this document is GONE" hook) drops the selection;
 *   2. a bulk action whose filtered pages are empty does nothing.
 *
 * Drives the REAL createPageManager against a minimal fake DOM, like
 * halaman-thumbs-once.test.mjs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

class El {
  constructor(isRoot = false) {
    this.isRoot = isRoot;
    this.children = [];
    this.parent = null;
    this.style = {};
    this.dataset = {};
    this.attrs = {};
    this.handlers = {};
    this.className = '';
    this.textContent = '';
    this.hidden = false;
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    this.found = new Map();
  }
  get isConnected() {
    let n = this;
    while (n.parent) n = n.parent;
    return n.isRoot === true;
  }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  append(...xs) { for (const x of xs) if (typeof x !== 'string') this.appendChild(x); }
  set innerHTML(_v) { for (const c of this.children) c.parent = null; this.children = []; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
  // Same element for the same selector, so a test can read what the bar wrote.
  querySelector(sel) {
    if (!this.found.has(sel)) this.found.set(sel, new El());
    return this.found.get(sel);
  }
  focus() {}
}

globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.document = { createElement: () => new El(), activeElement: null };

const { createPageManager } = await import('../../js/v2/page-manager.js');
const { createDoc, createPage, createSource } = await import('../../js/core/model.js');
const { createHistory } = await import('../../js/core/history.js');

function pagesOf(doc, count, name) {
  const source = createSource({ name, bytes: new Uint8Array(1), numPages: count });
  doc.sources.push(source);
  for (let i = 0; i < count; i++) doc.pages.push(createPage({ source, sourcePageNum: i, width: 595, height: 842 }));
}

function setup() {
  const doc = createDoc();
  pagesOf(doc, 3, 'old.pdf');
  const sheet = new El();
  sheet.open = false;
  sheet.showModal = () => { sheet.open = true; };
  sheet.close = () => { sheet.open = false; };
  const grid = new El(true);
  const bulkBar = new El();
  const extracted = [];
  const pm = createPageManager({
    sheet, grid, bulkBar, pickBar: new El(),
    getDoc: () => doc, history: createHistory(),
    getRasterizer: () => ({ rasterizeThumb: async () => ({ dataUrl: 'data:x', width: 1, height: 1 }) }),
    onDocChanged() {}, onAddFiles() {}, onExtract: (pages) => extracted.push(pages), toast() {},
  });
  const tiles = () => grid.children.filter((c) => c.dataset.pageId);
  const pick = (i) => tiles()[i].handlers.keydown[0]({ key: 'Enter', preventDefault() {} });
  const press = (act) => {
    const btn = { dataset: { act }, getAttribute: () => null };
    bulkBar.handlers.click[0]({ target: { closest: () => btn } });
  };
  // What resetDoc does to the model: the old pages are gone, new ones arrive.
  const replaceDoc = () => { doc.pages.length = 0; pagesOf(doc, 3, 'new.pdf'); };
  return { doc, pm, bulkBar, extracted, pick, press, replaceDoc };
}

test('KNOWN-POSITIVE: selecting pages enables Ekstrak and hands them over', () => {
  const { pm, pick, press, extracted, bulkBar } = setup();
  pm.open();
  pick(0); pick(1);
  assert.match(bulkBar.querySelector('.pm-count').textContent, /2/);
  press('extract');
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].length, 2);
});

test('a document replaced under an open sheet leaves no selection behind', () => {
  const { pm, pick, replaceDoc, bulkBar } = setup();
  pm.open();
  pick(0); pick(1);
  replaceDoc();
  pm.invalidateThumbs(); // what resetDoc calls
  pm.render();           // what loadFilesInner calls when the sheet is open
  assert.doesNotMatch(bulkBar.querySelector('.pm-count').textContent, /2/, 'the bar must not still say two are chosen');
  assert.match(bulkBar.querySelector('.pm-count').textContent, /0/);
});

test('Ekstrak with only stale page ids downloads nothing', () => {
  const { pm, pick, replaceDoc, press, extracted } = setup();
  pm.open();
  pick(0); pick(1);
  replaceDoc(); // no invalidate: the second fence alone must hold
  press('extract');
  assert.equal(extracted.length, 0, 'a 0-page file must never be produced');
});
