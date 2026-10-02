/*
 * PDFLokal — docx/client.js  (THE PAGE-SIDE ENTRY: PDF in, a .docx Blob out)
 * ============================================================================
 * The ONE function the UI will call, and it must be reached through a dynamic
 * import so nothing here loads until someone converts a file:
 *
 *   const { convertPdfFile } = await import('/js/docx/client.js');
 *   const { blob, stats } = await convertPdfFile(file, { onProgress, signal });
 *
 *   input       File | Blob | ArrayBuffer | Uint8Array
 *   opts        { onProgress(done, total)           after every page
 *                 signal                           an AbortSignal; aborting kills the worker at once
 *                                                  and rejects with an AbortError
 *                 maxPages                         convert only the first N pages
 *                 limits                           docx/stream.js limits, merged over policy.js's
 *                 policy                           a device class name or a policy.js result (default: detected)
 *                 ocr                              async ({ source, scale, pageNumber }) -> page-space lines;
 *                                                  `source` is an ImageBitmap (worker) or a canvas (main thread).
 *                                                  Omit and scans convert as pictures without text.
 *                 mode                             'auto' (default: worker, else main thread) | 'worker' | 'main'
 *                 onMode(mode)                     which path was taken
 *               }
 *   -> { blob (DOCX_MIME), stats, writer, mode, ms }
 *
 * Errors: AbortError (cancelled), LimitError (err.code: input-too-large | too-many-pages |
 * output-too-large, see policy.js), anything else is a conversion failure.
 *
 * The WORKER path keeps the page responsive and bounds memory (docx/worker.js). The
 * MAIN-THREAD path exists for engines that cannot start the worker (an old WebView,
 * a blocked nested worker): the same stream converter, yielding to the page between
 * pages, using the same vendor loader as the rest of the app. Only a worker that fails
 * to START falls back; a worker that fails MID-RUN reports the error (retrying on the
 * main thread would only freeze the page on the same input).
 */

/* global Worker, DOMException */
import { assessDevice, limitsFor } from './policy.js';
import { DOCX_MIME } from './stream.js';

const READY_TIMEOUT_MS = 30000;

const abortError = () => {
  try { return new DOMException('aborted', 'AbortError'); } catch { const e = new Error('aborted'); e.name = 'AbortError'; return e; }
};

function limitError(msg) {
  const e = new Error(msg.message);
  e.name = msg.name || 'Error';
  if (msg.code) e.code = msg.code;
  if (msg.detail) e.detail = msg.detail;
  return e;
}

// Fresh bytes on every call: a worker run TRANSFERS its copy away, and the main-thread
// fallback needs bytes again. A File/Blob re-reads (no second copy held); an ArrayBuffer or
// Uint8Array is copied so the caller's own bytes stay intact.
async function bytesOf(input) {
  if (input instanceof Uint8Array) return input.slice().buffer;
  if (input instanceof ArrayBuffer) return input.slice(0);
  return input.arrayBuffer();
}

function resolveLimits(opts, byteLength) {
  const device = typeof opts.policy === 'object' && opts.policy ? opts.policy : assessDevice(typeof opts.policy === 'string' ? { force: opts.policy } : undefined);
  return { device, limits: { ...limitsFor(device, byteLength), ...(opts.limits || {}) } };
}

