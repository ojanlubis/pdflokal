/*
 * ONE FAILED DECODE IS NOT A LIFE SENTENCE FOR THE PAGE.
 * ============================================================================
 * The rasterizer caches a PROMISE per source (the decoded image, the PDF.js
 * document). A promise that rejected once stayed cached for the session, so
 * a transient failure (pdf.js not arriving on a flaky link, a decode hiccup)
 * meant that page never rendered again until Buka Baru. Driven with stub
 * decoders that fail once, then work.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

function canvasStub() {
  return { width: 0, height: 0, getContext: () => ({ translate() {}, rotate() {}, drawImage() {} }), toDataURL: () => 'data:image/png;base64,AA' };
}
globalThis.document = { createElement: () => canvasStub() };
globalThis.Blob = globalThis.Blob || class {};

const { createPageRasterizer } = await import('../../js/core/import.js');
const { createDoc, createSource, createPage } = await import('../../js/core/model.js');
const { addSource, addPages } = await import('../../js/core/operations.js');

test('an image whose first decode fails renders on the next attempt', async () => {
  let calls = 0;
  globalThis.window = {
    createImageBitmap: async () => { calls += 1; if (calls === 1) throw new Error('decode hiccup'); return { width: 10, height: 10 }; },
  };
  const doc = createDoc();
  const src = addSource(doc, createSource({ name: 'a.png', bytes: new Uint8Array([1]), numPages: 1 }));
  const [page] = [createPage({ source: src, sourcePageNum: 0, width: 10, height: 10, isFromImage: true })];
  addPages(doc, [page]);
  const r = createPageRasterizer(doc);
  await assert.rejects(r.rasterize(page, { scale: 1 }), /hiccup/, 'known-positive: the first decode must really fail');
  const raster = await r.rasterize(page, { scale: 1 });
  assert.ok(raster && raster.dataUrl, 'the failed decode was cached: the page can never render again');
  assert.equal(calls, 2);
});

test('a PDF whose document load fails once renders on the next attempt', async () => {
  let calls = 0;
  const pdfPage = { getViewport: () => ({ width: 10, height: 10 }), render: () => ({ promise: Promise.resolve() }) };
  globalThis.window = {
    pdfjsLib: {
      getDocument: () => { calls += 1; return { promise: calls === 1 ? Promise.reject(new Error('worker gone')) : Promise.resolve({ getPage: async () => pdfPage }) }; },
    },
  };
  const doc = createDoc();
  const src = addSource(doc, createSource({ name: 'a.pdf', bytes: new Uint8Array([1]), numPages: 1 }));
  const page = createPage({ source: src, sourcePageNum: 0, width: 10, height: 10 });
  addPages(doc, [page]);
  const r = createPageRasterizer(doc);
  await assert.rejects(r.rasterize(page, { scale: 1 }), /worker gone/);
  const raster = await r.rasterize(page, { scale: 1 });
  assert.ok(raster && raster.dataUrl, 'the failed load was cached');
  assert.equal(calls, 2);
});
