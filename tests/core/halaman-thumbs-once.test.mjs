/*
 * Halaman thumbnails are rendered ONCE per (page, picture) — js/v2/page-manager.js.
 * ============================================================================
 * THE DEFECT: queueThumb chained an unconditional job per cache miss. Every
 * rebuild of the grid (reorder, delete, undo while the queue was still
 * draining) queued a fresh job for every page whose thumb had not landed yet,
 * so one page was rasterized 2-3x, and the OLD jobs painted tiles that were
 * already detached from the grid. On a long PDF on a phone the new grid stayed
 * blank while the queue re-rendered pages nobody could see. app.js also flushed
 * the whole cache on every undo/redo although the cache key (rasterKey) already
 * covers source page, rotation, width and edits.
 *
 * This drives the REAL createPageManager against a minimal fake DOM; only the
 * rasterizer is a stub (counts calls, 5 ms each). Nothing here is timing-
 * sensitive: assertions are on call counts after the queue has fully drained.
 *
 * RED-ON-REVERT: restore the unconditional `thumbQueue.then(...)` in queueThumb
 * and scenarios 1 and 2 fail on call counts, scenario 3 on a render for a
 * deleted page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

class El {
  constructor(isRoot = false) {
    this.isRoot = isRoot;
    this.children = [];
    this.parent = null;
    this.style = {};
    this.dataset = {};
    this.attrs = {};
    this.className = '';
    this.textContent = '';
    this.hidden = false;
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
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
  addEventListener() {}
  querySelector() { return new El(); }
  focus() {}
}

globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.document = { createElement: () => new El(), activeElement: null };

const { createPageManager } = await import('../../js/v2/page-manager.js');
const { createDoc, createPage, createSource, createAnnotation } = await import('../../js/core/model.js');
const { createHistory, record, undo } = await import('../../js/core/history.js');
const { rotatePage } = await import('../../js/core/operations.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setup(pageCount) {
  const doc = createDoc();
  const source = createSource({ name: 'a.pdf', bytes: new Uint8Array(1), numPages: pageCount });
  doc.sources.push(source);
  for (let i = 0; i < pageCount; i++) {
    doc.pages.push(createPage({ source, sourcePageNum: i, width: 595, height: 842 }));
  }
  const sheet = new El();
  sheet.open = false;
  sheet.showModal = () => { sheet.open = true; };
  sheet.close = () => { sheet.open = false; };
  const grid = new El(true);
  const calls = []; // page ids, in render order
  let active = 0;
  const rasterizer = {
    async rasterizeThumb(page) {
      calls.push(page.id);
      active++;
      await sleep(5);
      active--;
      return { dataUrl: `data:${page.id}:${page.rotation}`, width: 150, height: 200 };
    },
  };
  const history = createHistory();
  const pm = createPageManager({
    sheet, grid, bulkBar: new El(), pickBar: new El(),
    getDoc: () => doc, history,
    getRasterizer: () => rasterizer,
    onDocChanged() {}, onAddFiles() {}, onExtract() {}, toast() {},
  });
  const drain = async () => {
    for (let quiet = 0; quiet < 3;) {
      await sleep(15);
      quiet = active === 0 ? quiet + 1 : 0;
    }
  };
  const tiles = () => grid.children.filter((c) => c.dataset.pageId);
  return { doc, sheet, grid, calls, pm, history, drain, tiles };
}

test('rebuilding the grid while thumbs are still queued renders each page once', async () => {
  const { doc, calls, pm, drain } = setup(30);
  pm.open();
  pm.render(); // reorder / undo while the queue drains
  pm.render();
  await drain();
  assert.equal(new Set(calls).size, 30, 'VACUITY GUARD: every page got a thumb');
  assert.equal(calls.length, 30, 'one render per page, not one per rebuild');
  for (const p of doc.pages) assert.equal(calls.filter((id) => id === p.id).length, 1);
});

test('every tile of the FINAL grid ends up painted (old jobs may not paint detached tiles instead)', async () => {
  const { doc, pm, drain, tiles } = setup(12);
  pm.open();
  pm.render();
  await drain();
  const live = tiles();
  assert.equal(live.length, doc.pages.length);
  for (const t of live) {
    const thumb = t.children[0];
    assert.ok(thumb.isConnected, 'the tile is in the grid');
    assert.match(thumb.style.backgroundImage ?? '', /data:/, `tile ${t.dataset.pageId} is painted`);
  }
});

test('a page deleted while its thumb is queued is never rendered', async () => {
  const { doc, calls, pm, drain } = setup(30);
  pm.open();
  const gone = doc.pages.slice(10, 15).map((p) => p.id);
  pm.deletePages(gone);
  await drain();
  for (const id of gone) assert.equal(calls.includes(id), false, `deleted ${id} must not be rasterized`);
  assert.equal(calls.length, 25, 'only the surviving pages, once each');
});

test('an annotation-only change keeps the cache: close/open renders nothing new', async () => {
  const { doc, sheet, calls, pm, drain } = setup(8);
  pm.open();
  await drain();
  assert.equal(calls.length, 8);
  doc.pages[3].annotations.push(createAnnotation('text', { x: 1, y: 1, text: 'hi' }));
  sheet.close();
  pm.open();
  await drain();
  assert.equal(calls.length, 8, 'annotations are not in the thumb picture, so the cached thumb stands');
});

test('undo of a rotation without any cache flush still shows the restored (unrotated) page', async () => {
  const { doc, calls, pm, history, drain, tiles } = setup(3);
  pm.open();
  await drain();
  const id = doc.pages[1].id;
  pm.rotatePages([id]); // record -> rotate -> thumb for the rotated key
  await drain();
  assert.equal(doc.pages[1].rotation, 90);
  assert.equal(calls.filter((c) => c === id).length, 2, 'KNOWN-POSITIVE: the rotation re-rendered the page');
  // What the app's afterHistoryStep does, MINUS the flush: undo, then render.
  assert.ok(undo(history, doc));
  pm.render();
  await drain();
  assert.equal(doc.pages[1].rotation, 0);
  const t = tiles().find((x) => x.dataset.pageId === id);
  assert.equal(t.children[0].style.backgroundImage, `url(data:${id}:0)`, 'the tile shows the unrotated picture');
});

test('app.js no longer flushes the whole thumb cache on every undo/redo step', () => {
  // The decision lives in app.js wiring that cannot run headless; this pins the
  // one call. rasterKey in the cache entry already decides hit vs miss.
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'js', 'v2', 'app.js'), 'utf8');
  const body = src.match(/function afterHistoryStep\([^)]*\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, 'VACUITY GUARD: afterHistoryStep found');
  assert.equal(/invalidateThumbs/.test(body), false);
  assert.match(src, /function resetDoc[\s\S]*?invalidateThumbs\(\)/, 'Buka Baru still frees the cache');
});
