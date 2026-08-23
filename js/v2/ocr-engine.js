/*
 * PDFLokal — v2/ocr-engine.js  (THE OCR ENGINE LOADER — one home, two callers)
 * ============================================================================
 * Loads the vendored Tesseract engine and recognises one canvas. That is all
 * it does: no coordinates, no product policy, no copy. The arithmetic that
 * turns a result into tap targets is core/ocr-lines.js (pure, node-tested);
 * the decision about WHEN a user is asked to download 5 MB belongs to the
 * caller.
 *
 * WHY IT EXISTS AS A MODULE. /lab-ocr.html grew its own inline `ensureTesseract`
 * while proving rung S1, and the product now needs the same loader for rung
 * S2. Two copies of a loader is the "parallel arrays" liability this repo's
 * conventions already name, one level up: the day the vendored engine moves
 * or the `gzip:false` flag changes, one copy gets fixed and the other keeps
 * working until it doesn't. One home, both callers.
 *
 * WHY A CLASSIC <script> AND NOT core/vendor.js's ensureX(). Tesseract ships
 * as a UMD bundle that assigns a global, not as an ES module, so it cannot be
 * `import()`ed the way pdf-lib and PDF.js are. The shape below is otherwise
 * vendor.js's: one in-flight promise no matter how many callers, and a
 * FAILURE IS NOT CACHED — a rejected load nulls the promise so a retry
 * re-fetches instead of replaying the same error forever (a user on a flaky
 * connection who taps again must get a real second attempt).
 *
 * ⚠️ 5 MB, AND THE USER IS ALWAYS ASKED FIRST. The engine is 5.01 MB
 * (`tesseract-core-simd-lstm.wasm.js` 3.94 MB + `ind.traineddata` 1.12 MB +
 * the loaders). Fauzan ruled the payload acceptable (seat TODO.md) UNDER the
 * WASM-with-transparency ruling (seat decisions.md 2026-07-18): it downloads
 * once, is cached, and the user is told before it starts. Nothing in this
 * module may be called from a page-load path.
 *
 * ⚠️ gzip:false IS LOAD-BEARING, not a preference. We vendor the RAW
 * `ind.traineddata`; tesseract.js defaults to requesting `ind.traineddata.gz`,
 * gets a 404, and surfaces it as "gagal: undefined" with the real cause only
 * in the console. Learned the expensive way in /lab-ocr.html.
 */

const ENGINE_DIR = '/js/vendor/tesseract/';
const ENGINE_SCRIPT = `${ENGINE_DIR}tesseract.min.js`;

// The recognition language. `ind` is vendored; Indonesian is Latin-script, so
// this is Tesseract's home turf (seat spec-edit-dokumen-foto.md §2).
const LANG = 'ind';

let enginePromise = null;

/**
 * Is the engine already in this tab? Lets a caller skip the "this will
 * download" step on the second page of the same document without guessing.
 * Says nothing about the HTTP cache — a fresh tab reports false even when
 * every byte will come from disk.
 */
export function ocrEngineLoaded() {
  return !!(typeof window !== 'undefined' && window.Tesseract);
}

/**
 * Fetch + evaluate the engine bundle. Idempotent; concurrent callers share
 * one fetch. Rejects with a plain Error the caller can surface.
 */
export function ensureOcrEngine() {
  if (ocrEngineLoaded()) return Promise.resolve(window.Tesseract);
  if (enginePromise) return enginePromise;
  enginePromise = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = ENGINE_SCRIPT;
    el.onload = () => resolve(window.Tesseract);
    el.onerror = () => {
      enginePromise = null; // never cache a failure — see the header
      reject(new Error('gagal memuat mesin OCR'));
    };
    document.head.appendChild(el);
  });
  return enginePromise;
}

/**
 * Recognise one canvas (or ImageBitmap / HTMLImageElement).
 *
 * The worker is created and TERMINATED per call, deliberately. A resident
 * Tesseract worker holds the decoded WASM heap — tens of MB — for as long as
 * the tab lives, and this runs on the phones the product is actually used on.
 * Re-creating it costs a worker spawn against an engine already in memory,
 * which is the cheap half; the expensive half (the 5 MB fetch) is what
 * `enginePromise` and the HTTP cache already hold onto.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{onProgress?: (fraction: number) => void}} [opts]
 *   onProgress reports 0..1 during recognition only — the engine fetch has no
 *   progress to report, since a <script> tag exposes none.
 * @returns {Promise<object>} tesseract.js's `data` — `{lines, words, text, …}`,
 *   in CANVAS PIXELS. Hand it to core/ocr-lines.js; do not read boxes here.
 */
export async function recognizeCanvas(canvas, opts = {}) {
  const Tesseract = await ensureOcrEngine();
  const options = {
    workerPath: `${ENGINE_DIR}worker.min.js`,
    corePath: ENGINE_DIR,
    langPath: ENGINE_DIR,
    gzip: false, // see the header — not a preference
  };
  // ⚠️ THE KEY IS OMITTED, NOT SET TO undefined, AND THAT IS THE WHOLE POINT.
  // tesseract.js merges these over its own defaults, so `logger: undefined`
  // does not mean "no logger" — it CLOBBERS the default no-op with undefined,
  // and the worker's every progress message then throws `b is not a function`
  // out of its onmessage handler. Measured: 8 uncaught errors per recognition,
  // all of which js/v2/app.js's global error capture would have faithfully
  // forwarded to the rail and to Sentry, for a feature that was working
  // perfectly. Pinned by tests/ocr-tap-edit.spec.js test 6.
  if (typeof opts.onProgress === 'function') {
    options.logger = (m) => {
      if (m && m.status === 'recognizing text') opts.onProgress(m.progress || 0);
    };
  }
  let worker = null;
  try {
    worker = await Tesseract.createWorker(LANG, 1, options);
    const { data } = await worker.recognize(canvas);
    return data;
  } finally {
    // Never let a terminate failure mask the real error (or the real result):
    // the worker is already unreachable either way.
    if (worker) { try { await worker.terminate(); } catch { /* already gone */ } }
  }
}
