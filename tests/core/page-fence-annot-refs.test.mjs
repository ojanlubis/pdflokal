/*
 * AN ANNOTATION ON A PAGE THE USER DID NOT KEEP IS NOT INSIDE THE DOWNLOAD.
 * ============================================================================
 * core/page-fence.js stopped copyPages from following a kept page's
 * references into a page or the page tree, but one annotation can point at
 * another: a reply's /IRT, a markup's /Popup, a popup's /Parent, and chains
 * of them. A reply on page 1 to a note on page 5 shipped page 5's note, with
 * its text, as an orphan object when only pages 1-2 were exported (review of
 * 5245a21, probe C). The reference is cut on the KEPT side: the kept
 * annotation still ships, it just no longer points at the removed one.
 *
 * Checked through the parser, never by grepping bytes: the output uses object
 * streams (bank: strings-cannot-read-a-pdf).
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
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};
const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
const { PDFName, PDFString, PDFDict, PDFRef } = PDFLib;
const N = 5;
const MARK = PDFName.of('PLMark');
const SECRET = 'catatan rahasia halaman lima';

// N pages marked H1..H5. `build(s, pages, annotsOn)` adds annotations;
// annotsOn[i] collects the refs listed in page i's /Annots.
async function source(build) {
  const s = await PDFLib.PDFDocument.create();
  const pages = [];
  for (let i = 0; i < N; i += 1) {
    const p = s.addPage([595, 842]);
    p.node.set(MARK, PDFString.of(`H${i + 1}`));
    pages.push(p);
  }
  const annotsOn = pages.map(() => []);
  const reg = (dict) => s.context.register(s.context.obj({ Type: 'Annot', Rect: [0, 0, 10, 10], ...dict }));
  build({ s, pages, annotsOn, reg });
  annotsOn.forEach((list, i) => { if (list.length) pages[i].node.set(PDFName.of('Annots'), s.context.obj(list)); });
  return s.save();
}

async function exportOf(bytes, order) {
  const doc = model.createDoc();
  const src = ops.addSource(doc, model.createSource({ name: 's.pdf', bytes, numPages: N }));
  ops.addPages(doc, order.map((n) => model.createPage({ source: src, sourcePageNum: n, width: 595, height: 842 })));
  const out = await buildPdfBytes(doc, { PDFLib, fontkit });
  return PDFLib.PDFDocument.load(out);
}

function markers(d) {
  return d.context.enumerateIndirectObjects()
    .map(([, o]) => (o instanceof PDFDict ? o.get(MARK) : null))
    .filter(Boolean).map((m) => m.decodeText()).sort();
}

// Every indirect object of the output, printed by the parser: a removed
// annotation's text cannot hide in any of them.
function holdsSecret(d) {
  return d.context.enumerateIndirectObjects().some(([, o]) => String(o).includes(SECRET));
}

function annotsOfOutputPage(d, i) {
  return d.getPages()[i].node.Annots().asArray().map((r) => [r, d.context.lookup(r, PDFDict)]);
}

const note = (pageRef, mark, extra = {}) => ({
  Subtype: 'Text', P: pageRef, PLMark: PDFString.of(mark), Contents: PDFString.of(SECRET), ...extra,
});

test('a reply on a kept page to a note on a removed page does not ship the note (/IRT)', async () => {
  const bytes = await source(({ pages, annotsOn, reg }) => {
    const far = reg(note(pages[4].ref, 'A5'));
    annotsOn[4].push(far);
    annotsOn[0].push(reg({ Subtype: 'Text', P: pages[0].ref, PLMark: PDFString.of('R1'), IRT: far }));
  });
  const d = await exportOf(bytes, [0, 1]);
  assert.deepEqual(markers(d), ['H1', 'H2', 'R1'], 'KNOWN-POSITIVE R1: the reply itself ships; A5 must not');
  assert.equal(holdsSecret(d), false, 'the removed page\'s note text is nowhere in the file');
  const [, reply] = annotsOfOutputPage(d, 0)[0];
  assert.ok(!(reply.get(PDFName.of('IRT')) instanceof PDFRef), 'the reply no longer points at the removed note');
});

test('a popup chain that lands on a removed page does not ship it (/Popup -> /Parent)', async () => {
  const bytes = await source(({ pages, annotsOn, reg }) => {
    const farNote = reg(note(pages[4].ref, 'A5'));
    const farPopup = reg({ Subtype: 'Popup', P: pages[4].ref, Parent: farNote, PLMark: PDFString.of('P5') });
    annotsOn[4].push(farNote, farPopup);
    annotsOn[0].push(reg({ Subtype: 'Square', P: pages[0].ref, PLMark: PDFString.of('S1'), Popup: farPopup }));
  });
  const d = await exportOf(bytes, [0, 1]);
  assert.deepEqual(markers(d), ['H1', 'H2', 'S1']);
  assert.equal(holdsSecret(d), false);
});

test('a two-hop chain through an annotation listed on no page does not ship the far note', async () => {
  const bytes = await source(({ pages, annotsOn, reg }) => {
    const far = reg(note(pages[4].ref, 'A5'));
    annotsOn[4].push(far);
    // Listed on no page at all; known to live on page 4 only by its /P.
    const mid = reg({ Subtype: 'Text', P: pages[3].ref, PLMark: PDFString.of('M4'), Contents: PDFString.of(SECRET), IRT: far });
    // Listed on no page and carrying no /P: nothing says where it lives, so
    // it ships, but the far note behind it still must not.
    const loose = reg({ Subtype: 'Text', PLMark: PDFString.of('L'), IRT: far });
    annotsOn[0].push(reg({ Subtype: 'Text', P: pages[0].ref, PLMark: PDFString.of('R1'), IRT: mid }));
    annotsOn[0].push(reg({ Subtype: 'Text', P: pages[0].ref, PLMark: PDFString.of('R2'), IRT: loose }));
  });
  const d = await exportOf(bytes, [0, 1]);
  assert.deepEqual(markers(d), ['H1', 'H2', 'L', 'R1', 'R2']);
  assert.equal(holdsSecret(d), false);
});

test('a reply to a note on a page that WAS kept keeps pointing at that note', async () => {
  const bytes = await source(({ pages, annotsOn, reg }) => {
    const near = reg({ Subtype: 'Text', P: pages[1].ref, PLMark: PDFString.of('A2') });
    annotsOn[1].push(near);
    annotsOn[0].push(reg({ Subtype: 'Text', P: pages[0].ref, PLMark: PDFString.of('R1'), IRT: near }));
  });
  const d = await exportOf(bytes, [1, 0]);
  assert.deepEqual(markers(d), ['A2', 'H1', 'H2', 'R1'], 'each once: no orphan copy of the note either');
  const [noteRef] = annotsOfOutputPage(d, 0)[0];
  const [, reply] = annotsOfOutputPage(d, 1)[0];
  assert.equal(reply.get(PDFName.of('IRT'))?.toString(), noteRef.toString(), '/IRT names the note on output page 1');
});
