/*
 * export-cover-witness.test.mjs — the export says how many Tip-Ex rectangles it
 * PAINTED into the file (deps.onCoverDrawn), which is what the Unduh sheet's
 * "Yang ditutup masih ada di file" note counts.
 * ============================================================================
 * WHY THE EXPORT IS THE WITNESS. A whiteout that is painted covers text without
 * removing it: the words are still in the PDF for anyone who selects or extracts
 * them. Which whiteouts are painted is decided in one place only: the export's
 * loop, after surgery has had its chance (a successful cut sets skipCovers and
 * the cover is not drawn). Anything that guessed earlier (a flag set when an edit
 * is made) can go stale on undo, or miss a bake that failed.
 *
 * Both directions are pinned, because a witness that always says 0 or always
 * says 1 would pass half of them: a plain Tip-Ex and a DECLINED cut count; a
 * cut that WORKED, a text-only page and an untouched file do not.
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
const FIXTURE = 'undangan-cid.pdf';
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};
const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

async function freshDoc() {
  const bytes = fs.readFileSync(path.join(root, 'tests', 'fixtures', 'nasty', FIXTURE));
  const srcPdfDoc = await PDFLib.PDFDocument.load(bytes);
  const srcPage = srcPdfDoc.getPages()[0];
  const { width, height } = srcPage.getSize();
  const doc = model.createDoc();
  const source = ops.addSource(doc, model.createSource({ name: FIXTURE, bytes, numPages: 1 }));
  const page = model.createPage({ source, sourcePageNum: 0, width, height, rotation: 0 });
  ops.addPages(doc, [page]);
  return { doc, page, srcPage };
}

// The same self-consistent target page-surgery-edited.test.mjs derives: record 3
// is the middle "Rapat Anggota Tahunan 2026" line, which surgery CAN cut.
function realTarget(srcPage) {
  const rec = walkShowOps(readPageContents(srcPage, PDFLib), extractFontMetrics(srcPage, PDFLib))[3];
  return { x0: rec.x, y0: rec.y, ux: rec.ux, uy: rec.uy, size: rec.size, len: 300 };
}

function addEditCover(doc, page, target) {
  const cover = model.createAnnotation('whiteout', {
    x: 0, y: 0, width: 10, height: 10,
    replaceTargets: [target], replaceBox: { x: 0, y: 0, w: 10, h: 10 },
  });
  ops.addAnnotation(doc, page.id, cover);
  return cover;
}

async function coversPainted(doc) {
  const seen = [];
  const bytes = await buildPdfBytes(doc, { PDFLib, fontkit, onCoverDrawn: (a) => seen.push(a.id) });
  return { n: seen.length, ids: seen, bytes };
}

test('an untouched file paints nothing and reports 0', async () => {
  const { doc } = await freshDoc();
  assert.equal((await coversPainted(doc)).n, 0);
});

test('a plain Tip-Ex is painted, so it is counted', async () => {
  const { doc, page } = await freshDoc();
  const w = model.createAnnotation('whiteout', { x: 40, y: 40, width: 120, height: 30 });
  ops.addAnnotation(doc, page.id, w);
  const r = await coversPainted(doc);
  assert.equal(r.n, 1);
  assert.deepEqual(r.ids, [w.id]);
});

test('an Edit/Hapus cover whose cut DECLINED stays painted, so it is counted', async () => {
  const { doc, page } = await freshDoc();
  const cover = addEditCover(doc, page, { x0: 10, y0: 10, ux: 1, uy: 0, len: 50, size: 12 }); // matches nothing
  const r = await coversPainted(doc);
  assert.deepEqual(r.ids, [cover.id]);
});

test('an Edit/Hapus cover whose cut WORKED is not painted, so it is not counted', async () => {
  const { doc, page, srcPage } = await freshDoc();
  addEditCover(doc, page, realTarget(srcPage));
  const r = await coversPainted(doc);
  assert.equal(r.n, 0, 'a successful cut removes the words, nothing is covering them');
});

test('known-positive: the same cover IS counted once the target stops matching', async () => {
  // Guards the test above against passing for free (a witness stuck at 0).
  const { doc, page, srcPage } = await freshDoc();
  const t = realTarget(srcPage);
  addEditCover(doc, page, { ...t, x0: t.x0 + 500, y0: t.y0 + 500 });
  assert.equal((await coversPainted(doc)).n, 1);
});

test('a text annotation alone covers nothing', async () => {
  const { doc, page } = await freshDoc();
  ops.addAnnotation(doc, page.id, model.createAnnotation('text', {
    x: 20, y: 20, width: 100, height: 20, text: 'Halo', fontFamily: 'Helvetica', fontSize: 12, color: '#000000',
  }));
  assert.equal((await coversPainted(doc)).n, 0);
});

test('a throwing witness never breaks the export', async () => {
  const { doc, page } = await freshDoc();
  ops.addAnnotation(doc, page.id, model.createAnnotation('whiteout', { x: 40, y: 40, width: 120, height: 30 }));
  const bytes = await buildPdfBytes(doc, { PDFLib, fontkit, onCoverDrawn: () => { throw new Error('boom'); } });
  assert.ok(bytes.length > 100);
});
