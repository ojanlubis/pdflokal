/*
 * page-surgery-mixedfonts.test.mjs — per-run targets must not lose the
 * "decline native stamp on a genuinely mixed-font line" guarantee.
 * ============================================================================
 * js/v2/app.js's smartReplace now feeds core/page-surgery.js ONE TARGET PER
 * CONSTITUENT RUN (see page-surgery-dashleader.test.mjs for the defect this
 * fixes) instead of one blended target spanning the whole line. That fixed
 * the dash-leader false-clean-match defect, but it removes the ONE place
 * core/text-walk.js's planRunRemoval used to notice "this line's cut ops
 * came from more than one font" — `insert.mixedFonts` is computed WITHIN a
 * single target's own matched ops (core/text-walk.js's planRunRemoval), and
 * with per-run targets each target typically matches exactly one op, so that
 * per-target check is trivially always false now.
 *
 * core/text-lines.test.mjs's own "dominant style" case (a short BOLD
 * fragment + a long regular fragment sharing a baseline) is real: text-lines
 * .js correctly clusters them into ONE Line, and a user CAN tap-replace it.
 * Without re-aggregating mixedFonts ACROSS a cover's whole target array (see
 * core/page-surgery.js's runSurgery), the stamp step would silently pick
 * whichever run's font happened to be first and stamp the ENTIRE replacement
 * in it — a confident WRONG font, the same defect class (plausible answer
 * from unchecked data) the dash-leader fix exists to remove, just relocated.
 *
 * This test proves the aggregation holds: two genuinely different embedded
 * fonts (Carlito, Montserrat-Bold — both real repo assets, same size, same
 * baseline) cluster into one Line, get per-run targets, both cut cleanly
 * (matched:true — the CUT is correct and complete), but the native/clone
 * STAMP declines with 'mixed-fonts' rather than guessing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as model from '../../js/core/model.js';
import * as ops from '../../js/core/operations.js';
import { applyPageSurgery } from '../../js/core/page-surgery.js';
import { extractFontMetrics, readPageContents } from '../../js/core/redact.js';
import { walkShowOps } from '../../js/core/text-walk.js';
import { groupRunsIntoLines } from '../../js/core/text-lines.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};

// Same run-shape adapter page-surgery-dashleader.test.mjs uses: walkShowOps'
// records -> the Run[] shape core/text-lines.js's groupRunsIntoLines reads.
function recordsToRuns(records) {
  return records
    .filter((r) => r.tokens.some((t) => t.t === 'str'))
    .map((r) => ({
      str: r.tokens.find((t) => t.t === 'str').v,
      x: r.x, y: r.y, w: r.advanceText ?? 0, h: r.size,
      size: r.size, fontName: r.fontName, fontFamily: '',
      pdf: { x0: r.x, y0: r.y, ux: r.ux, uy: r.uy, len: r.advanceText ?? 0, size: r.size },
    }));
}

test('runSurgery+planNativeInserts: two different embedded fonts sharing one baseline decline the native stamp (mixedFonts), even though the cut itself is clean', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

  const buildDoc = await PDFLib.PDFDocument.create();
  buildDoc.registerFontkit(fontkit);
  const size = 12;
  const bold = await buildDoc.embedFont(
    new Uint8Array(fs.readFileSync(path.join(root, 'fonts/montserrat-bold.woff2'))),
  );
  const regular = await buildDoc.embedFont(
    new Uint8Array(fs.readFileSync(path.join(root, 'fonts/carlito-regular.woff2'))),
  );
  const page = buildDoc.addPage([595, 842]);
  const y = 700;
  const boldText = 'Bld ';
  page.drawText(boldText, { x: 72, y, size, font: bold, color: PDFLib.rgb(0, 0, 0) });
  const boldWidth = bold.widthOfTextAtSize(boldText, size);
  page.drawText('regular text continues the same line', {
    x: 72 + boldWidth, y, size, font: regular, color: PDFLib.rgb(0, 0, 0),
  });
  const bytes = await buildDoc.save();

  // Reload (same "pdf-lib only registers fonts into the context at save
  // time" discipline as font-style.test.mjs's buildAndReload).
  const srcDoc = await PDFLib.PDFDocument.load(bytes);
  const srcPage = srcDoc.getPages()[0];

  const fonts = extractFontMetrics(srcPage, PDFLib);
  const content = readPageContents(srcPage, PDFLib);
  const records = walkShowOps(content, fonts);
  const runs = recordsToRuns(records);
  const lines = groupRunsIntoLines(runs);
  assert.equal(lines.length, 1, 'both fragments must cluster into ONE line');
  const [line] = lines;
  assert.equal(line.runs.length, 2);
  assert.notEqual(line.runs[0].fontName, line.runs[1].fontName, 'the two runs must use genuinely different font resources');

  const doc = model.createDoc();
  const source = ops.addSource(doc, model.createSource({ name: 'mixedfonts', bytes, numPages: 1 }));
  const modelPage = model.createPage({ source, sourcePageNum: 0, width: 595, height: 842, rotation: 0 });
  ops.addPages(doc, [modelPage]);

  const replaceTargets = line.runs.map((r) => r.pdf); // the fixed, per-run construction
  const rect = { x: 72, y, width: 300, height: 20 };
  const cover = model.createAnnotation('whiteout', {
    x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    replaceTargets, replaceBox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
  });
  ops.addAnnotation(doc, modelPage.id, cover);
  const text = model.createAnnotation('text', {
    x: rect.x, y: rect.y, width: 200, height: 20,
    text: 'Diganti semua', fontFamily: 'Helvetica', fontSize: size, color: '#000000',
    replaceCoverId: cover.id,
  });
  ops.addAnnotation(doc, modelPage.id, text);

  // Fresh pdf-lib doc/page to surgery against, mirroring buildEditedPageBytes'
  // own copyPages step (applyPageSurgery expects an already-copied page).
  const newDoc = await PDFLib.PDFDocument.create();
  newDoc.registerFontkit(fontkit);
  const [copiedPage] = await newDoc.copyPages(srcDoc, [0]);
  const pdfPage = newDoc.addPage(copiedPage);

  const result = await applyPageSurgery(pdfPage, PDFLib, fontkit, modelPage.annotations);

  // The CUT is correct and complete: both runs matched, nothing partial.
  assert.deepEqual(result.surgeryByCover.get(cover.id), { matched: true, reason: 'clean' });
  assert.ok(result.skipCovers.has(cover.id));

  // The STAMP declines rather than guessing a single font for a genuinely
  // mixed-font line — this is the aggregation this test exists to pin.
  assert.equal(result.skipDraw.has(text.id), false, 'native/clone stamp must decline on a mixed-font line');
  assert.deepEqual(result.insertOutcomes.get(text.id), {
    path: 'twin', reason: 'mixed-fonts', style_source: 'none', glyph_shortfall: 0,
  });
});
