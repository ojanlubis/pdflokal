/*
 * TEXT AND OCR LINE CACHES NEVER ANSWER IN A FRAME THE PAGE NO LONGER HAS.
 * ============================================================================
 * Line boxes are display coordinates. The page manager invalidated both caches
 * when it rotated a page, but undo/redo restores the rotation (or a merge's
 * rescale) without telling anyone: rotate → tap Ganti (caches the turned frame)
 * → Ctrl+Z, and the next Hapus/Ganti tap resolved against sideways boxes,
 * landing on the wrong printed line or none (round-3 hunt, 2026-10-10).
 * The caches now check core/page-rotation.js displayFrameKey on every read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDoc, createSource, createPage } from '../../js/core/model.js';
import { addSource, addPages, rotatePage } from '../../js/core/operations.js';
import { createHistory, record, undo } from '../../js/core/history.js';

let textContentCalls = 0;
let ocrScale = 1;
globalThis.window = {
  // One recognised line near the top-RIGHT of the turned 842x595 frame.
  Tesseract: { createWorker: async () => ({
    recognize: async () => ({ data: { lines: [{ text: 'Nomor Surat 123', confidence: 90,
      bbox: { x0: 700 * ocrScale, y0: 20 * ocrScale, x1: 820 * ocrScale, y1: 40 * ocrScale } }] } }),
    terminate: async () => {},
  }) },
  // pdf.js stand-in: counts extractions. An empty text layer is a valid answer.
  pdfjsLib: {
    getDocument: () => ({ promise: Promise.resolve({
      getPage: async () => ({
        getViewport: () => ({ transform: [1, 0, 0, 1, 0, 0], scale: 1 }),
        getTextContent: async () => { textContentCalls += 1; return { items: [], styles: {} }; },
      }),
      destroy: async () => {},
    }) }),
  },
};
const { createOcrIndex } = await import('../../js/v2/ocr-runs.js');
const { createTextRunIndex } = await import('../../js/v2/text-runs.js');

function scanDoc() {
  const doc = createDoc();
  const src = addSource(doc, createSource({ name: 'scan.pdf', bytes: new Uint8Array(1), numPages: 1 }));
  addPages(doc, [createPage({ source: src, sourcePageNum: 0, width: 595, height: 842 })]);
  return doc;
}

test('OCR: lines recognised in a turned frame are not served after undo restores the page', async () => {
  const doc = scanDoc();
  const [page] = doc.pages;
  const hist = createHistory();
  const idx = createOcrIndex({ getDoc: () => doc, rasterizer: { renderCanvas: async (_p, o) => { ocrScale = o.scale; return {}; } } });
  // page-manager.rotatePages: record → rotate → invalidateAll
  record(hist, doc);
  rotatePage(doc, page.id, 90);
  idx.invalidateAll();
  await idx.run(page.id);
  assert.ok(idx.hitTest(page.id, 760, 30), 'KNOWN-POSITIVE: in the turned frame the tap hits the line');

  undo(hist, doc); // what doUndo does: no cache is told
  const p = doc.pages[0];
  assert.equal(p.rotation, 0, 'VACUITY GUARD: the undo really restored the upright page');
  assert.equal(idx.hitTest(p.id, 760, 30), null, 'x=760 is off a 595-wide page and must hit nothing');
  assert.equal(idx.hasLines(p.id), false, 'the turned-frame lines are gone; the next tap asks again');
});

test('OCR: an unchanged frame keeps its lines (recognition is seconds, never re-spent for nothing)', async () => {
  const doc = scanDoc();
  const [page] = doc.pages;
  const idx = createOcrIndex({ getDoc: () => doc, rasterizer: { renderCanvas: async (_p, o) => { ocrScale = o.scale; return {}; } } });
  await idx.run(page.id);
  assert.equal(idx.hasLines(page.id), true);
  assert.equal(idx.hasLines(page.id), true, 'a second read is still a hit');
});

test('text runs: a frame change re-extracts; the same frame reuses the cache', async () => {
  const doc = scanDoc();
  const [page] = doc.pages;
  const hist = createHistory();
  const runs = createTextRunIndex({ getDoc: () => doc });
  await runs.getLines(page.id);
  await runs.getLines(page.id);
  assert.equal(textContentCalls, 1, 'KNOWN-POSITIVE: same frame, one extraction');

  record(hist, doc);
  rotatePage(doc, page.id, 90);
  runs.invalidateAll(); // the page manager's own invalidation
  await runs.getLines(page.id);
  assert.equal(textContentCalls, 2);

  undo(hist, doc); // nobody invalidates
  await runs.getLines(doc.pages[0].id);
  assert.equal(textContentCalls, 3, 'the upright frame was extracted again, not served from the turned one');
});
