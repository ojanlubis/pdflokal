/*
 * ROTATE OR MERGE AFTER AN EDIT: THE ORIGINAL TEXT IS STILL CUT FROM THE FILE.
 * ============================================================================
 * Regression from 2026-10-10 (rotatePage / normalizePageWidths started moving
 * annotations through core/annotation-geometry.js). They moved an edit cover's
 * x/y/w/h but not its replaceBox, the birth rect page-surgery.js compares the
 * cover against (>= 60% overlap). After a turn or a merge rescale the cover had
 * "moved away", surgery declined, and the export painted a box over text that
 * stayed in the file: selectable, searchable, and the doc-font stamp lost.
 *
 * Measured through deps.onCoverDrawn: a cover is painted ONLY when surgery did
 * not cut (a cut cover is skipped, the true background shows).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as model from '../../js/core/model.js';
import * as ops from '../../js/core/operations.js';
import { buildPdfBytes } from '../../js/core/export.js';
import { extractFontMetrics, readPageContents } from '../../js/core/redact.js';
import { walkShowOps } from '../../js/core/text-walk.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};
const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
const BYTES = fs.readFileSync(path.join(root, 'tests', 'fixtures', 'nasty', 'undangan-cid.pdf'));

async function editedDoc() {
  const srcPage = (await PDFLib.PDFDocument.load(BYTES)).getPages()[0];
  const { width, height } = srcPage.getSize();
  const doc = model.createDoc();
  const source = ops.addSource(doc, model.createSource({ name: 'u.pdf', bytes: BYTES, numPages: 1 }));
  const page = model.createPage({ source, sourcePageNum: 0, width, height, rotation: 0 });
  ops.addPages(doc, [page]);
  // Record 3 is a line surgery CAN cut (same target export-cover-witness uses).
  const rec = walkShowOps(readPageContents(srcPage, PDFLib), extractFontMetrics(srcPage, PDFLib))[3];
  const target = { x0: rec.x, y0: rec.y, ux: rec.ux, uy: rec.uy, size: rec.size, len: 300 };
  const box = { x: 60, y: 200, w: 300, h: 18 };
  const cover = ops.addAnnotation(doc, page.id, model.createAnnotation('whiteout', {
    x: box.x, y: box.y, width: box.w, height: box.h, replaceTargets: [target], replaceBox: { ...box },
  }));
  ops.addAnnotation(doc, page.id, model.createAnnotation('text', {
    x: box.x, y: box.y, text: 'Baru', fontFamily: 'Helvetica', fontSize: 14, color: '#000000', replaceCoverId: cover.id,
  }));
  return { doc, page, cover };
}

async function coversPainted(doc) {
  const seen = [];
  await buildPdfBytes(doc, { PDFLib, fontkit, onCoverDrawn: (a) => seen.push(a.id) });
  return seen.length;
}

test('KNOWN-POSITIVE: unrotated, the cut succeeds (no cover painted); a cover dragged away IS painted', async () => {
  const { doc, cover } = await editedDoc();
  assert.equal(await coversPainted(doc), 0);
  ops.moveAnnotation(doc, cover.id, 0, 300);
  assert.equal(await coversPainted(doc), 1, 'the instrument can see a declined cut');
});

for (const turn of [90, 180, 270, -90]) {
  test(`after rotatePage(${turn}) the original text is still cut`, async () => {
    const { doc, page } = await editedDoc();
    ops.rotatePage(doc, page.id, turn);
    assert.notEqual(page.rotation, 0, 'VACUITY GUARD: the page really turned');
    assert.equal(await coversPainted(doc), 0);
  });
}

test('after a merge rescales the edited page, the original text is still cut', async () => {
  const { doc, page } = await editedDoc();
  // A wider first file becomes the anchor; the edited page is scaled up to it.
  const other = ops.addSource(doc, model.createSource({ name: 'w.pdf', bytes: BYTES, numPages: 1 }));
  const wide = model.createPage({ source: other, sourcePageNum: 0, width: page.width * 1.4, height: page.height * 1.4 });
  doc.pages.unshift(wide);
  const before = page.width;
  ops.normalizePageWidths(doc);
  assert.notEqual(page.width, before, 'VACUITY GUARD: the edited page really was rescaled');
  doc.pages.shift(); // export only the edited page: the anchor's own bytes are not the question
  assert.equal(await coversPainted(doc), 0);
});
