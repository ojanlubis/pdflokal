/*
 * docx/convert.js end to end on small synthetic PDFs: the fast loop for every lane.
 * pdf-lib draws the page, pdf.js reads it, the whole pipeline runs, and the written .docx is read
 * back with code that does not share the writer (scripts/lib/docx-xml.mjs + regex over the XML).
 * Module overrides (`modules`) prove the interfaces the lanes build on: a tables module that claims
 * lines, a colour module that colours text and adds shapes, a layout that throws.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateModel } from '../../js/docx/model.js';
import { encodePng } from '../../js/docx/png.js';
import { loadLibs, makePdf, convertBytes, packageIsClean, paragraphsOf, docText } from './docx-helpers.mjs';

const { fflate } = loadLibs();

// A column of left-aligned Courier lines, `text` per line, `step` pt apart, starting at (x, top).
const lines = (page, font, texts, { x = 72, top = 760, step = 14, size = 10 } = {}) => texts.forEach((t, k) => page.drawText(t, { x, y: top - k * step, size, font }));

// ---- text, reading order, paragraphs -----------------------------------------------------------
test('convert: words survive and arrive in reading order; the package is clean; the model validates', async () => {
  const bytes = await makePdf((pages, { fonts }) => {
    pages[0].drawText('Laporan Tahunan', { x: 72, y: 780, size: 20, font: fonts.bold });
    lines(pages[0], fonts.reg, ['Paragraf pertama berisi kalimat biasa saja.', 'Dan ini kalimat kedua di bawahnya.'], { top: 740, size: 11 });
    pages[0].drawText('Penutup', { x: 72, y: 600, size: 14, font: fonts.bold });
  });
  const r = await convertBytes(bytes);
  assert.deepEqual(packageIsClean(r.files), []);
  assert.deepEqual(validateModel(r.model), []);
  assert.deepEqual(r.stats.errors, []);
  assert.deepEqual(docText(r.documentXml).join(' ').split(/\s+/).filter(Boolean), 'Laporan Tahunan Paragraf pertama berisi kalimat biasa saja. Dan ini kalimat kedua di bawahnya. Penutup'.split(' '));
});

test('convert: bold text is a bold run; plain text is not', async () => {
  const bytes = await makePdf((pages, { fonts }) => {
    pages[0].drawText('Judul tebal', { x: 72, y: 780, size: 16, font: fonts.bold });
    pages[0].drawText('isi biasa', { x: 72, y: 740, size: 11, font: fonts.reg });
  });
  const { documentXml } = await convertBytes(bytes);
  const [head, body] = paragraphsOf(documentXml).filter((p) => /<w:t[ >]/.test(p));
  assert.match(head, /<w:b\/>/);
  assert.doesNotMatch(body, /<w:b\/>/);
});

test('convert: wrapped lines of one paragraph merge into one w:p; a heading above stays its own', async () => {
  const wrapped = Array.from({ length: 6 }, (_, k) => `baris nomor ${k + 1} dari paragraf panjang`.padEnd(40, ' x').slice(0, 40));
  const bytes = await makePdf((pages, { fonts }) => {
    pages[0].drawText('Judul', { x: 72, y: 780, size: 14, font: fonts.bold });
    lines(pages[0], fonts.mono, wrapped, { top: 740 });
  });
  const { documentXml } = await convertBytes(bytes);
  const paras = docText(documentXml);
  assert.equal(paras.length, 2, JSON.stringify(paras));
  assert.equal(paras[0], 'Judul');
  assert.equal(paras[1].split(/\s+/).length >= 6 * 4, true);
});

test('convert: a bullet line becomes a list paragraph with the marker removed from the text', async () => {
  const bytes = await makePdf((pages, { fonts }) => {
    pages[0].drawText('-', { x: 72, y: 700, size: 11, font: fonts.reg });
    pages[0].drawText('butir pertama yang cukup panjang', { x: 90, y: 700, size: 11, font: fonts.reg });
  });
  const { documentXml } = await convertBytes(bytes);
  assert.match(documentXml, /<w:numPr>/);
  assert.deepEqual(docText(documentXml), ['butir pertama yang cukup panjang']);
});

test('convert: two real columns become a two-column Word section, left column first', async () => {
  const left = Array.from({ length: 16 }, (_, k) => `kiri ${String(k + 1).padStart(2, '0')} aaaaaaaaaaaaaaaaaaaaa`);
  const right = Array.from({ length: 16 }, (_, k) => `kanan ${String(k + 1).padStart(2, '0')} bbbbbbbbbbbbbbbbbbbb`);
  const bytes = await makePdf((pages, { fonts }) => {
    lines(pages[0], fonts.mono, left, { x: 50, top: 760, size: 9, step: 14 });
    lines(pages[0], fonts.mono, right, { x: 320, top: 760, size: 9, step: 14 });
  });
  const { documentXml, stats } = await convertBytes(bytes);
  assert.equal(stats.columnBands, 1);
  assert.match(documentXml, /<w:cols w:num="2"/);
  assert.match(documentXml, /<w:br w:type="column"\/>/, 'the left column ends with a column break, or Word would flow it into the right one');
  const text = docText(documentXml).join(' ');
  assert.ok(text.indexOf('kiri 16') < text.indexOf('kanan 01'), 'the whole left column is read before the right one');
});

// ---- pages ------------------------------------------------------------------------------------
test('convert: each PDF page is its own section with its own size; progress reports every page; maxPages stops early', async () => {
  const bytes = await makePdf((pages, { fonts }) => pages.forEach((p, k) => p.drawText(`Halaman ${k + 1}`, { x: 72, y: 700, size: 12, font: fonts.reg })), { pages: [[595, 842], [612, 792], [595, 842]] });
  const seen = [];
  const r = await convertBytes(bytes, { onProgress: (i, n) => seen.push([i, n]) });
  assert.deepEqual(seen, [[1, 3], [2, 3], [3, 3]]);
  assert.equal((r.documentXml.match(/<w:sectPr>/g) || []).length, 3);
  assert.match(r.documentXml, /<w:pgSz w:w="12240" w:h="15840"\/>/);
  assert.deepEqual(r.stats.pageKinds.text, 3);
  const two = await convertBytes(bytes, { maxPages: 2 });
  assert.equal((two.documentXml.match(/<w:sectPr>/g) || []).length, 2);
});

test('convert: a blank page is kept as an empty page, not dropped', async () => {
  const bytes = await makePdf((pages, { fonts }) => { pages[1].drawText('dua', { x: 72, y: 700, size: 12, font: fonts.reg }); }, { pages: [[595, 842], [595, 842]] });
  const r = await convertBytes(bytes);
  assert.equal(r.stats.pageKinds.empty, 1);
  assert.equal((r.documentXml.match(/<w:sectPr>/g) || []).length, 2);
  assert.deepEqual(packageIsClean(r.files), []);
});

// ---- images -----------------------------------------------------------------------------------
test('convert: a raster image becomes an anchored picture behind the text, once per image object', async () => {
  const px = new Uint8Array(8 * 8 * 3); for (let i = 0; i < px.length; i += 1) px[i] = (i * 7) % 256;
  const bytes = await makePdf(async (pages, { doc, fonts }) => {
    const img = await doc.embedPng(encodePng(fflate, 8, 8, 3, px));
    pages[0].drawImage(img, { x: 72, y: 600, width: 120, height: 120 });
    pages[0].drawImage(img, { x: 300, y: 600, width: 60, height: 60 });
    pages[0].drawText('teks di sini', { x: 72, y: 500, size: 12, font: fonts.reg });
  });
  const r = await convertBytes(bytes);
  assert.equal((r.documentXml.match(/<wp:anchor /g) || []).length, 2);
  assert.equal(Object.keys(r.files).filter((n) => n.startsWith('word/media/')).length, 1, 'the same PDF image is one media part');
  assert.equal(r.stats.anchored, 2);
  assert.deepEqual(packageIsClean(r.files), []);
  assert.deepEqual(docText(r.documentXml), ['teks di sini']);
});

// ---- cancel -----------------------------------------------------------------------------------
test('convert: an AbortSignal stops the loop between pages and rejects with AbortError', async () => {
  const bytes = await makePdf((pages, { fonts }) => pages.forEach((p) => p.drawText('x', { x: 72, y: 700, size: 12, font: fonts.reg })), { pages: [[595, 842], [595, 842], [595, 842], [595, 842]] });
  const ctl = new AbortController();
  const seen = [];
  await assert.rejects(convertBytes(bytes, { signal: ctl.signal, onProgress: (i) => { seen.push(i); if (i === 2) ctl.abort(); } }), (e) => e.name === 'AbortError');
  assert.deepEqual(seen, [1, 2], 'no page after the abort was started');
  const pre = new AbortController(); pre.abort();
  await assert.rejects(convertBytes(bytes, { signal: pre.signal }), (e) => e.name === 'AbortError');
});

// ---- interfaces the lanes build on ------------------------------------------------------------
test('interface: a page whose layout throws becomes an empty A4 page and a stats.errors entry; the rest converts', async () => {
  const bytes = await makePdf((pages, { fonts }) => pages.forEach((p, k) => p.drawText(`isi ${k + 1}`, { x: 72, y: 700, size: 12, font: fonts.reg })), { pages: [[595, 842], [595, 842], [595, 842]] });
  const layoutMod = await import('../../js/docx/layout.js');
  let call = 0;
  const r = await convertBytes(bytes, { modules: { layout: { layoutPage: (ctx) => { call += 1; if (call === 2) throw new Error('boom'); return layoutMod.layoutPage(ctx); } } } });
  assert.deepEqual(r.stats.errors, ['p2: boom']);
  assert.equal(r.model.pages[1].kind, 'error');
  assert.deepEqual(docText(r.documentXml), ['isi 1', 'isi 3']);
});

test('interface: a colour module sets run.color and returns shapes; both reach the .docx, and shapes and pictures stack by z (paint order)', async () => {
  const px = new Uint8Array(4 * 4 * 3).fill(90);
  const bytes = await makePdf(async (pages, { doc, fonts }) => {
    pages[0].drawImage(await doc.embedPng(encodePng(fflate, 4, 4, 3, px)), { x: 400, y: 500, width: 50, height: 50 });
    pages[0].drawText('MERAH', { x: 72, y: 700, size: 12, font: fonts.reg });
    pages[0].drawText('biasa', { x: 72, y: 660, size: 12, font: fonts.reg });
  });
  const colour = {
    analyzeColor(ctx) {
      for (const r of ctx.runs) if (r.str === 'MERAH') r.color = 'FF0000';
      return { fillAt: () => null, background: 'FFF2CC', anchors: [{ kind: 'shape', x: 0, y: 0, wPt: ctx.widthPt, hPt: ctx.heightPt, fill: 'FFF2CC', z: 1e9 }, { kind: 'shape', x: 0, y: 0, wPt: 9, hPt: 9, fill: '000000', z: -1 }] };
    },
  };
  const r = await convertBytes(bytes, { modules: { color: colour } });
  const [red, plain] = paragraphsOf(r.documentXml).filter((p) => /<w:t[ >]/.test(p));
  assert.match(red, /<w:color w:val="FF0000"\/>/);
  assert.doesNotMatch(plain, /w:color/);
  assert.match(r.documentXml, /<wps:wsp>/);
  assert.equal(r.stats.shapes, 2);
  assert.deepEqual(r.model.pages[0].anchors.map((a) => a.kind), ['shape', 'img', 'shape'], 'z -1 first, the picture (its operator index) next, z 1e9 last');
  assert.deepEqual(packageIsClean(r.files), []);
});

test('interface: a tables module claims lines; they leave the text flow, the table takes their place in reading order', async () => {
  const bytes = await makePdf((pages, { fonts }) => {
    pages[0].drawText('Sebelum tabel', { x: 72, y: 780, size: 11, font: fonts.reg });
    pages[0].drawText('Nama', { x: 72, y: 700, size: 11, font: fonts.reg });
    pages[0].drawText('Jumlah', { x: 300, y: 700, size: 11, font: fonts.reg });
    pages[0].drawText('Beras', { x: 72, y: 680, size: 11, font: fonts.reg });
    pages[0].drawText('12', { x: 300, y: 680, size: 11, font: fonts.reg });
    pages[0].drawText('Sesudah tabel', { x: 72, y: 600, size: 11, font: fonts.reg });
  });
  const layoutMod = await import('../../js/docx/layout.js');
  const tables = {
    detectTables(ctx) {
      const own = ctx.lines.filter((l) => ['Nama', 'Jumlah', 'Beras', '12'].includes(l.str.trim()));
      assert.equal(own.length, 4, 'the table module sees ctx.lines, ctx.words and ctx.color');
      assert.ok(ctx.words.length >= 6 && typeof ctx.color.fillAt === 'function');
      const cell = (line) => ({ blocks: layoutMod.paragraphsOfLines([line], ctx, { left: line.x, right: line.x + line.w }) });
      const [nama, jumlah, beras, dua] = ['Nama', 'Jumlah', 'Beras', '12'].map((s) => own.find((l) => l.str.trim() === s));
      const x0 = Math.min(...own.map((l) => l.x));
      const y0 = Math.min(...own.map((l) => l.y));
      return [{
        x0, y0, x1: Math.max(...own.map((l) => l.x + l.w)), y1: Math.max(...own.map((l) => l.y + l.h)), lines: own,
        block: { kind: 'tbl', colsPt: [228, 80], border: true, rows: [[cell(nama), { ...cell(jumlah), fill: 'D9E2F3' }], [cell(beras), cell(dua)]] },
      }];
    },
  };
  const r = await convertBytes(bytes, { modules: { tables } });
  assert.equal(r.stats.tables, 1);
  assert.equal((r.documentXml.match(/<w:tbl>/g) || []).length, 1);
  assert.deepEqual(validateModel(r.model), []);
  assert.deepEqual(packageIsClean(r.files), []);
  const texts = docText(r.documentXml);
  assert.deepEqual(texts, ['Sebelum tabel', 'Nama', 'Jumlah', 'Beras', '12', 'Sesudah tabel'], 'each consumed word appears once, in order, between its neighbours');
  assert.match(r.documentXml, /<w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"\/>/);
  assert.ok(r.documentXml.indexOf('Sebelum tabel') < r.documentXml.indexOf('<w:tbl>') && r.documentXml.indexOf('</w:tbl>') < r.documentXml.indexOf('Sesudah tabel'));
});

test('interface: the stub modules do nothing, visibly: no tables, no shapes, no colour', async () => {
  const bytes = await makePdf((pages, { fonts }) => lines(pages[0], fonts.reg, ['a b c', 'd e f']));
  const r = await convertBytes(bytes);
  assert.equal(r.stats.tables, 0);
  assert.equal(r.stats.shapes, 0);
  assert.doesNotMatch(r.documentXml, /<w:tbl>|w:color|wps:/);
});

test('convert: the same PDF twice gives byte-identical document.xml (the gate relies on determinism)', async () => {
  const bytes = await makePdf((pages, { fonts }) => lines(pages[0], fonts.reg, ['satu dua tiga', 'empat lima enam']));
  const a = await convertBytes(bytes);
  const b = await convertBytes(bytes);
  assert.equal(a.documentXml, b.documentXml);
});

