/*
 * PDFLokal — tests/spike/live-surgery-timing-lib.js  (MEASUREMENT SPIKE, internal)
 * ============================================================================
 * Architecture-decision input (2026-07-19): before building the "live surgery"
 * commit pipeline (re-render the edited page from a surgically-modified PDF
 * AT COMMIT TIME instead of overlaying cover+text annotations), measure
 * whether it's fast enough. This file uses the REAL production modules —
 * js/core/vendor.js (ensurePdfJs/ensurePdfLib, same lazy loader the app
 * uses) and js/core/redact.js (removeRunsFromPdfPage, the exact function
 * core/export.js's runSurgery() calls) — never a reimplementation.
 *
 * Not a product page: noindexed, unlinked, lives only for
 * tests/spike/live-surgery-timing.spec.js to drive via page.evaluate().
 *
 * Exposes on window:
 *   spikeMeasure(bytesArray, opts?) -> Promise<Result>
 *   spikeBuildLargeDoc(bytesArray, pageCount?) -> Promise<number[]> (PDF bytes)
 */

import { ensurePdfJs, ensurePdfLib } from '/js/core/vendor.js';
import { removeRunsFromPdfPage } from '/js/core/redact.js';

const RUNS = 3; // "run each measurement 3x, report median (first run separately as cold)"
const RENDER_SCALE = 1.5;

// Mirrors text-walk.js's own (unexported) normalize() and lab-edit.js's copy
// of it — a target's (ux,uy) baseline-direction unit vector, derived from
// pdf.js's item.transform, must match exactly what the interpreter walk
// computes internally or the match fails. See core/redact.js header +
// js/lab-edit.js for the same derivation used in the shipped lab page.
function normalize(x, y) {
  const len = Math.hypot(x, y);
  return len === 0 ? [1, 0] : [x / len, y / len];
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function summarize(times) {
  return { cold: times[0], all: times.slice(), median: median(times) };
}

// Page-1 candidate targets, longest-string-first (a substantial real line is
// less likely to hit text-walk.js's DECLINE path than a stray short glyph
// run) — same geometry shape js/lab-edit.js's fase-2 "hapus dari stream"
// button builds by hand from pdf.js's item.transform/width.
async function findCandidates(pdfjs, bytes) {
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  try {
    const page = await doc.getPage(1);
    const tc = await page.getTextContent();
    return tc.items
      .filter((i) => i.str && i.str.trim().length > 3)
      .sort((a, b) => b.str.length - a.str.length)
      .map((item) => {
        const [ux, uy] = normalize(item.transform[0], item.transform[1]);
        return {
          str: item.str,
          target: {
            x0: item.transform[4],
            y0: item.transform[5],
            ux,
            uy,
            len: item.width,
            size: Math.hypot(item.transform[2], item.transform[3]),
          },
        };
      });
  } finally {
    await doc.destroy();
  }
}

async function timeLoad(PDFLib, bytes) {
  const t0 = performance.now();
  const doc = await PDFLib.PDFDocument.load(bytes.slice());
  const t1 = performance.now();
  return { ms: t1 - t0, doc };
}

// Try each candidate (longest first) until one matches — mirrors what a real
// commit would do (the app already knows WHICH line the user tapped; here we
// don't have a UI tap, so we probe for the first candidate the position-walk
// actually trusts). Only a SUCCESSFUL match mutates the page's content
// stream (see redact.js: `if (removed > 0)`), so a declined candidate is
// always safe to retry with the next one on the same page.
function timeSurgery(PDFLib, doc, candidates) {
  const page = doc.getPages()[0];
  const t0 = performance.now();
  let matchedStr = null;
  for (const c of candidates) {
    const { results } = removeRunsFromPdfPage(page, PDFLib, [c.target]);
    if (results[0].matched) {
      matchedStr = c.str;
      break;
    }
  }
  const t1 = performance.now();
  return { ms: t1 - t0, matched: !!matchedStr, str: matchedStr };
}

async function timeSaveWholeDoc(doc) {
  const t0 = performance.now();
  const bytes = await doc.save({ useObjectStreams: true, addDefaultPage: false });
  const t1 = performance.now();
  return { ms: t1 - t0, bytes };
}

// Variant B: pdf-lib copyPages() the ALREADY-SURGERIED page into a fresh
// single-page doc, then save THAT (small) doc — the page-extraction
// architecture's commit step.
async function timeSavePageScoped(PDFLib, doc, pageIndex) {
  const t0 = performance.now();
  const newDoc = await PDFLib.PDFDocument.create();
  const [copied] = await newDoc.copyPages(doc, [pageIndex]);
  newDoc.addPage(copied);
  const bytes = await newDoc.save({ useObjectStreams: true, addDefaultPage: false });
  const t1 = performance.now();
  return { ms: t1 - t0, bytes };
}

async function timeRender(pdfjs, bytes, scale) {
  const t0 = performance.now();
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise;
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const t1 = performance.now();
    return { ms: t1 - t0 };
  } finally {
    await doc.destroy();
  }
}

