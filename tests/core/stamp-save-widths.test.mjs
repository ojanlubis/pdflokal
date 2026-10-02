/*
 * A DOC FONT WHOSE GLYPH DATA RUNS PAST ITS BYTES MUST DECLINE RUNG 1, NOT
 * KILL THE BAKE (OR THE EXPORT).
 * ============================================================================
 * Sentry JAVASCRIPT-17, 2026-10-01, tag stage:commit-bake (the first event the
 * PR #142 witness ever caught): `RangeError: Trying to access beyond buffer
 * length`, thrown from pdf-lib's CIDFont embedder (computeWidths) into fontkit
 * (advanceWidth -> glyph header -> readInt16BE). The rail's 33 export
 * RangeErrors (09-24..29, zero files) are the same family.
 *
 * Without `{subset:true}` pdf-lib writes the /W array for EVERY code point in
 * the font's cmap, reading each glyph's advance from its glyf header. A subset
 * whose loca points past the end of the font bytes (a truncated or damaged
 * FontFile2 stream) parses, passes every descriptor field fontEmbedsAtSave
 * used to check, embeds, draws, and only throws inside save(), outside every
 * try in core/stamp.js. Sibling of stamp-lazy-embed.test.mjs (missing `post`).
 *
 * The damage is built here from a bundled TTF and from the fixture's own
 * embedded program, never typed as bytes: only loca entries of glyphs the
 * stamped text does NOT use are pointed past the end, so the stamp itself
 * draws fine and the throw lands exactly where production saw it.
 *
 * Without the guard (measured): test 1 and test 3 fail, test 3 with the
 * production RangeError; test 2 is the control and passes either way. With it:
 * all pass.
 *
 * SCOPE, stated so nobody over-reads it: this covers the glyph-OUTLINE reads
 * pdf-lib does at save() (the production stack: computeWidths -> advanceWidth ->
 * glyph header). A font whose GSUB/GPOS region is truncated throws from a
 * different place (fontkit's layout, `lookupsForFeatures`) at drawText, not at
 * save(); seen synthetically, never in the corpus or on the rail, and not
 * covered here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as model from '../../js/core/model.js';
import * as ops from '../../js/core/operations.js';
import { buildEditedPageBytes } from '../../js/core/page-surgery.js';
import { fontEmbedsAtSave, nativeCandidate } from '../../js/core/stamp.js';
import { extractFontMetrics, readPageContents } from '../../js/core/redact.js';
import { walkShowOps } from '../../js/core/text-walk.js';
import { extractFontProgram } from '../../js/core/doc-fonts.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};
const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

// Point the loca entries of `ids` far past the end of the font. Only `loca`
// bytes change; every table fontEmbedsAtSave used to read is untouched.
function withLocaPastEnd(bytes, ids) {
  const parsed = fontkit.create(bytes);
  const loca = parsed.directory.tables.loca;
  const long = parsed.head.indexToLocFormat === 1;
  const out = new Uint8Array(bytes); // a copy
  const dv = new DataView(out.buffer);
  for (const g of ids) {
    if (long) dv.setUint32(loca.offset + g * 4, 0x7ffffff0);
    else dv.setUint16(loca.offset + g * 2, 0xfff0);
  }
  return out;
}

// Glyph ids to damage: some glyphs in the cmap that `keep` does not need.
function damageIds(parsed, keep) {
  const needed = new Set([...keep].map((ch) => parsed.glyphForCodePoint(ch.codePointAt(0)).id));
  const ids = [...new Set(parsed.characterSet.map((cp) => parsed.glyphForCodePoint(cp).id))]
    .filter((id) => id > 2 && !needed.has(id) && !needed.has(id - 1));
  assert.ok(ids.length >= 1, 'need at least one glyph to damage');
  return ids.slice(-3);
}

test('a font with glyph data past its bytes embeds and draws, then THROWS at save(), and the guard sees it', async () => {
  const good = new Uint8Array(fs.readFileSync(path.join(root, 'fonts/ttf/arimo-regular.ttf')));
  assert.equal(fontEmbedsAtSave(fontkit.create(good)), true, 'a healthy font must pass');

  const bad = withLocaPastEnd(good, damageIds(fontkit.create(good), 'Ab'));
  const parsed = fontkit.create(bad); // fontkit parses it happily
  const doc = await PDFLib.PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(bad); // no throw here
  doc.addPage().drawText('Ab', { font, size: 12 }); // nor here
  await assert.rejects(() => doc.save(), (e) => e instanceof RangeError && /beyond buffer length/.test(e.message));

  assert.equal(fontEmbedsAtSave(parsed), false);
  assert.equal(nativeCandidate({ parsed, bytes: bad, key: 'F1' }), null, 'the editor must not offer it either');
  assert.equal(fontEmbedsAtSave(parsed), false, 'the memoised answer is stable');
});

// undangan-cid.pdf record 3 = the middle "Rapat Anggota Tahunan 2026" (same
// geometry page-surgery-edited.test.mjs pins). Its embedded Montserrat subset
// has its glyph data damaged in memory, in the SOURCE doc handed to the bake.
async function bakeWithDamagedProgram(damage) {
  const fixture = fs.readFileSync(path.join(root, 'tests/fixtures/nasty/undangan-cid.pdf'));
  const srcDoc = await PDFLib.PDFDocument.load(fixture);
  const srcPage = srcDoc.getPages()[0];
  const rec = walkShowOps(readPageContents(srcPage, PDFLib), extractFontMetrics(srcPage, PDFLib))[3];
  const text = 'Rapat Baru';

  if (damage) {
    const { PDFName, PDFRef } = PDFLib;
    const context = srcDoc.context;
    const res = (v) => (v instanceof PDFRef ? context.lookup(v) : v);
    const fontObj = res(res(srcPage.node.Resources().get(PDFName.of('Font'))).get(PDFName.of(rec.fontName)));
    const desc0 = res(res(fontObj.get(PDFName.of('DescendantFonts'))).asArray()[0]);
    const fd = res(desc0.get(PDFName.of('FontDescriptor')));
    const fileRef = fd.get(PDFName.of('FontFile2'));
    const program = extractFontProgram(srcPage, PDFLib, rec.fontName);
    assert.ok(program.ok);
    const parsed = fontkit.create(program.bytes);
    const broken = withLocaPastEnd(program.bytes, damageIds(parsed, text));
    context.assign(fileRef, context.flateStream(broken, { Length1: broken.length }));
  }

  const { width, height } = srcPage.getSize();
  const doc = model.createDoc();
  const source = ops.addSource(doc, model.createSource({ name: 'undangan-cid.pdf', bytes: fixture, numPages: 1 }));
  const page = model.createPage({ source, sourcePageNum: 0, width, height, rotation: 0 });
  ops.addPages(doc, [page]);
  const target = { x0: rec.x, y0: rec.y, ux: rec.ux, uy: rec.uy, size: rec.size, len: 300 };
  const cover = model.createAnnotation('whiteout', {
    x: 0, y: 0, width: 10, height: 10,
    replaceTargets: [target], replaceBox: { x: 0, y: 0, w: 10, h: 10 },
  });
  ops.addAnnotation(doc, page.id, cover);
  const anno = model.createAnnotation('text', {
    x: 0, y: 0, width: 200, height: 20, text, fontFamily: 'Helvetica', fontSize: 12, color: '#000000',
    replaceCoverId: cover.id,
  });
  ops.addAnnotation(doc, page.id, anno);
  return { result: await buildEditedPageBytes(srcDoc, page, page.annotations, { PDFLib, fontkit }), anno };
}

test('control: the same bake on the UNDAMAGED fixture stamps natively (the test can tell the two apart)', async () => {
  const { result, anno } = await bakeWithDamagedProgram(false);
  assert.ok(result.applied.has(anno.id));
  assert.equal(result.outcomes[0].insert.path, 'native');
});

test('a bake whose doc font cannot be written at save() declines to a later rung and still returns bytes', async () => {
  const { result, anno } = await bakeWithDamagedProgram(true);
  assert.ok(result.bytes, 'the bake must produce bytes, not throw from save()');
  assert.equal(Buffer.from(result.bytes.subarray(0, 5)).toString(), '%PDF-');
  assert.notEqual(result.outcomes[0].insert?.path, 'native', 'rung 1 must decline a font pdf-lib cannot write');
  // Headless there is no fetch for the bundled clone fonts, so the replacement
  // falls to the twin overlay; the cut itself (the cover) is still applied.
  assert.deepEqual(result.declined, []);
  assert.equal(result.outcomes[0].insert?.path, 'twin');
  assert.equal(result.applied.has(anno.id), false);
  const reload = await PDFLib.PDFDocument.load(result.bytes);
  assert.equal(reload.getPageCount(), 1);
});
