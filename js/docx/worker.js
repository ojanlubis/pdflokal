/*
 * PDFLokal — docx/worker.js  (THE CONVERTER'S WEB WORKER; a CLASSIC worker on purpose)
 * ============================================================================
 * Runs docx/stream.js off the main thread, so the page stays alive while a 300-page
 * PDF turns into a .docx. Spawned by docx/client.js, one worker per conversion,
 * terminated when it is done or cancelled (so its memory goes back to the OS).
 *
 * WHY CLASSIC, NOT { type: 'module' }: pdf.js and fflate ship as UMD files and a
 * module worker has no importScripts. A classic worker can importScripts() them and
 * still import() the ES modules (Chromium, Safari 15+, Firefox 114+; an older engine
 * answers { type: 'init-error' } and the client falls back to the main thread).
 *
 * pdf.js starts its OWN worker from here (a nested worker; workerSrc below). Where
 * the engine cannot nest workers the same init-error path applies.
 *
 * PROTOCOL (all messages are plain objects; ArrayBuffers are transferred)
 *   page -> worker  { type: 'convert', data: ArrayBuffer, maxPages?, limits?, ocr?: boolean }
 *                   { type: 'ocr-result', id, lines }   (or { id, error })
 *   worker -> page  { type: 'ready' }                       libraries are up
 *                   { type: 'init-error', message }
 *                   { type: 'progress', done, total }           after every page
 *                   { type: 'chunk', bytes: ArrayBuffer }       the .docx, in order
 *                   { type: 'done', stats, writer }
 *                   { type: 'error', name, code?, message, detail? }
 *                   { type: 'ocr', id, bitmap: ImageBitmap, scale, pageNumber }
 * Cancel is worker.terminate() from the page: nothing here needs to unwind.
 *
 * OCR is the SHELL's job and the page owns Tesseract (it needs the DOM and its own
 * worker): the converter renders the scan to an OffscreenCanvas at the OCR scale,
 * ships the bitmap up, and waits for the lines (already in page space).
 */
/* global self, importScripts, fflate, Worker, OffscreenCanvas */
'use strict';

const CHUNK_TARGET = 1024 * 1024; // post the zip in ~1 MB pieces, not in fflate's tiny ones

let streamMod = null;
let ocrScaleFor = null;
const ocrWaiting = new Map();
let ocrSeq = 0;

async function init() {
  try {
    importScripts('/js/vendor/pdf.min.js', '/js/vendor/fflate.min.js');
    // pdf.js's own worker, started HERE and handed over as a port. Letting pdf.js start it from
    // workerSrc reads window.location, which a worker does not have: it then silently falls back
    // to parsing on this very thread and fails on `document` (measured, pdf.js 3.11). A port
    // also means an engine that cannot nest workers throws here, into the init-error path.
    pdfjsLib.GlobalWorkerOptions.workerPort = new Worker('/js/vendor/pdf.worker.min.js');
    streamMod = await import('/js/docx/stream.js');
    ({ ocrScaleFor } = await import('/js/core/ocr-lines.js'));
    self.postMessage({ type: 'ready' });
  } catch (e) {
    self.postMessage({ type: 'init-error', message: String((e && e.message) || e) });
  }
}

// pdf.js renders through a canvas factory that, by default, reaches for `document`.
// There is none here; OffscreenCanvas is the worker's canvas.
const canvasFactory = {
  create(width, height) {
    const canvas = new OffscreenCanvas(Math.max(1, width), Math.max(1, height));
    return { canvas, context: canvas.getContext('2d') };
  },
  reset(cc, width, height) { cc.canvas.width = width; cc.canvas.height = height; },
  destroy(cc) { cc.canvas.width = 0; cc.canvas.height = 0; cc.canvas = null; cc.context = null; },
};

function makeOcr() {
  return async ({ page, viewport, pageNumber }) => {
    const scale = ocrScaleFor(viewport.width);
    const vp = page.getViewport({ scale });
    const cc = canvasFactory.create(Math.ceil(vp.width), Math.ceil(vp.height));
    await page.render({ canvasContext: cc.context, viewport: vp, canvasFactory }).promise;
    const bitmap = cc.canvas.transferToImageBitmap();
    const id = ++ocrSeq;
    const answer = new Promise((resolve, reject) => { ocrWaiting.set(id, { resolve, reject }); });
    self.postMessage({ type: 'ocr', id, bitmap, scale, pageNumber }, [bitmap]);
    return answer;
  };
}

async function run(msg) {
  const pending = [];
  let pendingBytes = 0;
  const flush = () => {
    if (!pendingBytes) return;
    const out = new Uint8Array(pendingBytes);
    let at = 0;
    for (const c of pending) { out.set(c, at); at += c.length; }
    pending.length = 0;
    pendingBytes = 0;
    self.postMessage({ type: 'chunk', bytes: out.buffer }, [out.buffer]);
  };
  try {
    const { stats, writer } = await streamMod.convertPdfToDocxStream({
      pdfjs: pdfjsLib,
      fflate,
      data: new Uint8Array(msg.data),
      maxPages: msg.maxPages,
      limits: msg.limits,
      ocr: msg.ocr ? makeOcr() : undefined,
      onChunk: (bytes, final) => {
        // the zip hands over views of its own buffers: copy before they are reused
        pending.push(bytes.slice());
        pendingBytes += bytes.length;
        if (final || pendingBytes >= CHUNK_TARGET) flush();
      },
      onProgress: (done, total) => {
        self.postMessage({ type: 'progress', done, total });
      },
    });
    flush();
    self.postMessage({ type: 'done', stats, writer });
  } catch (e) {
    self.postMessage({ type: 'error', name: (e && e.name) || 'Error', code: e && e.code, message: String((e && e.message) || e), detail: e && e.detail });
  }
}

self.onmessage = (e) => {
  const m = e.data;
  if (!m) return;
  if (m.type === 'convert') run(m);
  else if (m.type === 'ocr-result') {
    const w = ocrWaiting.get(m.id);
    if (!w) return;
    ocrWaiting.delete(m.id);
    if (m.error) w.reject(new Error(m.error)); else w.resolve(m.lines);
  }
};

init();