function runInWorker(buffer, { onProgress, signal, maxPages, limits, ocr }) {
  return new Promise((resolve, reject) => {
    let worker;
    try { worker = new Worker(new URL('./worker.js', import.meta.url)); } catch (e) { reject(Object.assign(new Error(String(e.message || e)), { startFailed: true })); return; }
    const parts = [];
    let started = false;
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      worker.terminate(); // the worker's memory goes back with it
      fn(v);
    };
    const onAbort = () => finish(reject, abortError());
    const timer = setTimeout(() => finish(reject, Object.assign(new Error('worker did not start'), { startFailed: true })), READY_TIMEOUT_MS);
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    worker.onerror = (ev) => {
      const err = new Error(String((ev && ev.message) || 'worker error'));
      if (!started) err.startFailed = true;
      if (ev && ev.preventDefault) ev.preventDefault();
      finish(reject, err);
    };
    worker.onmessage = async (ev) => {
      const m = ev.data;
      if (!m) return;
      if (m.type === 'ready') {
        started = true;
        clearTimeout(timer);
        worker.postMessage({ type: 'convert', data: buffer, maxPages, limits, ocr: !!ocr }, [buffer]);
      } else if (m.type === 'init-error') {
        finish(reject, Object.assign(new Error(m.message), { startFailed: true }));
      } else if (m.type === 'progress') {
        if (onProgress) onProgress(m.done, m.total);
      } else if (m.type === 'chunk') {
        parts.push(new Blob([m.bytes])); // browser-managed storage, not our heap
      } else if (m.type === 'done') {
        finish(resolve, { blob: new Blob(parts, { type: DOCX_MIME }), stats: m.stats, writer: m.writer });
      } else if (m.type === 'error') {
        finish(reject, limitError(m));
      } else if (m.type === 'ocr') {
        try {
          const lines = await ocr({ source: m.bitmap, scale: m.scale, pageNumber: m.pageNumber });
          if (!settled) worker.postMessage({ type: 'ocr-result', id: m.id, lines });
        } catch (e) {
          if (!settled) worker.postMessage({ type: 'ocr-result', id: m.id, error: String((e && e.message) || e) });
        } finally {
          if (m.bitmap && m.bitmap.close) m.bitmap.close();
        }
      }
    };
  });
}

async function runOnMainThread(buffer, { onProgress, signal, maxPages, limits, ocr }) {
  const { ensurePdfJs, ensureFflate } = await import('../core/vendor.js');
  const [pdfjs, fflate, { convertPdfToDocxStream }] = await Promise.all([ensurePdfJs(), ensureFflate(), import('./stream.js')]);
  const parts = [];
  const nextTick = () => new Promise((r) => setTimeout(r, 0));
  const mainOcr = ocr && (async ({ page, viewport, pageNumber }) => {
    const { ocrScaleFor } = await import('../core/ocr-lines.js');
    const scale = ocrScaleFor(viewport.width);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    return ocr({ source: canvas, scale, pageNumber });
  });
  const { stats, writer } = await convertPdfToDocxStream({
    pdfjs,
    fflate,
    data: new Uint8Array(buffer),
    maxPages,
    limits,
    signal,
    ocr: mainOcr || undefined,
    onChunk: (bytes) => { parts.push(new Blob([bytes.slice()])); },
    onProgress: async (done, total) => { if (onProgress) onProgress(done, total); await nextTick(); },
  });
  return { blob: new Blob(parts, { type: DOCX_MIME }), stats, writer };
}

export async function convertPdfFile(input, opts = {}) {
  const { signal } = opts;
  if (signal && signal.aborted) throw abortError();
  const size = input.byteLength !== undefined ? input.byteLength : input.size;
  const { limits } = resolveLimits(opts, size);
  const args = { onProgress: opts.onProgress, signal, maxPages: opts.maxPages, limits, ocr: opts.ocr };
  const t0 = performance.now();
  let mode = opts.mode === 'main' ? 'main' : 'worker';
  let result;
  if (mode === 'worker') {
    if (typeof Worker === 'undefined') {
      if (opts.mode === 'worker') throw new Error('Web Workers are not available here');
      mode = 'main';
    } else {
      try {
        if (opts.onMode) opts.onMode('worker');
        result = await runInWorker(await bytesOf(input), args);
      } catch (e) {
        if (!(e && e.startFailed) || opts.mode === 'worker') throw e;
        mode = 'main';
      }
    }
  }
  if (mode === 'main') {
    if (opts.onMode) opts.onMode('main');
    result = await runOnMainThread(await bytesOf(input), args);
  }
  return { ...result, mode, ms: Math.round(performance.now() - t0) };
}
