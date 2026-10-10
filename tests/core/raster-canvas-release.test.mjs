/*
 * A PAGE'S RASTER CANVAS IS GIVEN BACK THE MOMENT IT HAS BEEN ENCODED.
 * ============================================================================
 * rasterize / rasterizeThumb encode a fresh canvas to a data URL and keep only
 * the string, but left the canvas's pixel buffer to the garbage collector.
 * iOS Safari counts every live canvas against one global budget, so a long
 * scroll could leave later pages as grey placeholders. The import path already
 * zeroes its canvas (storableImageBytes); this is the hot path catching up.
 * renderCanvas (OCR) hands the canvas to its caller and must NOT be zeroed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.Blob = globalThis.Blob || class {};
const { createPageRasterizer } = await import('../../js/core/import.js');
const { createDoc, createSource, createPage } = await import('../../js/core/model.js');
const { addSource, addPages } = await import('../../js/core/operations.js');

function fakeCanvas(w, h, { failEncode = false } = {}) {
  return { width: w, height: h, toDataURL() { if (failEncode) throw new Error('encode failed'); return `data:image/png;base64,${this.width}x${this.height}`; } };
}
function oneImagePage() {
  const doc = createDoc();
  const s = addSource(doc, createSource({ name: 'a.png', bytes: new Uint8Array([1]), numPages: 1 }));
  const page = createPage({ source: s, sourcePageNum: 0, width: 595, height: 842, isFromImage: true });
  addPages(doc, [page]);
  return { doc, page };
}

test('rasterize zeroes the canvas after encoding but reports its real size', async () => {
  const { doc, page } = oneImagePage();
  const c = fakeCanvas(1190, 1684);
  const r = createPageRasterizer(doc, { renderToCanvas: async () => c });
  const raster = await r.rasterize(page, { scale: 2 });
  assert.equal(raster.width, 1190, 'VACUITY GUARD: the recorded size is the encoded size, not the zeroed one');
  assert.equal(raster.height, 1684);
  assert.equal(raster.dataUrl, 'data:image/png;base64,1190x1684', 'encoded before it was zeroed');
  assert.equal(c.width, 0, 'canvas backing store released');
  assert.equal(c.height, 0);
});

test('rasterizeThumb zeroes the canvas and returns the encoded size', async () => {
  const { doc, page } = oneImagePage();
  const c = fakeCanvas(150, 212);
  const r = createPageRasterizer(doc, { renderToCanvas: async () => c });
  const t = await r.rasterizeThumb(page, { width: 150 });
  assert.deepEqual([t.width, t.height], [150, 212]);
  assert.equal(t.dataUrl, 'data:image/png;base64,150x212');
  assert.equal(c.width, 0);
});

test('a stale render that is discarded still releases its canvas', async () => {
  const { doc, page } = oneImagePage();
  const stale = fakeCanvas(100, 100);
  const fresh = fakeCanvas(200, 200);
  let release;
  const gate = new Promise((res) => { release = res; });
  let n = 0;
  const r = createPageRasterizer(doc, { renderToCanvas: async () => { n += 1; if (n === 1) { await gate; return stale; } return fresh; } });
  const first = r.rasterize(page, { scale: 1 });
  await r.rasterize(page, { scale: 1 });
  release();
  await first;
  assert.equal(page.raster.width, 200, 'last-issued wins (stale guard intact)');
  assert.equal(stale.width, 0, 'the discarded canvas is released too');
});

test('a canvas that fails to encode is still released', async () => {
  const { doc, page } = oneImagePage();
  const c = fakeCanvas(300, 300, { failEncode: true });
  const r = createPageRasterizer(doc, { renderToCanvas: async () => c });
  await assert.rejects(r.rasterize(page, { scale: 1 }), /encode failed/);
  assert.equal(c.width, 0);
});

test('renderCanvas (OCR) hands the live canvas over untouched', async () => {
  const { doc, page } = oneImagePage();
  const c = fakeCanvas(800, 1000);
  const r = createPageRasterizer(doc, { renderToCanvas: async () => c });
  const got = await r.renderCanvas(page, { scale: 2 });
  assert.equal(got.width, 800, 'the caller still owns pixels');
});