// Full measurement pipeline for one fixture's bytes. Runs cold + 2 more of
// every timed step (median reported), never asserts thresholds — this is
// data collection for an architecture decision, not a pass/fail gate.
window.spikeMeasure = async function spikeMeasure(bytesArray) {
  const bytes = Uint8Array.from(bytesArray);
  const pdfjs = await ensurePdfJs();
  const { PDFLib } = await ensurePdfLib();

  const candidates = await findCandidates(pdfjs, bytes);
  if (candidates.length === 0) throw new Error('spikeMeasure: no candidate text runs on page 1');

  const result = { fixtureBytes: bytes.length, candidateCount: candidates.length };

  // ---- 1. PDFDocument.load — cold + median. Warm reuse (a session caching
  // the parsed doc, as buildPdfBytes's srcDocCache already does for export)
  // is a Map lookup, not a re-parse — effectively 0ms, noted rather than
  // measured (there is nothing to time).
  const loadTimes = [];
  for (let i = 0; i < RUNS; i += 1) {
    const { ms } = await timeLoad(PDFLib, bytes);
    loadTimes.push(ms);
  }
  result.load = { ...summarize(loadTimes), warmReuseMs: 0 };

  // ---- 2. Surgery — needs a FRESH doc each run (a successful match mutates
  // the content stream in place), so each iteration reloads first (untimed
  // reload happens inside timeLoad above the fold, timed separately here).
  const surgeryTimes = [];
  let matchedStr = null;
  let surgeriedDoc = null; // carried forward into steps 3-6 (the LAST run's doc)
  for (let i = 0; i < RUNS; i += 1) {
    const { doc } = await timeLoad(PDFLib, bytes);
    const s = timeSurgery(PDFLib, doc, candidates);
    surgeryTimes.push(s.ms);
    if (s.matched) matchedStr = s.str;
    surgeriedDoc = doc;
  }
  result.surgery = { ...summarize(surgeryTimes), matched: !!matchedStr, targetStr: matchedStr };

  // ---- 3/4. Variant A: whole-doc save() + pdf.js re-render of the result.
  const saveATimes = [];
  let savedBytesA = null;
  for (let i = 0; i < RUNS; i += 1) {
    const r = await timeSaveWholeDoc(surgeriedDoc);
    saveATimes.push(r.ms);
    savedBytesA = r.bytes;
  }
  result.saveWholeDoc = summarize(saveATimes);

  const renderATimes = [];
  for (let i = 0; i < RUNS; i += 1) {
    const r = await timeRender(pdfjs, savedBytesA, RENDER_SCALE);
    renderATimes.push(r.ms);
  }
  result.renderA = summarize(renderATimes);

  result.totalA = {
    cold: result.load.cold + result.surgery.cold + result.saveWholeDoc.cold + result.renderA.cold,
    median: result.load.median + result.surgery.median + result.saveWholeDoc.median + result.renderA.median,
  };

  // ---- 5/6. Variant B: page-scoped copyPages() into a fresh doc, save that,
  // re-render the (much smaller) result.
  const saveBTimes = [];
  let savedBytesB = null;
  for (let i = 0; i < RUNS; i += 1) {
    const r = await timeSavePageScoped(PDFLib, surgeriedDoc, 0);
    saveBTimes.push(r.ms);
    savedBytesB = r.bytes;
  }
  result.savePageScoped = summarize(saveBTimes);

  const renderBTimes = [];
  for (let i = 0; i < RUNS; i += 1) {
    const r = await timeRender(pdfjs, savedBytesB, RENDER_SCALE);
    renderBTimes.push(r.ms);
  }
  result.renderB = summarize(renderBTimes);

  result.totalB = {
    cold: result.load.cold + result.surgery.cold + result.savePageScoped.cold + result.renderB.cold,
    median: result.load.median + result.surgery.median + result.savePageScoped.median + result.renderB.median,
  };

  result.savedBytesA_length = savedBytesA.length;
  result.savedBytesB_length = savedBytesB.length;

  return result;
};

// Synthesize a large multi-page doc by duplicating page 0 of the given
// source bytes `pageCount` times (pdf-lib copyPages, real API — not a
// reimplementation) — the fixture generators only ship small letters, and
// the architectures are expected to diverge most on a many-page document.
//
// WHY pageCount SEPARATE copyPages() calls, not one copyPages(srcDoc,
// indices) batch call with a repeated index: pdf-lib's copier caches copied
// objects PER CALL, keyed by the SOURCE ref. Passing indices=[0,0,…,0] in
// ONE call hits that cache 30 times over and produces 30 page dicts sharing
// ONE cloned content stream + resources — confirmed empirically (a 30-copy
// batch call grew the saved doc by ~650 bytes total, not ~29 pages' worth).
// That under-represents a real 30-page letter, where every page's content
// stream is genuinely distinct, so it can't show the multi-page divergence
// this spike exists to measure. Looping copyPages() once per page gives each
// call a fresh (empty) cache, so each copy is independently cloned — the
// structurally-honest stand-in for "30 real pages."
window.spikeBuildLargeDoc = async function spikeBuildLargeDoc(bytesArray, pageCount = 30) {
  const { PDFLib } = await ensurePdfLib();
  const srcBytes = Uint8Array.from(bytesArray);
  const srcDoc = await PDFLib.PDFDocument.load(srcBytes.slice());
  const newDoc = await PDFLib.PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) {
    const [copied] = await newDoc.copyPages(srcDoc, [0]); // one call per page — see WHY above
    newDoc.addPage(copied);
  }
  const bytes = await newDoc.save({ useObjectStreams: true, addDefaultPage: false });
  return Array.from(bytes);
};
