/*
 * export-font-fallback.test.mjs — the substitution WITNESS (audit 2026-08-09,
 * finding 2).
 * ============================================================================
 * THE DEFECT THIS CLOSES: when a custom/clone font's woff2 could not be
 * fetched at export time (offline PWA, timeout, 404), core/export.js's
 * cacheFallbackFont substituted Helvetica in the KEPT FILE with only a
 * console.error — the export "succeeded", the user's document renders in a
 * different typeface than the preview, and neither the user nor the rail
 * ever learned. The fix is a witness, not a behaviour change: the fallback
 * still happens (an export in Helvetica beats one that dies), but
 * deps.onFontFallback now fires so the caller (download-sheet.js / the
 * extract path in js/v2/app.js) can toast and count it.
 *
 * Both substitution doors are pinned:
 *   1. fetch itself failing (the offline/timeout case) — fontkit present.
 *   2. no fontkit at all (the headless-caller guard) — same fallback,
 *      same witness.
 * And the contrapositive that keeps this a check rather than a ritual:
 *   3. a standard font never fires it (nothing was substituted), and the
 *      callback is optional (omitting it must not throw — that is exactly
 *      the pre-fix call shape every other caller still uses).
 *
 * pdf-lib bitstability memory: asserts structure (page count, load-ability),
 * never raw bytes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as model from '../../js/core/model.js';
import * as ops from '../../js/core/operations.js';
import { buildPdfBytes } from '../../js/core/export.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NASTY = (name) => path.join(root, 'tests', 'fixtures', 'nasty', name);

// Same vendored-UMD loader as export-parity.test.mjs / font-style.test.mjs.
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};

async function buildDocWithText(PDFLib, fontFamily) {
  const bytes = fs.readFileSync(NASTY('lorem-full.pdf'));
  const srcPdfDoc = await PDFLib.PDFDocument.load(bytes);
  const { width, height } = srcPdfDoc.getPages()[0].getSize();

  const doc = model.createDoc();
  const source = ops.addSource(doc, model.createSource({ name: 'lorem-full.pdf', bytes, numPages: 1 }));
  const page = model.createPage({ source, sourcePageNum: 0, width, height, rotation: 0 });
  ops.addPages(doc, [page]);
  ops.addAnnotation(doc, page.id, model.createAnnotation('text', {
    text: 'Uji font', x: 40, y: 40, fontSize: 14, fontFamily, bold: false, italic: false, color: '#000000',
  }));
  return doc;
}

// Runs one export with fetch replaced by `fetchImpl` (null = leave as-is),
// collecting every onFontFallback firing. Restores fetch afterwards.
async function exportWith({ PDFLib, fontkit, fontFamily, fetchImpl, passCallback = true }) {
  const realFetch = globalThis.fetch;
  if (fetchImpl !== null) globalThis.fetch = fetchImpl;
  const fallbacks = [];
  try {
    const doc = await buildDocWithText(PDFLib, fontFamily);
    const deps = { PDFLib, fontkit };
    if (passCallback) deps.onFontFallback = (name) => fallbacks.push(name);
    const bytes = await buildPdfBytes(doc, deps);
    return { bytes, fallbacks };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test('1. fetch failure on a clone font fires the witness AND the export still succeeds', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
  const { bytes, fallbacks } = await exportWith({
    PDFLib, fontkit, fontFamily: 'Carlito',
    fetchImpl: async () => { throw new TypeError('simulated network failure'); },
  });
  assert.equal(fallbacks.length, 1, 'exactly one substitution reported (later uses hit the cache)');
  assert.match(fallbacks[0], /Carlito/, 'the reported name identifies the font that was substituted');
  const reloaded = await PDFLib.PDFDocument.load(bytes);
  assert.equal(reloaded.getPageCount(), 1, 'the fallback still produced a valid one-page PDF');
});

test('2. the no-fontkit guard is a substitution too, and says so', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const { fallbacks } = await exportWith({
    PDFLib, fontkit: undefined, fontFamily: 'Carlito', fetchImpl: null,
  });
  assert.equal(fallbacks.length, 1);
});

test('3. a standard font fires NOTHING, and an absent callback never throws', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
  // Standard font: no fetch, no substitution → the witness must stay silent,
  // or every export would cry wolf and the toast would train users to ignore it.
  const { fallbacks } = await exportWith({ PDFLib, fontkit, fontFamily: 'Helvetica', fetchImpl: null });
  assert.equal(fallbacks.length, 0);
  // Pre-fix call shape (no callback) + a failing fetch: must not throw.
  const { bytes } = await exportWith({
    PDFLib, fontkit, fontFamily: 'Carlito',
    fetchImpl: async () => { throw new TypeError('simulated network failure'); },
    passCallback: false,
  });
  assert.ok(bytes.length > 0);
});
