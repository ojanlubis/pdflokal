// The one door every PDF.js document in the editor opens through.
//
// WHY one shared worker: pdf.js 3.x spawns a brand-new Web Worker (its own JS
// isolate, the ~1 MB worker script parsed again) for every getDocument() that
// is not handed `worker:`. The editor keeps several documents open at once:
// the source for the rasterizer, the same source for the text-run index, and
// one single-page document per edited page, cached for the session. Each held
// its own worker, and on a 3-4 GB Android that is memory the tab gets killed
// for when the user switches to WhatsApp. One worker serves them all.
//
// WHY destroying a document is still safe: pdf.js only destroys a worker it
// created itself (loadingTask._worker is set only when none was passed), so
// doc.destroy() frees that document's state in the worker and leaves the worker
// running for the others. tests/core/pdfjs-shared-worker.test.mjs proves it on
// the vendored build.
//
// Keyed by the lib object, not a module-level singleton: compress.js and
// export-images.js take pdf.js by injection, and a test's stub lib must never
// be handed the real lib's worker (or the reverse).
const workers = new WeakMap();

export function sharedPdfWorker(pdfjsLib) {
  // A stand-in lib without PDFWorker (older test stubs) falls back to pdf.js's
  // own per-document worker, i.e. the old behaviour, rather than throwing.
  if (typeof pdfjsLib.PDFWorker !== 'function') return undefined;
  let worker = workers.get(pdfjsLib);
  // getDocument() refuses a destroyed worker outright; replace it instead of
  // failing every open for the rest of the session.
  if (!worker || worker.destroyed) {
    worker = new pdfjsLib.PDFWorker();
    workers.set(pdfjsLib, worker);
  }
  return worker;
}

// Open `bytes` as a PDF.js document on the shared worker.
// WHY the copy: PDF.js transfers (detaches) the buffer it is handed, and every
// caller keeps its bytes (the Source, compress's honesty guard, the export).
export function openPdf(pdfjsLib, bytes) {
  const data = typeof bytes.slice === 'function' ? bytes.slice() : Uint8Array.from(bytes);
  return pdfjsLib.getDocument({ data, worker: sharedPdfWorker(pdfjsLib) }).promise;
}
