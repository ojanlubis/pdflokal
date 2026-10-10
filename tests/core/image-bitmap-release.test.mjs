/*
 * DECODED PHOTOS DO NOT PILE UP IN MEMORY.
 * ============================================================================
 * The rasterizer cached every image source's full-resolution ImageBitmap until
 * Buka Baru. A 12 MP photo is ~46 MB decoded; scrolling through 30 of them
 * kept ~1.4 GB resident whatever the viewport released. Now at most IMG_KEEP
 * stay decoded, and a bitmap a render is still drawing from is never closed
 * under it (closing mid-draw throws InvalidStateError). Round-3 hunt, 2026-10-10.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

let open = 0;
let decoded = 0;
const draws = [];
globalThis.window = {
  createImageBitmap: async () => {
    open += 1; decoded += 1;
    const b = { width: 4032, height: 3024, closed: false, close() { if (!b.closed) { b.closed = true; open -= 1; } } };
    return b;
  },
};
globalThis.document = { createElement: () => ({
  width: 0, height: 0, toDataURL: () => 'data:image/png;base64,AAAA',
  getContext: () => ({ translate() {}, rotate() {}, drawImage(b) { draws.push(b); if (b.closed) throw new Error('InvalidStateError: drew a closed bitmap'); } }),
}) };
globalThis.Blob = globalThis.Blob || class {};

const { createDoc, createSource, createPage } = await import('../../js/core/model.js');
const { addSource, addPages } = await import('../../js/core/operations.js');
const { createPageRasterizer } = await import('../../js/core/import.js');

function photos(n) {
  const doc = createDoc();
  for (let i = 0; i < n; i += 1) {
    const s = addSource(doc, createSource({ name: `p${i}.jpg`, bytes: new Uint8Array(10), numPages: 1 }));
    addPages(doc, [createPage({ source: s, sourcePageNum: 0, width: 4032, height: 3024, isFromImage: true })]);
  }
  return doc;
}

test('scrolling through 30 photos keeps at most two decoded', async () => {
  open = 0; decoded = 0; draws.length = 0;
  const doc = photos(30);
  const r = createPageRasterizer(doc);
  for (const p of doc.pages) { await r.rasterize(p, { scale: 1 }); p.raster = null; }
  assert.equal(decoded, 30, 'VACUITY GUARD: every photo was really decoded');
  assert.equal(draws.length, 30, 'and drawn');
  await new Promise((res) => setImmediate(res)); // closes run on the settled promise
  assert.ok(open <= 2, `${open} decoded bitmaps still open`);
  await r.destroy();
  await new Promise((res) => setImmediate(res));
  assert.equal(open, 0, 'Buka Baru releases the rest');
});

test('the page in view and its neighbour are reused, not re-decoded', async () => {
  open = 0; decoded = 0;
  const doc = photos(2);
  const r = createPageRasterizer(doc);
  for (let i = 0; i < 3; i += 1) for (const p of doc.pages) { await r.rasterize(p, { scale: 1 }); p.raster = null; }
  assert.equal(decoded, 2);
});

// What this proves: a render whose bitmap is evicted while it waits still
// finishes, and the evicted bitmap is released afterwards. What it does NOT
// prove: the ref-count itself. Drawing runs synchronously right after the
// bitmap resolves, so the close-before-draw window is microtask-narrow and a
// "close on evict regardless of users" mutation stays green here; the
// ref-count is defence in depth for that window.
test('a render whose bitmap is evicted mid-wait still finishes, and the bitmap is released after', async () => {
  open = 0; decoded = 0; draws.length = 0;
  const doc = photos(4);
  const [a, b, c] = doc.pages;
  // Hold A's render open: its drawImage is reached only after we let it go.
  let release;
  const gate = new Promise((res) => { release = res; });
  const realCreate = globalThis.window.createImageBitmap;
  let first = true;
  globalThis.window.createImageBitmap = async () => {
    const bmp = await realCreate();
    if (first) { first = false; await gate; }
    return bmp;
  };
  const r = createPageRasterizer(doc);
  const slow = r.rasterize(a, { scale: 1 });
  await new Promise((res) => setImmediate(res));
  await r.rasterize(b, { scale: 1 });
  await r.rasterize(c, { scale: 1 }); // evicts A while its render is still waiting
  release();
  // The canvas stub's drawImage THROWS on a closed bitmap, so finishing at all
  // is the proof it drew an open one.
  const raster = await slow;
  assert.ok(raster?.dataUrl, 'the slow render finished');
  assert.ok(draws.length >= 3, 'VACUITY GUARD: all three renders drew');
  await new Promise((res) => setImmediate(res));
  assert.ok(open <= 2, `${open} open after the evicted render finished`);
  globalThis.window.createImageBitmap = realCreate;
});
