/*
 * Rung D — whole-paragraph edit (core/block-edit.js), headless.
 * ============================================================================
 * Three layers, each red on revert of the code it pins:
 *   1. planBlockEdit: a provable block opens (alignment, box, leading, the
 *      display mapping the editor is placed by) and every decline reason fires
 *      on the case it names, and only there.
 *   2. placeBlockLines: stored lines -> PDF positions. Justified lines end on
 *      the box's right edge in the drawing font; baselines step by the block's
 *      leading; the last line and hard-broken lines are not stretched.
 *   3. THE ROUND TRIP on a real PDF (tests/fixtures/nasty/paragraf-badan.pdf,
 *      Montserrat embedded whole): runs -> lines -> block -> plan -> painted
 *      breaks -> buildEditedPageBytes -> pdf.js reads the result back. The new
 *      text is there, line for line, at the block's own baselines and inside
 *      its box; the paragraph's original words are gone; the paragraph below
 *      is untouched.
 *
 * pdf.js is the SAME vendored build the product ships, loaded in-realm the way
 * the corpus probes load it (a second parser would be a second implementation).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  planBlockEdit, placeBlockLines, blockAnnotation, prefillText, blockOfLine, blockExtent, logicalTextOf,
  BLOCK_DECLINE_REASONS,
} from '../../js/core/block-edit.js';
import { wrapText } from '../../js/core/reflow.js';
import { SCHEMA, validateEvent } from '../../js/core/telemetry-schema.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---- synthetic lines ----------------------------------------------------------
// Unrotated A4 at display scale K: display x = K*x, display baseline y =
// K*(842 - y). Each line is one run unless `runs` says otherwise.
const K = 1.5;
const PAGE_H = 842;
function mkRun(str, x0, y0, len, size) {
  return {
    str,
    size: size * K,
    org: { x: K * x0, y: K * (PAGE_H - y0) },
    x: K * x0,
    y: K * (PAGE_H - y0 - size),
    w: K * len,
    h: K * size * 1.25,
    pdf: { x0, y0, ux: 1, uy: 0, len, size },
  };
}
function mkLine(str, x0, y0, len, size = 11, extraRuns = []) {
  const runs = [mkRun(str, x0, y0, len, size), ...extraRuns];
  return {
    str,
    x: K * x0,
    y: K * (PAGE_H - y0 - size),
    w: K * len,
    h: K * size * 1.25,
    size: size * K,
    pdf: { x0, y0, ux: 1, uy: 0, len, size },
    runs,
    blockId: 0,
  };
}
function blockOf(lines) {
  const x = Math.min(...lines.map((l) => l.x));
  const y = Math.min(...lines.map((l) => l.y));
  return {
    id: 0,
    lines,
    bbox: { x, y, w: Math.max(...lines.map((l) => l.x + l.w)) - x, h: Math.max(...lines.map((l) => l.y + l.h)) - y },
  };
}
// A justified paragraph: three lines 72..372, a short last line.
function justified() {
  return [
    mkLine('Lorem ipsum dolor sit amet consectetur', 72, 700, 300),
    mkLine('adipiscing elit sed do eiusmod tempor', 72, 685, 300),
    mkLine('incididunt ut labore et dolore magna', 72, 670, 300),
    mkLine('aliqua.', 72, 655, 40),
  ];
}

test('1. a justified paragraph opens: alignment, box, leading, size, origin, display mapping', () => {
  const lines = justified();
  const r = planBlockEdit(blockOf(lines), lines);
  assert.equal(r.ok, true, r.reason);
  const { plan } = r;
  assert.equal(plan.align, 'justify');
  assert.equal(plan.indent, 0);
  assert.ok(Math.abs(plan.width - 300) < 1, `box width ${plan.width}`);
  assert.equal(plan.leading, 15);
  assert.equal(plan.size, 11);
  assert.deepEqual(plan.origin, { x: 72, y: 700 });
  assert.equal(plan.k, K);
  // The editor is placed by `disp`: the display point of the box's left edge
  // on the FIRST baseline — exactly where the first run's own origin is.
  assert.deepEqual(plan.disp, lines[0].runs[0].org);
  assert.equal(plan.srcLines, 4);
  assert.equal(plan.targets.length, 4, 'one surgery target per run');
  assert.equal(plan.text, 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.');
});

test('2. ragged right is left; ragged left is right; a first-line indent is carried', () => {
  const left = [
    mkLine('Lorem ipsum dolor sit amet', 72, 700, 280),
    mkLine('consectetur adipiscing elit sed', 72, 685, 265),
    mkLine('do eiusmod tempor', 72, 670, 150),
  ];
  assert.equal(planBlockEdit(blockOf(left), left).plan.align, 'left');

  const right = [
    mkLine('Lorem ipsum dolor sit amet', 92, 700, 280),
    mkLine('consectetur adipiscing elit sed', 100, 685, 272),
    mkLine('do eiusmod tempor', 222, 670, 150),
  ];
  const r = planBlockEdit(blockOf(right), right);
  assert.equal(r.plan.align, 'right');
  assert.equal(r.plan.origin.x, 92);

  const indented = [
    mkLine('Lorem ipsum dolor sit amet', 72 + 22, 700, 278),
    mkLine('consectetur adipiscing elit sed do', 72, 685, 300),
    mkLine('eiusmod tempor incididunt ut labore', 72, 670, 300),
    mkLine('magna.', 72, 655, 40),
  ];
  const ind = planBlockEdit(blockOf(indented), indented).plan;
  assert.equal(ind.align, 'justify');
  assert.equal(ind.indent, 22);
  assert.equal(ind.origin.x, 72);
});

test('3. each decline reason fires on its case (and the enum matches the telemetry schema)', () => {
  assert.deepEqual(SCHEMA.block_edit.decline_reason, BLOCK_DECLINE_REASONS);

  // rotated: a run off the horizontal, or a rotated page
  const rot = justified();
  rot[1].runs[0].pdf = { ...rot[1].runs[0].pdf, ux: 0.9, uy: 0.43 };
  assert.deepEqual(planBlockEdit(blockOf(rot), rot), { ok: false, reason: 'rotated' });
  const flat = justified();
  assert.deepEqual(planBlockEdit(blockOf(flat), flat, { rotation: 90 }), { ok: false, reason: 'rotated' });

  // mixed-sizes: a superscript marker run inside a line
  const sup = justified();
  sup[1].runs.push(mkRun('1', 380, 690, 4, 7));
  assert.deepEqual(planBlockEdit(blockOf(sup), sup), { ok: false, reason: 'mixed-sizes' });

  // list: the first line starts with a marker
  const list = justified();
  list[0] = mkLine('1. Lorem ipsum dolor sit amet consectetur', 72, 700, 300);
  assert.deepEqual(planBlockEdit(blockOf(list), list), { ok: false, reason: 'list' });

  // align-unknown: neither edge agrees
  const ragged = [
    mkLine('Lorem ipsum dolor', 72, 700, 200),
    mkLine('sit amet consectetur adipiscing', 110, 685, 260),
    mkLine('elit sed do', 90, 670, 90),
  ];
  assert.deepEqual(planBlockEdit(blockOf(ragged), ragged), { ok: false, reason: 'align-unknown' });

  // columns: another line (not in the block) sits inside the block's band,
  // off the block's baselines
  const para = justified();
  const intruder = { ...mkLine('Kolom', 300, 692, 40), blockId: null };
  assert.deepEqual(planBlockEdit(blockOf(para), [...para, intruder]), { ok: false, reason: 'columns' });
  // ...a SMALLER one there is a footnote marker inside the paragraph
  const marker = { ...mkLine('2', 372, 690, 4, 7), blockId: null };
  assert.deepEqual(planBlockEdit(blockOf(para), [...para, marker]), { ok: false, reason: 'mixed-sizes' });

  // not-prose: a column of numbers / one-word cells
  const nums = [mkLine('15', 72, 700, 10), mkLine('694', 72, 685, 15), mkLine('850', 72, 670, 15)];
  assert.deepEqual(planBlockEdit(blockOf(nums), nums), { ok: false, reason: 'not-prose' });

  // not-prose: a table of contents (dot leaders to page numbers)
  const toc = justified().map((l) => mkLine(`${l.str.slice(0, 20)} ........................ 1`, 72, l.pdf.y0, l.pdf.len));
  assert.deepEqual(planBlockEdit(blockOf(toc), toc), { ok: false, reason: 'not-prose' });
  // list: multi-level numbering
  const num = justified();
  num[0] = mkLine('14.1 Lorem ipsum dolor sit amet consectetur', 72, 700, 300);
  assert.deepEqual(planBlockEdit(blockOf(num), num), { ok: false, reason: 'list' });

  // list: a column of form values
  const values = [
    mkLine(': Staf Administrasi Umum', 140, 700, 120), mkLine(': 3201234567890001 nomor', 140, 685, 120),
    mkLine(': Budi Santoso', 140, 670, 80),
  ];
  assert.deepEqual(planBlockEdit(blockOf(values), values), { ok: false, reason: 'list' });
  // list: the line above is this item's marker line, hanging at the margin
  const tail = justified().map((l) => mkLine(l.str, 92, l.pdf.y0, l.pdf.len - 20));
  const itemHead = { ...mkLine('(3) Peraturan Pemerintah Daerah yang dimaksud', 72, 715, 300), blockId: null };
  assert.deepEqual(planBlockEdit(blockOf(tail), [...tail, itemHead]), { ok: false, reason: 'list' });

  // not-prose: stacked labels — each line ends with room for the next word
  const labels = [
    mkLine('Warga Negara Indonesia', 72, 700, 130), mkLine('Warga Negara Asing', 72, 685, 95),
    mkLine('Dwi Kewarganegaraan', 72, 670, 110),
  ];
  assert.deepEqual(planBlockEdit(blockOf(labels), labels), { ok: false, reason: 'not-prose' });

  // list: a marker the soft split cut off, on the first line's baseline
  const item = justified();
  const cut = { ...mkLine('1)', 52, 700, 10), blockId: null };
  assert.deepEqual(planBlockEdit(blockOf(item), [...item, cut]), { ok: false, reason: 'list' });

  // heading: the first line in its own face over a body that shares one
  const head = justified().map((l, i) => ({ ...l, fontName: i === 0 ? 'g_d0_f3' : 'g_d0_f2' }));
  assert.deepEqual(planBlockEdit(blockOf(head), head), { ok: false, reason: 'heading' });
  // ...but a line beside the box, or below it, is not a column
  const beside = { ...mkLine('Kolom', 400, 685, 40), blockId: null };
  const below = { ...mkLine('Penutup', 72, 600, 80), blockId: null };
  const ok = planBlockEdit(blockOf(para), [...para, beside, below]);
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.plan.below, below.y, 'the nearest line under the block is the grow-down limit');
});

test('3b. a justified line cut in two by the column guard is absorbed: its far piece joins the line', () => {
  const lines = justified();
  // Line 1 arrives as two Lines: 72..250 in the block, 270..372 left out.
  lines[1] = mkLine('adipiscing elit sed do', 72, 685, 178);
  const piece = { ...mkLine('eiusmod tempor', 270, 685, 102), blockId: null };
  const r = planBlockEdit(blockOf(lines), [...lines, piece]);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.plan.align, 'justify', 'with its piece back, line 1 reaches the right edge again');
  assert.equal(r.plan.targets.length, 5, 'the piece is cut too');
  assert.ok(r.plan.text.includes('adipiscing elit sed do eiusmod tempor incididunt'));
});

test('4. prefill joins lines with a space, a hyphenated line end with none, drops a soft hyphen', () => {
  assert.equal(prefillText([{ str: 'kerja ' }, { str: ' bakti' }]), 'kerja bakti');
  assert.equal(prefillText([{ str: 'sehari-' }, { str: 'hari' }]), 'sehari-hari');
  assert.equal(prefillText([{ str: 'pemerin­' }, { str: 'tahan' }]), 'pemerintahan');
});

test('5. blockOfLine regroups a tapped line with its paragraph; a non-block line has none', () => {
  const lines = justified();
  const loose = { ...mkLine('Penutup', 72, 600, 80), blockId: null };
  const all = [...lines, loose];
  assert.equal(blockOfLine(all, lines[2]).lines.length, 4);
  assert.equal(blockOfLine(all, loose), null);
});

// Fake measurer, 5 units per char: positions are exact numbers.
const W5 = (s) => s.length * 5;
function storedBlock(lines, over = {}) {
  return {
    v: 1, align: 'justify', indent: 0, width: 200, leading: 15, size: 10,
    origin: { x: 72, y: 700 }, k: 1, disp: { x: 72, y: 142 }, srcLines: 3, srcWords: null,
    lines, reflowed: true, ...over,
  };
}

test('6. placeBlockLines: justified lines end on the box edge, baselines step by leading, last line unstretched', () => {
  const block = storedBlock([
    { text: 'aaaa bbbb cccc', hard: false }, // 70 wide, 2 gaps -> extra 65 each
    { text: 'dd ee', hard: true }, // hard break: not stretched
    { text: 'ffff gg', hard: false }, // last: not stretched
  ]);
  const placed = placeBlockLines(block, W5);
  assert.deepEqual(placed.map((l) => l.y), [700, 685, 670]);
  const [l0, l1, l2] = placed;
  assert.deepEqual(l0.segments.map((s) => s.text), ['aaaa ', 'bbbb ', 'cccc']);
  assert.deepEqual(l0.segments.map((s) => s.x), [72, 72 + 25 + 65, 72 + 50 + 130]);
  const end = l0.segments.at(-1).x + W5('cccc');
  assert.equal(end, 72 + 200, 'a justified line ends exactly on the box right edge');
  assert.deepEqual(l1.segments, [{ text: 'dd ee', x: 72 }]);
  assert.deepEqual(l2.segments, [{ text: 'ffff gg', x: 72 }]);

  // right alignment: every line's end on the right edge
  const right = placeBlockLines(storedBlock(block.lines, { align: 'right' }), W5);
  right.forEach((l) => assert.equal(l.x + W5(l.text), 72 + 200));

  // first-line indent: line 0 starts indented and still ends on the edge
  const ind = placeBlockLines(storedBlock(block.lines, { indent: 20 }), W5);
  assert.equal(ind[0].segments[0].x, 92);
  assert.equal(ind[0].segments.at(-1).x + W5('cccc'), 272);

  // an empty line (two typed breaks) advances the baseline and draws nothing
  const gap = placeBlockLines(storedBlock([{ text: 'aa', hard: true }, { text: '', hard: true }, { text: 'bb', hard: false }]), W5);
  assert.deepEqual(gap.map((l) => [l.y, l.segments.length]), [[700, 1], [685, 0], [670, 1]]);
});

test('7. the editor and the file share one geometry: line i baseline = disp.y + i*k*leading in display px', () => {
  const lines = justified();
  const { plan } = planBlockEdit(blockOf(lines), lines);
  const block = blockAnnotation(plan, [{ text: 'a b', hard: false }, { text: 'c d', hard: false }, { text: 'e', hard: false }]);
  const placed = placeBlockLines(block, W5);
  placed.forEach((l, i) => {
    const dispBaseline = block.disp.y - block.k * (l.y - block.origin.y);
    assert.ok(Math.abs(dispBaseline - (plan.disp.y + i * K * plan.leading)) < 1e-9);
  });
  // The editor's box: width k*width, one k*leading per painted line.
  const ext = blockExtent(block, 10);
  assert.equal(ext.w, K * plan.width);
  assert.equal(ext.h, 3 * K * 15);
});

test('8. reflowed: same breaks and word counts is not a reflow; a moved break is', () => {
  const lines = justified();
  const { plan } = planBlockEdit(blockOf(lines), lines);
  const same = lines.map((l, i) => ({ text: l.str.replace('dolor', 'DOLOR'), hard: false, i }));
  assert.equal(blockAnnotation(plan, same).reflowed, false);
  const moved = [{ text: 'Lorem ipsum dolor sit amet', hard: false }, ...same.slice(1)];
  assert.equal(blockAnnotation(plan, moved).reflowed, true);
});

test('9. telemetry: block_edit validates, decline_reason optional, insert accepts block props additively', () => {
  assert.equal(validateEvent('block_edit', { outcome: 'open', block_lines: 4 }).ok, true);
  assert.equal(validateEvent('block_edit', { outcome: 'decline', decline_reason: 'columns', block_lines: 4 }).ok, true);
  assert.equal(validateEvent('block_edit', { outcome: 'decline', decline_reason: 'nope', block_lines: 4 }).ok, false);
  const base = { path: 'native', reason: 'clean', style_source: 'none', glyph_shortfall: 0 };
  // An old client's insert (no block props) still lands; a new one with them too.
  assert.equal(validateEvent('insert', base).ok, true);
  assert.equal(validateEvent('insert', { ...base, block_lines: 5, reflowed: true }).ok, true);
});

// ---- 3. the round trip on a real PDF ------------------------------------------

const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global', 'define',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis, undefined);
  return module.exports;
};

// js/v2/text-runs.js extract(), the same arithmetic, minus the DOM.
async function runsOfPage(pdfjs, pg) {
  const vp = pg.getViewport({ scale: 1 });
  const tc = await pg.getTextContent();
  const runs = [];
  for (const item of tc.items) {
    if (!item.str || !item.str.trim()) continue;
    const m = pdfjs.Util.transform(vp.transform, item.transform);
    const fh = Math.hypot(m[2], m[3]);
    if (!fh || !item.width) continue;
    const dirLen = Math.hypot(m[0], m[1]) || 1;
    const adv = [(m[0] / dirLen) * item.width, (m[1] / dirLen) * item.width];
    const pDesc = pdfjs.Util.applyTransform([0, -0.25], m);
    const pTop = pdfjs.Util.applyTransform([0, 1], m);
    const org = pdfjs.Util.applyTransform([0, 0], m);
    const cs = [pDesc, [pDesc[0] + adv[0], pDesc[1] + adv[1]], pTop, [pTop[0] + adv[0], pTop[1] + adv[1]]];
    const xs = cs.map((c) => c[0]);
    const ys = cs.map((c) => c[1]);
    const pad = fh * 0.06;
    const len = Math.hypot(item.transform[0], item.transform[1]) || 1;
    runs.push({
      str: item.str,
      x: Math.min(...xs) - pad,
      y: Math.min(...ys) - pad,
      w: Math.max(...xs) - Math.min(...xs) + pad * 2,
      h: Math.max(...ys) - Math.min(...ys) + pad * 2,
      size: fh,
      fontName: item.fontName,
      fontFamily: '',
      org: { x: org[0], y: org[1] },
      pdf: {
        x0: item.transform[4], y0: item.transform[5], ux: item.transform[0] / len, uy: item.transform[1] / len,
        len: item.width, size: Math.hypot(item.transform[2], item.transform[3]),
      },
    });
  }
  return runs;
}

// Text lines of a PDF page as pdf.js reads them: items grouped by baseline.
async function readLines(pdfjs, bytes) {
  const pj = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
  const pg = await pj.getPage(1);
  const tc = await pg.getTextContent();
  const byY = new Map();
  for (const it of tc.items) {
    if (!it.str) continue;
    const y = Math.round(it.transform[5] * 100) / 100;
    if (!byY.has(y)) byY.set(y, []);
    byY.get(y).push(it);
  }
  return [...byY.entries()].sort((a, b) => b[0] - a[0]).map(([y, items]) => {
    items.sort((a, b) => a.transform[4] - b.transform[4]);
    const inked = items.filter((it) => it.str.trim());
    return {
      y,
      text: items.map((it) => it.str).join('').replace(/\s+/g, ' ').trim(),
      x0: Math.min(...inked.map((it) => it.transform[4])),
      x1: Math.max(...inked.map((it) => it.transform[4] + it.width)),
    };
  }).filter((l) => l.text);
}

test('10. ROUND TRIP: a 4-line justified paragraph, re-written longer, stamps natively line for line; its old words are gone', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
  globalThis.pdfjsWorker = loadUmd('js/vendor/pdf.worker.min.js');
  const pdfjs = loadUmd('js/vendor/pdf.min.js');
  const model = await import('../../js/core/model.js');
  const ops = await import('../../js/core/operations.js');
  const { groupRunsIntoLines } = await import('../../js/core/text-lines.js');
  const { buildEditedPageBytes } = await import('../../js/core/page-surgery.js');

  const bytes = fs.readFileSync(path.join(root, 'tests/fixtures/nasty/paragraf-badan.pdf'));
  const pj = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, isEvalSupported: false, verbosity: 0 }).promise;
  const lines = groupRunsIntoLines(await runsOfPage(pdfjs, await pj.getPage(1)));
  const tapped = lines.find((l) => l.str.startsWith('lingkungan kantor'));
  const block = blockOfLine(lines, tapped);
  assert.ok(block, 'the fixture paragraph is a detected block');
  assert.equal(block.lines.length, 4);
  const { ok, plan, reason } = planBlockEdit(block, lines);
  assert.equal(ok, true, reason);
  assert.equal(plan.align, 'justify');

  // The editor stand-in: the breaks it would paint, measured in the font the
  // file is written in (the doc's own Montserrat). In the product these come
  // from the DOM; here wrapText supplies them so the stamp has known breaks.
  const mont = fontkit.create(fs.readFileSync(path.join(root, 'fonts/ttf/montserrat-regular.ttf')));
  const widthOf = (s) => [...s].reduce((w, ch) => w + mont.glyphForCodePoint(ch.codePointAt(0)).advanceWidth, 0) * plan.size / mont.unitsPerEm;
  const NEW = 'Seluruh pegawai kantor diminta hadir pada kerja bakti hari Sabtu pagi pukul tujuh dengan membawa '
    + 'peralatan kebersihan sendiri sesuai pembagian tugas dari panitia, dan seluruh kegiatan diharapkan selesai '
    + 'sebelum tengah hari supaya semua bisa beristirahat.';
  const painted = wrapText(NEW, { widthOf, maxWidth: plan.width }).map((l) => ({ text: l.text, hard: l.hardBreak }));
  // One line more than the original: the block grows down into the blank line
  // under it (two more would write over the next paragraph — spec §6's
  // collision, which is the toast's case, not this test's).
  assert.equal(painted.length, plan.srcLines + 1, `painted ${painted.length} lines`);

  // The model: the cover over the whole paragraph, the replacement carrying
  // its painted lines — the exact pair js/v2/app.js commits.
  const srcDoc = await PDFLib.PDFDocument.load(bytes);
  const { width, height } = srcDoc.getPages()[0].getSize();
  const doc = model.createDoc();
  const source = ops.addSource(doc, model.createSource({ name: 'paragraf-badan.pdf', bytes, numPages: 1 }));
  const page = model.createPage({ source, sourcePageNum: 0, width, height, rotation: 0 });
  ops.addPages(doc, [page]);
  const cover = ops.addAnnotation(doc, page.id, model.createAnnotation('whiteout', {
    x: plan.box.x, y: plan.box.y, width: plan.box.w, height: plan.box.h,
    replaceTargets: plan.targets, replaceBox: plan.box,
  }));
  // The editor's font decision (core/line-font.js), as js/v2/app.js's
  // prepareDocFont makes it: the document's own program, under the /Font
  // resource of the block's dominant run. pdf-lib gave every line of this
  // fixture its own resource NAME for the one font object, so without the
  // decision the old ladder reads the block as mixed fonts and declines.
  const { extractFontMetrics, readPageContents } = await import('../../js/core/redact.js');
  const { walkShowOps } = await import('../../js/core/text-walk.js');
  const srcPage = srcDoc.getPages()[0];
  const key = walkShowOps(readPageContents(srcPage, PDFLib), extractFontMetrics(srcPage, PDFLib))
    .find((r) => Math.abs(r.y - plan.origin.y) < 0.01).fontName;
  ops.addAnnotation(doc, page.id, model.createAnnotation('text', {
    text: NEW, x: plan.disp.x, y: plan.box.y, fontSize: plan.k * plan.size, fontFamily: 'Helvetica',
    replaceCoverId: cover.id, block: blockAnnotation(plan, painted),
    fontDecision: { v: 1, path: 'native', key, uncovered: 0, ladder: [{ path: 'native', key }] },
  }));

  const out = await buildEditedPageBytes(srcDoc, page, page.annotations, { PDFLib, fontkit });
  assert.ok(out.bytes, 'the edit applied');
  const oc = out.outcomes[0];
  assert.deepEqual(oc.surgery, { matched: true, reason: 'clean' }, 'every run of every line was cut');
  assert.equal(oc.insert.path, 'native', `stamped in the document's own font (${JSON.stringify(oc.insert)})`);
  assert.equal(oc.insert.decided_live, true, 'the font the editor decided is the font stamped');
  assert.equal(oc.insert.block_lines, painted.length);
  assert.equal(oc.insert.reflowed, true);

  const read = await readLines(pdfjs, out.bytes);
  const body = read.filter((l) => l.y >= 740 - (painted.length - 1) * 15 - 0.5 && l.y <= 740.5);
  // Line for line: the file holds exactly the painted breaks, in order, at the
  // block's baselines (740, 725, ... by its 15pt leading).
  assert.deepEqual(body.map((l) => l.text), painted.map((l) => l.text));
  body.forEach((l, i) => assert.ok(Math.abs(l.y - (740 - i * 15)) < 0.01, `line ${i} baseline ${l.y}`));
  // Inside the box: every line starts on its left edge; the justified ones end
  // on its right edge, the last one short of it.
  const right = plan.origin.x + plan.width;
  body.forEach((l, i) => {
    assert.ok(Math.abs(l.x0 - 72) < 0.01, `line ${i} starts at ${l.x0}`);
    if (i < body.length - 1) assert.ok(Math.abs(l.x1 - right) < 0.05, `line ${i} ends at ${l.x1}, box edge ${right}`);
    else assert.ok(l.x1 < right - 1);
  });
  // The original paragraph is gone; the paragraph below it is not.
  const all = read.map((l) => l.text).join('\n');
  for (const gone of ['Sehubungan', 'lingkungan kantor', 'masing sesuai']) assert.ok(!all.includes(gone), `"${gone}" survived`);
  assert.ok(all.includes('Pemberitahuan Kegiatan'));
  assert.ok(all.includes('Panitia Kerja Bakti'));
});

test('11. EXPORT TWIN: a paragraph the stamp did not bake is still drawn line by line at its own baselines, justified to its box', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
  globalThis.pdfjsWorker = loadUmd('js/vendor/pdf.worker.min.js');
  const pdfjs = loadUmd('js/vendor/pdf.min.js');
  const model = await import('../../js/core/model.js');
  const ops = await import('../../js/core/operations.js');
  const { buildPdfBytes } = await import('../../js/core/export.js');

  // A blank page and a paragraph annotation with no surgery behind it: export's
  // drawText takes it, in the twin's standard Helvetica (no fetch needed).
  const blank = await PDFLib.PDFDocument.create();
  blank.addPage([595, 842]);
  const bytes = await blank.save();
  const doc = model.createDoc();
  const source = ops.addSource(doc, model.createSource({ name: 'blank.pdf', bytes, numPages: 1 }));
  const page = model.createPage({ source, sourcePageNum: 0, width: 595, height: 842, rotation: 0 });
  ops.addPages(doc, [page]);
  const lines = [
    { text: 'Satu dua tiga empat lima', brk: ' ' },
    { text: 'enam tujuh delapan', brk: '\n' },
    { text: 'sembilan sepuluh', brk: '' },
  ];
  const block = {
    v: 1, align: 'justify', indent: 0, width: 220, leading: 16, size: 12,
    origin: { x: 100, y: 600 }, k: 1, disp: { x: 100, y: 242 }, srcLines: 3, srcWords: [5, 3, 2], below: null,
    lines: lines.map((l) => ({ ...l, hard: l.brk.includes('\n') })), reflowed: false,
  };
  ops.addAnnotation(doc, page.id, model.createAnnotation('text', {
    text: logicalTextOf(lines), x: 100, y: 230, fontSize: 12, fontFamily: 'Helvetica', block,
  }));
  const out = await buildPdfBytes(doc, { PDFLib, fontkit });
  const read = await readLines(pdfjs, out);
  assert.deepEqual(read.map((l) => l.text), lines.map((l) => l.text));
  assert.deepEqual(read.map((l) => l.y), [600, 584, 568]);
  read.forEach((l) => assert.ok(Math.abs(l.x0 - 100) < 0.01));
  // Line 1 is stretched to the box edge; line 2 ends at a typed break and the
  // last line is the last: neither is.
  assert.ok(Math.abs(read[0].x1 - 320) < 0.05, `line 0 ends at ${read[0].x1}`);
  assert.ok(read[1].x1 < 300 && read[2].x1 < 300);
});

test('12. the committed text and the painted lines are one fact (logicalTextOf)', () => {
  assert.equal(logicalTextOf([
    { text: 'kerja bakti hari', brk: ' ' },
    { text: 'sehari-', brk: '' },
    { text: 'hari pukul', brk: '\n' },
    { text: 'tujuh.', brk: '' },
  ]), 'kerja bakti hari sehari-hari pukul\ntujuh.');
  const lines = justified();
  const { plan } = planBlockEdit(blockOf(lines), lines);
  const painted = [{ text: 'a b', brk: ' ' }, { text: 'c', brk: '\n' }, { text: 'd', brk: '' }];
  const b = blockAnnotation(plan, painted);
  assert.equal(logicalTextOf(b.lines), 'a b c\nd');
  assert.deepEqual(b.lines.map((l) => l.hard), [false, true, false]);
});
