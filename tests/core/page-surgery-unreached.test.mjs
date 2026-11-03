/*
 * page-surgery-unreached.test.mjs — an edit whose line is ALSO painted by
 * something the cut cannot reach must not be baked over that copy.
 * ============================================================================
 * Field reports 100500 ("Jatimpark Group", 2026-10-24) and 100504 ("Mr
 * Saturnino Antonio Morais", 2026-10-25): the re-baked page showed the new
 * words drawn over the old ones, and the rail said surgery {matched:true,
 * reason:'clean'} for both. 'clean' was true of the page's content stream,
 * which is the only thing the cut edits. It was false of the page.
 *
 * MECHANISM, reproduced here with constructed files (the reporters' files are
 * not ours to have): a second painter of the same words that the cut never
 * sees.
 *   - an annotation appearance (a FreeText box, a filled text field) over the
 *     line: pdf.js's text layer leaves it out, so the user taps the content
 *     copy, the cut removes it, the stamp lands, and the annotation keeps
 *     painting the original above everything (on screen: pdf.js paints it into
 *     the raster; in the file: every reader paints /Annots after the content);
 *   - a shadow copy inside a Form XObject, offset far enough (5pt at 14pt)
 *     that pdf.js groups it into a line of its own, so the edited line's only
 *     target is the content copy.
 *
 * WHAT WAS RULED OUT on the way, with the same harness (see the PR): a double
 * draw or shadow in the page's own stream, or in a Form XObject at a small
 * offset, yields a SECOND run on the line, which the cut cannot claim, so the
 * edit already declines as 'no-match'. Type0 / Identity-H and simple TrueType
 * cut identically. Every line of every tests/fixtures/nasty file cuts 'clean'
 * with nothing left in its box, except one line a form widget overlaps.
 *
 * The witness is pdf.js reading the baked bytes back, never our own walker:
 * a verifier must not share a parent with the verified.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as model from '../../js/core/model.js';
import * as ops from '../../js/core/operations.js';
import { buildEditedPageBytes } from '../../js/core/page-surgery.js';
import { buildPdfBytes } from '../../js/core/export.js';
import { groupRunsIntoLines } from '../../js/core/text-lines.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};
const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
globalThis.pdfjsWorker = loadUmd('js/vendor/pdf.worker.min.js');
const pdfjs = loadUmd('js/vendor/pdf.min.js');
const { PDFName, PDFString, PDFArray } = PDFLib;

const TTF = fs.readFileSync(path.join(root, 'tests', 'fixtures', 'carlito-latin.ttf'));
const NEW = 'Nama Baru';
const SIZE = 14;
const AT = [72, 700];

// ---- fixtures: one page, the subject line in the page's own content ---------

// `extra(api)` adds the second painter. The subject is drawn in an embedded
// Type0 / Identity-H font (report 100500's flavor), as raw operators.
async function buildPdf(subject, extra = () => {}) {
  const d = await PDFLib.PDFDocument.create();
  d.registerFontkit(fontkit);
  const page = d.addPage([400, 800]);
  const font = await d.embedFont(TTF, { subset: false });
  const key = page.node.newFontDictionary('F1', font.ref);
  const hex = (s) => font.encodeText(s).toString();
  const ctx = d.context;
  const fontRes = () => ctx.obj({ Font: { [key.decodeText()]: font.ref } });
  const raw = (str, dict) => ctx.register(ctx.flateStream(Uint8Array.from(str, (c) => c.charCodeAt(0)), dict));
  let content = `BT /${key.decodeText()} ${SIZE} Tf ${AT[0]} ${AT[1]} Td ${hex(subject)} Tj ET`;
  const api = {
    d, page, ctx, font, hex, key: key.decodeText(), fontRes, raw,
    prepend(ops) { content = `${ops} ${content}`; },
    append(ops) { content = `${content} ${ops}`; },
    form(name, str, dict = {}) {
      const ref = raw(str, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 400, 800], Resources: fontRes(), ...dict });
      page.node.setXObject(PDFName.of(name), ref); // the exact name the content's Do uses
      return ref;
    },
    annot(subtype, rect, apStr, dict = {}) {
      const ap = raw(apStr, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, rect[2] - rect[0], rect[3] - rect[1]], Resources: fontRes() });
      const ref = ctx.register(ctx.obj({ Type: 'Annot', Subtype: subtype, Rect: rect, F: 4, AP: { N: ap }, ...dict }));
      page.node.addAnnot(ref);
      return ref;
    },
  };
  await extra(api);
  page.node.set(PDFName.of('Contents'), raw(content, {}));
  return d.save({ useObjectStreams: false });
}

// ---- what the app does: tap a line of pdf.js's text layer, commit an edit ---

const norm = (x, y) => { const l = Math.hypot(x, y); return l ? [x / l, y / l] : [1, 0]; };

async function readBack(bytes) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 }).promise;
  const pg = await doc.getPage(1);
  const tc = await pg.getTextContent();
  // What pdf.js PAINTS (content, forms AND annotation appearances), as
  // strings. Render mode is graphics state: Tr 3/7 put no marks, and q/Q
  // (save/restore) scope it.
  const ol = await pg.getOperatorList();
  const painted = [];
  const { OPS } = pdfjs;
  let tr = 0;
  const saved = [];
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i];
    if (fn === OPS.save) saved.push(tr);
    else if (fn === OPS.restore) tr = saved.pop() ?? 0;
    else if (fn === OPS.setTextRenderingMode) [tr] = ol.argsArray[i];
    else if (fn === OPS.showText && tr !== 3 && tr !== 7) painted.push(ol.argsArray[i][0].map((g) => (g && g.unicode) || '').join(''));
  }
  await doc.destroy();
  return { items: tc.items.filter((it) => it.str && it.str.trim() && it.width), painted };
}

// js/v2/text-runs.js's run shape (the fields text-lines.js and surgery read).
function runsOf(items) {
  return items.map((it) => {
    const [ux, uy] = norm(it.transform[0], it.transform[1]);
    const size = Math.hypot(it.transform[2], it.transform[3]);
    return {
      str: it.str, x: it.transform[4], y: 800 - it.transform[5], w: it.width, h: size, size,
      fontName: it.fontName, fontFamily: '',
      pdf: { x0: it.transform[4], y0: it.transform[5], ux, uy, len: it.width, size },
    };
  });
}

// One Ganti edit of the tapped line, through the real pipeline. The tap is on
// the CONTENT copy's baseline (AT), as a user tapping the visible words would.
async function editLine(bytes) {
  const { items } = await readBack(bytes);
  const lines = groupRunsIntoLines(runsOf(items));
  const line = lines.find((l) => l.runs.some((r) => Math.abs(r.pdf.x0 - AT[0]) < 0.5 && Math.abs(r.pdf.y0 - AT[1]) < 0.5));
  assert.ok(line, 'VACUITY GUARD: the tapped line exists in pdf.js\'s text layer');
  model._resetIds();
  const srcDoc = await PDFLib.PDFDocument.load(bytes);
  const doc = model.createDoc();
  const source = ops.addSource(doc, model.createSource({ name: 'f.pdf', bytes, numPages: 1 }));
  const page = model.createPage({ source, sourcePageNum: 0, width: 400, height: 800, rotation: 0 });
  ops.addPages(doc, [page]);
  const box = { x: 70, y: 84, w: 260, h: 20 }; // view space (top-left), over the line
  const cover = model.createAnnotation('whiteout', {
    x: box.x, y: box.y, width: box.w, height: box.h,
    replaceTargets: line.runs.map((r) => r.pdf), replaceBox: { ...box },
  });
  ops.addAnnotation(doc, page.id, cover);
  const text = model.createAnnotation('text', {
    x: box.x, y: box.y, width: 200, height: 20, text: NEW, fontFamily: 'Helvetica', fontSize: SIZE, color: '#000000',
    replaceCoverId: cover.id,
  });
  ops.addAnnotation(doc, page.id, text);
  const res = await buildEditedPageBytes(srcDoc, page, page.annotations, { PDFLib, fontkit });
  return { res, cover, doc, line };
}

// The law this file pins, stated on pixels' source: a baked page never paints
// the old words, and when the edit could not be baked cleanly it declines.
async function assertNoOldWordsUnderNew(bytes, oldWord) {
  const before = await readBack(bytes);
  assert.ok(before.painted.filter((s) => s.includes(oldWord)).length >= 2,
    'VACUITY GUARD: the source really paints the old words twice (content + the other painter)');
  const { res, cover } = await editLine(bytes);
  if (res.bytes) {
    const after = await readBack(res.bytes);
    const survivors = after.painted.filter((s) => s.includes(oldWord));
    assert.deepEqual(survivors, [], `the baked page still paints the old words under the new: ${JSON.stringify(after.painted)}`);
  }
  return { res, cover };
}

// ---- the reproductions -------------------------------------------------------

test('a FreeText annotation repeating the line: the edit declines as unreached, nothing is baked over it', async () => {
  const subject = 'Mr Saturnino Antonio Morais';
  const bytes = await buildPdf(subject, (a) => {
    a.annot('FreeText', [70, 695, 330, 717], `BT /${a.key} ${SIZE} Tf 2 5 Td ${a.hex(subject)} Tj ET`,
      { Contents: PDFString.of(subject), DA: PDFString.of(`/${a.key} ${SIZE} Tf 0 g`) });
  });
  const { res, cover } = await assertNoOldWordsUnderNew(bytes, 'Morais');
  assert.deepEqual(res.outcomes[0].surgery, { matched: false, reason: 'unreached' });
  assert.deepEqual(res.declined, [cover.id], 'the cover stays: it is what hides the annotation on screen');
});

test('a filled text field over the line (pdf-lib\'s own widget appearance): declines as unreached', async () => {
  const subject = 'Mr Saturnino Antonio Morais';
  const bytes = await buildPdf(subject, (a) => {
    const field = a.d.getForm().createTextField('nama');
    field.setText(subject);
    field.addToPage(a.page, { x: 70, y: 695, width: 260, height: 22, borderWidth: 0 });
  });
  const { res } = await assertNoOldWordsUnderNew(bytes, 'Morais');
  assert.deepEqual(res.outcomes[0].surgery, { matched: false, reason: 'unreached' });
});

test('a shadow copy in a Form XObject, on a line of its own: declines as unreached', async () => {
  const subject = 'Jatimpark Group';
  const bytes = await buildPdf(subject, (a) => {
    a.form('Sh', `q 0.7 g BT /${a.key} ${SIZE} Tf ${AT[0] + 2.5} ${AT[1] - 5} Td ${a.hex(subject)} Tj ET Q`);
    a.prepend('q /Sh Do Q');
  });
  const { line } = await editLine(bytes);
  assert.equal(line.runs.length, 1, 'VACUITY GUARD: pdf.js put the shadow on a line of its own');
  const { res } = await assertNoOldWordsUnderNew(bytes, 'Group');
  assert.deepEqual(res.outcomes[0].surgery, { matched: false, reason: 'unreached' });
});

test('the same shadow nested one form deeper, with the form\'s own Matrix: still found', async () => {
  const subject = 'Jatimpark Group';
  const bytes = await buildPdf(subject, (a) => {
    const inner = a.raw(`q 0.7 g BT /${a.key} ${SIZE} Tf 0 0 Td ${a.hex(subject)} Tj ET Q`,
      { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 400, 50], Resources: a.fontRes(), Matrix: [1, 0, 0, 1, AT[0] + 2.5, 0] });
    const outerRes = a.fontRes();
    outerRes.set(PDFName.of('XObject'), a.ctx.obj({ In: inner }));
    a.form('Out', '/In Do', { Resources: outerRes, Matrix: [1, 0, 0, 1, 0, AT[1] - 5] });
    a.prepend('q /Out Do Q');
  });
  const { res } = await assertNoOldWordsUnderNew(bytes, 'Group');
  assert.deepEqual(res.outcomes[0].surgery, { matched: false, reason: 'unreached' });
});

test('in the download, the declined edit\'s annotation is flattened under the cover, not left live over it', async () => {
  const subject = 'Mr Saturnino Antonio Morais';
  const bytes = await buildPdf(subject, (a) => {
    a.annot('FreeText', [70, 695, 330, 717], `BT /${a.key} ${SIZE} Tf 2 5 Td ${a.hex(subject)} Tj ET`);
  });
  const { doc } = await editLine(bytes);
  const out = await PDFLib.PDFDocument.load(await buildPdfBytes(doc, { PDFLib, fontkit }));
  const annots = out.getPages()[0].node.lookup(PDFName.of('Annots'));
  const live = annots instanceof PDFArray ? annots.asArray().map((r) => out.context.lookup(r).lookup(PDFName.of('Subtype'))?.decodeText()) : [];
  // A live annotation is painted ABOVE the content, i.e. above the cover and
  // the new words. Before the fix the edit was 'clean', its cover skipped, so
  // export.js left the FreeText live over the stamp.
  assert.ok(!live.includes('FreeText'), `the FreeText is still live over the new text: ${live}`);
});

// ---- not over-declining: the census is about TEXT the cut cannot reach -------

async function assertClean(bytes, oldWord) {
  const { res } = await editLine(bytes);
  assert.deepEqual(res.outcomes[0].surgery, { matched: true, reason: 'clean' });
  assert.ok(res.bytes, 'baked');
  const after = await readBack(res.bytes);
  assert.ok(!after.painted.some((s) => s.includes(oldWord)), 'the old words are gone from the bake');
  assert.ok(after.painted.some((s) => s.includes(NEW)), 'the new words are stamped');
}

test('control: the bare line cuts clean and the stamp replaces it', async () => {
  await assertClean(await buildPdf('Jatimpark Group'), 'Group');
});

test('control: a highlight (an appearance with no text) over the line keeps the edit clean', async () => {
  const bytes = await buildPdf('Jatimpark Group', (a) => {
    a.annot('Highlight', [70, 695, 200, 717], '1 1 0 rg 0 0 130 22 re f');
  });
  await assertClean(bytes, 'Group');
});

test('control: a text annotation elsewhere on the page, and a Form XObject with text elsewhere, change nothing', async () => {
  const bytes = await buildPdf('Jatimpark Group', (a) => {
    a.annot('FreeText', [70, 100, 330, 122], `BT /${a.key} ${SIZE} Tf 2 5 Td ${a.hex('Catatan')} Tj ET`);
    a.form('Hd', `BT /${a.key} 10 Tf 72 760 Td ${a.hex('Kop surat')} Tj ET`);
    a.prepend('q /Hd Do Q');
  });
  await assertClean(bytes, 'Group');
});

test('control: an invisible (Tr 3) copy in a Form XObject over the line keeps the edit clean', async () => {
  const subject = 'Jatimpark Group';
  const bytes = await buildPdf(subject, (a) => {
    a.form('Ocr', `BT 3 Tr /${a.key} ${SIZE} Tf ${AT[0] + 2.5} ${AT[1] - 5} Td ${a.hex(subject)} Tj ET`);
    a.prepend('q /Ocr Do Q');
  });
  await assertClean(bytes, 'Group');
});
