#!/usr/bin/env node
/*
 * Generate tests/fixtures/nasty/terpotong.pdf — a TRUNCATED PDF.
 * Run: `node scripts/gen-fixture-terpotong.mjs`.
 *
 * WHAT IT ACTUALLY DOES — MEASURED, not assumed. This file was built expecting
 * a PDF.js-tolerant / pdf-lib-strict divergence: a document that opens and
 * edits fine and can never be exported. It is NOT that. Measured in the
 * browser on 2026-07-28: PDF.js rejects this truncation too, so it fails at
 * IMPORT and never reaches the editor. The first version of this comment
 * claimed the opposite; the spec asserted the claim instead of trusting it, and
 * that is what caught it.
 *
 * So its real job is the IMPORT stage: a genuinely damaged file whose failure
 * must reach the rail as `failure {stage:'import', reason:'corrupt'}` rather
 * than as silence or as 'unknown'. See tests/export-failure-reason.spec.js.
 *
 * WHY TRUNCATION: it is the damage users actually arrive with — an interrupted
 * download, a cancelled cloud sync, a file copied off a failing disk.
 *
 * ⚠️ THE DIVERGENCE CLASS IS STILL REAL, just not reproduced by this file:
 * core/export.js:333 re-loads the ORIGINAL bytes through pdf-lib at download
 * time, so any document pdf-lib rejects but PDF.js accepts edits perfectly and
 * fails only at the end, every time. An encrypted PDF is the known member of
 * that class. Whether the 2026-07-28 incident file was one, we cannot say — the
 * rail recorded 'unknown' for all 41 attempts because the export path
 * hard-coded that literal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'tests/fixtures/nasty/surat-word.pdf');
const OUT = path.join(root, 'tests/fixtures/nasty/terpotong.pdf');

// 40 bytes removes %%EOF and part of the startxref offset — enough to defeat
// pdf-lib's parser, not enough to stop PDF.js reconstructing the page.
const whole = fs.readFileSync(SRC);
const cut = whole.subarray(0, whole.length - 40);
fs.writeFileSync(OUT, cut);
console.log(`terpotong.pdf  ${cut.length} bytes (from ${whole.length}, −40)`);

// PROVE THE FIXTURE STILL BITES. If a future pdf-lib upgrade learns to recover
// from this, the fixture stops testing anything and every spec using it would
// keep passing while proving nothing.
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'window', 'define', 'globalThis',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports && Object.keys(module.exports).length ? module.exports : globalThis.PDFLib;
};
const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
try {
  await PDFLib.PDFDocument.load(new Uint8Array(cut));
  throw new Error('FIXTURE IS TOOTHLESS — pdf-lib loaded the truncated file; cut more, or pick another damage');
} catch (err) {
  if (/TOOTHLESS/.test(err.message)) throw err;
  console.log(`pdf-lib rejects it, as required: ${err.name}: ${String(err.message).slice(0, 60)}…`);
}
