/*
 * EVERY PDF.js DOCUMENT IN THE SESSION SHARES ONE WORKER.
 * ============================================================================
 * pdf.js 3.x spawns a fresh Web Worker (its own isolate, a ~1 MB worker script
 * parsed again) for every getDocument() that is not handed `worker:`. The
 * editor opened documents in seven places and handed none of them a worker, so
 * the open source (rasterizer), the same source again (text-run index), and
 * one single-page document PER EDITED PAGE (cached for the session) each held
 * a worker alive at once; compress's target-size search spun up and tore down
 * one per pass. On a 3-4 GB Android that is memory the tab gets killed for.
 *
 * Part 1 drives the REAL call sites with a stub pdf.js that records the
 * `worker` each getDocument receives. Before the fix every one was undefined.
 * Part 2 runs the REAL vendored pdf.js (fake worker, node) to prove the
 * contract the fix leans on: destroying a document leaves a worker it was
 * handed alive and usable for the next one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function canvasStub() {
  return { width: 0, height: 0, getContext: () => ({ translate() {}, rotate() {}, drawImage() {} }), toDataURL: () => 'data:image/png;base64,AA' };
}
globalThis.document = { createElement: () => canvasStub() };

// ── Part 1: a stub pdf.js that records what each open was handed ──────────
const opened = []; // { site, worker }
let workersMade = 0;
let site = '';
class StubPDFWorker {
  constructor() { workersMade += 1; this.destroyed = false; }
  destroy() { this.destroyed = true; }
}
const stubPage = {
  rotate: 0,
  getViewport: () => ({ width: 10, height: 10, transform: [1, 0, 0, 1, 0, 0], scale: 1 }),
  render: () => ({ promise: Promise.resolve() }),
  getTextContent: async () => ({ items: [], styles: {} }),
  getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
};
const stubLib = {
  OPS: {},
  PDFWorker: StubPDFWorker,
  getDocument(params) {
    opened.push({ site, worker: params.worker });
    return { promise: Promise.resolve({
      numPages: 1,
      getPage: async () => stubPage,
      getMetadata: async () => ({ info: {} }),
      destroy: async () => {},
    }) };
  },
};
globalThis.window = { pdfjsLib: stubLib };

const { importPdf, probeTextLayer, createPageRasterizer } = await import('../../js/core/import.js');
const { createTextRunIndex } = await import('../../js/v2/text-runs.js');
const { compressPdfBytes } = await import('../../js/core/compress.js');
const { renderPdfToImages } = await import('../../js/core/export-images.js');
const { createDoc } = await import('../../js/core/model.js');

// A page carrying one committed Ganti pair, so editSignature(page) is
// non-empty and the rasterizer opens the provider's edited-page bytes.
function addEdit(page) {
  page.annotations = [
    { id: `${page.id}-c`, type: 'whiteout', x: 0, y: 0, width: 10, height: 10,
      replaceTargets: [{ x0: 1, y0: 2, ux: 1, uy: 0, size: 12, len: 50 }], replaceBox: { x: 0, y: 0, w: 10, h: 10 } },
    { id: `${page.id}-t`, type: 'text', text: 'Rapat Baru', replaceCoverId: `${page.id}-c` },
  ];
}

test('every document the editor opens is handed the same pdf.js worker', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const doc = createDoc();

  site = 'importPdf';
  const [page] = await importPdf(doc, { name: 'a.pdf', bytes });

  site = 'probeTextLayer';
  await probeTextLayer(bytes);

  site = 'rasterizer:source';
  const r = createPageRasterizer(doc, { editedPageProvider: async () => ({ bytes: new Uint8Array([4]) }) });
  await r.rasterize(page, { scale: 1 });

  site = 'rasterizer:edited';
  addEdit(page);
  await r.rasterize(page, { scale: 1 });

  site = 'text-runs';
  await createTextRunIndex({ getDoc: () => doc }).getRuns(page.id);

  // compress/export-images take pdf.js by injection; the stub page has no
  // real canvas encoder, so they may fail AFTER opening. The open is the
  // property under test, not the rebuild.
  site = 'compress';
  await compressPdfBytes(bytes, { pdfjsLib: stubLib, PDFLib: { PDFDocument: { create: async () => ({}) } } }).catch(() => {});
  site = 'export-images';
  await renderPdfToImages(bytes, { pdfjsLib: stubLib }).catch(() => {});

  const sites = opened.map((o) => o.site);
  // VACUITY GUARD: each path really reached getDocument, or the assertion
  // below is over a set that is missing the paths it claims to cover.
  for (const s of ['importPdf', 'probeTextLayer', 'rasterizer:source', 'rasterizer:edited', 'text-runs', 'compress', 'export-images']) {
    assert.ok(sites.includes(s), `${s} never opened a document: ${JSON.stringify(sites)}`);
  }
  for (const o of opened) {
    assert.ok(o.worker, `${o.site} opened a document without a worker: pdf.js spawned a new one for it`);
  }
  assert.equal(new Set(opened.map((o) => o.worker)).size, 1, 'documents were handed different workers');
  assert.equal(workersMade, 1, 'more than one PDFWorker was created for the session');
});

// ── Part 2: the real vendored pdf.js keeps a handed-in worker alive ────────
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global', 'define',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis, undefined);
  return module.exports;
};

test('real pdf.js: destroying one document leaves the shared worker serving the next', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  globalThis.pdfjsWorker = loadUmd('js/vendor/pdf.worker.min.js');
  const pdfjs = loadUmd('js/vendor/pdf.min.js');
  const { openPdf, sharedPdfWorker } = await import('../../js/core/pdfjs-open.js');

  const d = await PDFLib.PDFDocument.create();
  d.addPage([200, 100]);
  d.addPage([300, 100]);
  const bytes = await d.save();

  const a = await openPdf(pdfjs, bytes);
  const b = await openPdf(pdfjs, bytes);
  const worker = sharedPdfWorker(pdfjs);
  assert.equal(a.numPages, 2, 'KNOWN-POSITIVE: the real lib opened the file through the helper');
  await a.destroy();
  assert.equal(worker.destroyed, false, 'destroying a document killed the worker every other document shares');
  // The document opened before the destroy still answers on the same worker.
  assert.equal((await b.getPage(2)).getViewport({ scale: 1 }).width, 300);
  // And a document opened after it does too, on the same worker.
  const c = await openPdf(pdfjs, bytes);
  assert.equal(c.numPages, 2);
  assert.equal(sharedPdfWorker(pdfjs), worker, 'a second worker was spawned after a destroy');
  assert.equal(bytes.length > 0 && bytes.buffer.byteLength > 0, true, 'the caller\'s bytes were detached: the copy-on-open rule was lost');
  await b.destroy();
  await c.destroy();
});

// ── Part 3: no new door opens beside the shared one ────────────────────────
// A raw getDocument() in the editor's modules silently brings back a worker
// per document. The old wing (js/lib, js/editor) and the lab pages load their
// own pdf.js and are out of scope.
test('the editor opens PDF.js documents only through core/pdfjs-open.js', () => {
  const offenders = [];
  for (const dir of ['js/core', 'js/v2']) {
    for (const f of fs.readdirSync(path.join(root, dir), { recursive: true })) {
      if (!f.endsWith('.js') || f === 'pdfjs-open.js') continue;
      const src = fs.readFileSync(path.join(root, dir, f), 'utf8');
      if (/\.getDocument\s*\(/.test(src)) offenders.push(`${dir}/${f}`);
    }
  }
  assert.deepEqual(offenders, [], 'open documents with openPdf() so they share the worker');
});
