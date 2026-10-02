/*
 * PDF -> DOCX: tables (js/docx/tables.js, tables-rules.js, tables-text.js, tables-build.js).
 * Synthetic PDFs drawn with pdf-lib, read back by pdf.js: the same pair the browser uses, so the operator list the
 * detector sees is a real one. Two kinds of test: a table must come out as a Word table (with its borders, fills and
 * merges), and the things that look a little like a table must NOT (a rule under a heading, a framed box, two columns
 * of prose, a numbered list, a table of contents). The second kind is the one that protects people's documents.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makePdf, convertBytes, packageIsClean, docText } from './docx-helpers.mjs';
import { validateModel } from '../../js/docx/model.js';
import { drawingReason, gridQuality } from '../../js/docx/tables.js';
import { orderRefusal, streamOrder } from '../../js/docx/tables-text.js';

const tablesOf = (model) => model.pages.flatMap((p) => p.segments.flatMap((s) => s.blocks.filter((b) => b.kind === 'tbl')));
const cellText = (c) => c.blocks.map((p) => p.runs.map((r) => r.t).join('')).join('\n');
const gridOf = (t) => t.rows.map((row) => row.map(cellText));
const count = (xml, re) => (xml.match(re) || []).length;

// A ruled grid. x0, top in PDF points (origin bottom-left); widths and heights per column / row; cells[r][c] text.
// hasV(i, r) / hasH(j, c) say whether the vertical rule i beside row r / horizontal rule j under column c is drawn.
function ruledGrid(page, fonts, { x0 = 72, top = 760, widths, heights, cells, hasV = () => true, hasH = () => true, thickness = 1, size = 10, rgb, color }) {
  const xs = [x0]; widths.forEach((w) => xs.push(xs[xs.length - 1] + w));
  const ys = [top]; heights.forEach((h) => ys.push(ys[ys.length - 1] - h));
  const line = (a, b) => page.drawLine({ start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, thickness, color: color || rgb(0, 0, 0) });
  for (let j = 0; j < ys.length; j += 1) for (let c = 0; c < widths.length; c += 1) if (hasH(j, c)) line([xs[c], ys[j]], [xs[c + 1], ys[j]]);
  for (let i = 0; i < xs.length; i += 1) for (let r = 0; r < heights.length; r += 1) if (hasV(i, r)) line([xs[i], ys[r]], [xs[i], ys[r + 1]]);
  cells.forEach((row, r) => row.forEach((t, c) => { if (t) page.drawText(t, { x: xs[c] + 5, y: ys[r + 1] + (heights[r] - size) / 2 + 1, size, font: fonts.reg }); }));
  return { xs, ys };
}

// ---- ruled tables ----------------------------------------------------------------------------------------
test('tables: a ruled grid becomes ONE Word table with its rows, columns, borders and text, in row order', async () => {
  const bytes = await makePdf((pages, { fonts, rgb }) => {
    pages[0].drawText('Daftar belanja', { x: 72, y: 790, size: 12, font: fonts.bold });
    ruledGrid(pages[0], fonts, {
      widths: [120, 90, 90], heights: [22, 22, 22, 22], rgb,
      cells: [['Barang', 'Jumlah', 'Harga'], ['Beras', '12', '14.000'], ['Minyak', '3', '18.500'], ['Gula', '5', '16.000']],
    });
    pages[0].drawText('Catatan sesudah tabel', { x: 72, y: 640, size: 10, font: fonts.reg });
  });
  const r = await convertBytes(bytes);
  assert.equal(r.stats.tables, 1);
  const [t] = tablesOf(r.model);
  assert.deepEqual(gridOf(t), [['Barang', 'Jumlah', 'Harga'], ['Beras', '12', '14.000'], ['Minyak', '3', '18.500'], ['Gula', '5', '16.000']]);
  assert.deepEqual(t.colsPt.map(Math.round), [120, 90, 90]);
  assert.equal(count(r.documentXml, /<w:tbl>/g), 1);
  assert.equal(count(r.documentXml, /<w:tr>/g), 4);
  assert.equal(count(r.documentXml, /<w:gridCol /g), 3);
  // every cell has all four borders, 1 pt = 8 eighths
  assert.equal(count(r.documentXml, /<w:tcBorders>/g), 12);
  assert.match(r.documentXml, /<w:top w:val="single" w:sz="8" w:space="0" w:color="000000"\/>/);
  // nothing lost or doubled, the neighbours stay paragraphs around the table
  assert.deepEqual(docText(r.documentXml), ['Daftar belanja', 'Barang', 'Jumlah', 'Harga', 'Beras', '12', '14.000', 'Minyak', '3', '18.500', 'Gula', '5', '16.000', 'Catatan sesudah tabel']);
  assert.deepEqual(validateModel(r.model), []);
  assert.deepEqual(packageIsClean(r.files), []);
});

test('tables: a missing rule merges the cells it separated (gridSpan across, vMerge down) and the row still adds up', async () => {
  const bytes = await makePdf((pages, { fonts, rgb }) => {
    ruledGrid(pages[0], fonts, {
      widths: [90, 90, 90], heights: [22, 22, 22], rgb,
      // no vertical rule between columns 1 and 2 on the title row; no horizontal rule between rows 1 and 2 under column 0
      hasV: (i, r) => !(i === 2 && r === 0),
      hasH: (j, c) => !(j === 2 && c === 0),
      cells: [['Judul tabel', '', ''], ['Wilayah', 'Utara', 'Selatan'], ['', 'Timur', 'Barat']],
    });
  });
  const r = await convertBytes(bytes);
  const [t] = tablesOf(r.model);
  assert.ok(t, 'a table');
  assert.equal(t.rows[0].length, 2, 'row 1 has two cells');
  assert.equal(t.rows[0][1].span, 2, 'the title spans two columns');
  assert.equal(t.rows[1][0].vmerge, 'restart');
  assert.equal(t.rows[2][0].vmerge, 'continue');
  assert.match(r.documentXml, /<w:gridSpan w:val="2"\/>/);
  assert.match(r.documentXml, /<w:vMerge w:val="restart"\/>/);
  assert.match(r.documentXml, /<w:vMerge\/>/);
  assert.deepEqual(validateModel(r.model), [], 'every row spans exactly the grid');
  assert.deepEqual(packageIsClean(r.files), []);
});

test('tables: a rule that text runs straight through is not a border there: the heading across it becomes one spanning cell', async () => {
  const bytes = await makePdf((pages, { fonts, rgb }) => {
    ruledGrid(pages[0], fonts, {
      widths: [70, 70, 70], heights: [22, 22, 22], rgb,
      cells: [['', '', 'Total'], ['a1', 'b1', 'c1'], ['a2', 'b2', 'c2']],
    });
    // the heading is ONE run of text that crosses the rule between the first two columns
    pages[0].drawText('Judul melintas', { x: 72 + 40, y: 760 - 22 + 7, size: 10, font: fonts.reg });
  });
  const r = await convertBytes(bytes);
  const [t] = tablesOf(r.model);
  assert.ok(t);
  assert.equal(t.rows[0][0].span, 2, 'the heading spans the two columns the rule used to separate');
  assert.equal(cellText(t.rows[0][0]), 'Judul melintas');
  assert.equal(t.rows[1].length, 3, 'the rows below keep their three cells');
  assert.deepEqual(validateModel(r.model), []);
});

test('tables: a merged region that is not a rectangle keeps what a row can say (the heading span) and merges nothing downward', async () => {
  const bytes = await makePdf((pages, { fonts, rgb }) => {
    ruledGrid(pages[0], fonts, {
      widths: [80, 80, 80], heights: [22, 22, 22], rgb,
      // row 1: no rule between columns 1 and 2; no rule under column 1 only: the open region is an L (three of four cells)
      hasV: (i, r) => !(i === 1 && r === 0),
      hasH: (j, c) => !(j === 1 && c === 0),
      cells: [['Judul', '', 'Total'], ['', 'b1', 'c1'], ['a2', 'b2', 'c2']],
    });
  });
  const r = await convertBytes(bytes);
  const [t] = tablesOf(r.model);
  assert.ok(t);
  assert.equal(t.rows[0][0].span, 2);
  assert.ok(t.rows.every((row) => row.every((c) => !c.vmerge)), 'no vertical merge from an L-shaped region');
  assert.deepEqual(validateModel(r.model), []);
});

test('tables: a filled rectangle under a cell is its shading; thin filled rectangles are borders, not fills', async () => {
  const bytes = await makePdf((pages, { fonts, rgb }) => {
    // header row fill first (paint order: under the text and the rules)
    pages[0].drawRectangle({ x: 72, y: 716, width: 200, height: 24, color: rgb(0.85, 0.89, 0.95) });
    ruledGrid(pages[0], fonts, {
      top: 740, widths: [100, 100], heights: [24, 24, 24], rgb,
      cells: [['Nama', 'Nilai'], ['Ani', '80'], ['Budi', '75']],
    });
    // a Word-style border: a 0.5 pt thick FILLED rectangle used as a rule, under the last row
    pages[0].drawRectangle({ x: 72, y: 667.5, width: 200, height: 0.5, color: rgb(0, 0, 0) });
  });
  const r = await convertBytes(bytes);
  const [t] = tablesOf(r.model);
  assert.ok(t);
  assert.equal(t.rows[0][0].fill, 'D9E3F2');
  assert.equal(t.rows[0][1].fill, 'D9E3F2');
  assert.equal(t.rows[1][0].fill, undefined, 'the body rows are not shaded');
  assert.match(r.documentXml, /<w:shd w:val="clear" w:color="auto" w:fill="D9E3F2"\/>/);
});

test('tables: a rule beside the table is not swallowed: text next to a ruled grid leaves the grid as text', async () => {
  const bytes = await makePdf((pages, { fonts, rgb }) => {
    ruledGrid(pages[0], fonts, { widths: [80, 80], heights: [22, 22, 22], rgb, cells: [['A', 'B'], ['C', 'D'], ['E', 'F']] });
    // a paragraph in the same band, to the right of the grid: Word cannot flow text around a table
    for (let k = 0; k < 3; k += 1) pages[0].drawText(`teks di samping ${k + 1}`, { x: 300, y: 745 - k * 22, size: 10, font: fonts.reg });
  });
  const r = await convertBytes(bytes);
  assert.equal(tablesOf(r.model).length, 0);
  assert.deepEqual(docText(r.documentXml).join(' ').includes('teks di samping 3'), true);
});

// ---- things that look like tables and are not ----------------------------------------------------------------
test('tables: NOT a table: a rule under a heading, a framed paragraph, a ruled page footer', async () => {
  const bytes = await makePdf((pages, { fonts, rgb }) => {
    const p = pages[0];
    p.drawText('Bab 1 Pendahuluan', { x: 72, y: 780, size: 16, font: fonts.bold });
    p.drawLine({ start: { x: 72, y: 772 }, end: { x: 523, y: 772 }, thickness: 1, color: rgb(0, 0, 0) });
    p.drawRectangle({ x: 72, y: 600, width: 451, height: 60, borderColor: rgb(0, 0, 0), borderWidth: 1 });
    p.drawText('Kotak peringatan: baca sebelum mengisi formulir ini dengan teliti.', { x: 80, y: 635, size: 10, font: fonts.reg });
    p.drawLine({ start: { x: 72, y: 60 }, end: { x: 523, y: 60 }, thickness: 0.5, color: rgb(0, 0, 0) });
    p.drawText('Halaman 1', { x: 280, y: 45, size: 9, font: fonts.reg });
  });
  const r = await convertBytes(bytes);
  assert.equal(tablesOf(r.model).length, 0);
  assert.equal(count(r.documentXml, /<w:tbl>/g), 0);
});

test('tables: NOT a table: an org chart (boxes and connectors) is a drawing, however connected its rules', async () => {
  const bytes = await makePdf((pages, { fonts, rgb }) => {
    const p = pages[0];
    const box = (x, y, w, h, t) => { p.drawRectangle({ x, y, width: w, height: h, borderColor: rgb(0, 0, 0), borderWidth: 1 }); p.drawText(t, { x: x + 6, y: y + h / 2 - 4, size: 9, font: fonts.reg }); };
    box(230, 740, 120, 30, 'Direktur');
    box(80, 660, 120, 30, 'Keuangan');
    box(380, 660, 120, 30, 'Operasional');
    p.drawLine({ start: { x: 290, y: 740 }, end: { x: 290, y: 715 }, thickness: 1, color: rgb(0, 0, 0) });
    p.drawLine({ start: { x: 140, y: 715 }, end: { x: 440, y: 715 }, thickness: 1, color: rgb(0, 0, 0) });
    p.drawLine({ start: { x: 140, y: 715 }, end: { x: 140, y: 690 }, thickness: 1, color: rgb(0, 0, 0) });
    p.drawLine({ start: { x: 440, y: 715 }, end: { x: 440, y: 690 }, thickness: 1, color: rgb(0, 0, 0) });
  });
  const r = await convertBytes(bytes);
  assert.equal(tablesOf(r.model).length, 0);
});

test('tables: NOT a table: two columns of prose (also when every line is the same length)', async () => {
  const left = Array.from({ length: 16 }, (_, k) => `kiri ${String(k + 1).padStart(2, '0')} aaaaaaaaaaaaaaaaaaaaaaa`);
  const right = Array.from({ length: 16 }, (_, k) => `kanan ${String(k + 1).padStart(2, '0')} bbbbbbbbbbbbbbbbbbbb`);
  const bytes = await makePdf((pages, { fonts }) => {
    left.forEach((t, k) => pages[0].drawText(t, { x: 50, y: 760 - k * 14, size: 9, font: fonts.mono }));
    right.forEach((t, k) => pages[0].drawText(t, { x: 320, y: 760 - k * 14, size: 9, font: fonts.mono }));
  });
  const r = await convertBytes(bytes);
  assert.equal(tablesOf(r.model).length, 0);
  assert.equal(r.stats.columnBands, 1, 'it is a column band instead');
});

test('tables: NOT a table: two columns of prose whose lines the PDF emitted row by row (so reading order does not give them away)', async () => {
  const bytes = await makePdf((pages, { fonts }) => {
    for (let k = 0; k < 16; k += 1) {
      pages[0].drawText(`kiri ${String(k + 1).padStart(2, '0')} aaaaaaaaaaaaaaaaaaaaaaa`, { x: 50, y: 760 - k * 14, size: 9, font: fonts.mono });
      pages[0].drawText(`kanan ${String(k + 1).padStart(2, '0')} bbbbbbbbbbbbbbbbbbbb`, { x: 320, y: 760 - k * 14, size: 9, font: fonts.mono });
    }
  });
  const r = await convertBytes(bytes);
  assert.equal(tablesOf(r.model).length, 0);
});

test('tables: NOT a table: a numbered list, a nested outline, and a table of contents', async () => {
  const bytes = await makePdf((pages, { fonts }) => {
    const p = pages[0];
    const item = (y, mark, text, x = 72) => { p.drawText(mark, { x, y, size: 10, font: fonts.reg }); p.drawText(text, { x: x + 24, y, size: 10, font: fonts.reg }); };
    item(780, '1.', 'Peserta wajib membawa kartu identitas');
    item(764, '2.', 'Peserta datang lima belas menit lebih awal');
    item(748, '3.', 'Peserta mengisi daftar hadir');
    item(732, '4.', 'Peserta menjaga ketertiban');
    item(700, '3)', 'persiapan teknis pelaksanaan');
    item(686, 'a)', 'penyimpulan data awal;', 96);
    item(672, 'b)', 'penyiapan metodologi;', 96);
    item(658, 'c)', 'penyiapan rencana kerja;', 96);
    ['Kata Pengantar', 'Daftar Isi', 'Bab 1 Pendahuluan', 'Bab 2 Landasan Teori', 'Bab 3 Metode Penelitian'].forEach((t, k) => {
      p.drawText(t, { x: 72, y: 600 - k * 16, size: 10, font: fonts.reg });
      p.drawText(['i', 'ii', '1', '9', '23'][k], { x: 480, y: 600 - k * 16, size: 10, font: fonts.reg });
    });
  });
  const r = await convertBytes(bytes);
  assert.equal(tablesOf(r.model).length, 0, `no table, got ${tablesOf(r.model).map((t) => gridOf(t).slice(0, 2).join('/'))}`);
});

test('tables: NOT a table: a long sentence in a column of short cells, a justified paragraph cut at its word gaps', async () => {
  const bytes = await makePdf((pages, { fonts }) => {
    const p = pages[0];
    // a justified line: equal gaps, flush right
    const words = ['Pemerintah', 'daerah', 'wajib', 'menyusun', 'rencana', 'tata', 'ruang', 'wilayah'];
    for (let k = 0; k < 6; k += 1) {
      let x = 72;
      words.forEach((w) => { p.drawText(w, { x, y: 760 - k * 14, size: 10, font: fonts.reg }); x += fonts.reg.widthOfTextAtSize(w, 10) + 14; });
    }
  });
  const r = await convertBytes(bytes);
  assert.equal(tablesOf(r.model).length, 0);
});

// ---- borderless and rule-bounded tables ----------------------------------------------------------------------
test('tables: aligned columns with no lines at all (a statement of figures) become a table with right-hand figures kept in order', async () => {
  const bytes = await makePdf((pages, { fonts }) => {
    const p = pages[0];
    const rows = [['Keterangan', '2023', '2022', '2021'], ['Penjualan bersih', '2.050.460', '2.044.822', '1.850.311'], ['Laba kotor', '412.300', '398.140', '350.020'],
      ['Beban usaha', '210.115', '205.980', '190.450'], ['Laba usaha', '202.185', '192.160', '159.570']];
    rows.forEach((row, k) => row.forEach((t, c) => p.drawText(t, { x: [72, 250, 340, 430][c], y: 700 - k * 18, size: 10, font: k === 0 ? fonts.bold : fonts.reg })));
  });
  const r = await convertBytes(bytes);
  const ts = tablesOf(r.model);
  assert.equal(ts.length, 1);
  assert.equal(ts[0].src, 'text');
  assert.equal(ts[0].rows.length, 5);
  assert.equal(ts[0].colsPt.length, 4);
  assert.deepEqual(gridOf(ts[0])[1], ['Penjualan bersih', '2.050.460', '2.044.822', '1.850.311']);
  assert.deepEqual(validateModel(r.model), []);
});

test('tables: three horizontal rules and no verticals (the academic table) is a table whose header carries the rules as borders', async () => {
  const bytes = await makePdf((pages, { fonts, rgb }) => {
    const p = pages[0];
    const rule = (y, w = 1) => p.drawLine({ start: { x: 72, y }, end: { x: 523, y }, thickness: w, color: rgb(0, 0, 0) });
    rule(720, 1.2); rule(702, 0.6); rule(630, 1.2);
    const rows = [['Model', 'Akurasi', 'Waktu'], ['Regresi', '0,81', '12 ms'], ['Pohon', '0,86', '30 ms'], ['Jaringan', '0,91', '210 ms'], ['Ensambel', '0,93', '480 ms']];
    const ys = [708, 688, 670, 652, 636];
    rows.forEach((row, k) => row.forEach((t, c) => p.drawText(t, { x: [80, 260, 400][c], y: ys[k], size: 10, font: fonts.reg })));
  });
  const r = await convertBytes(bytes);
  const ts = tablesOf(r.model);
  assert.equal(ts.length, 1, `one table, got ${ts.length}`);
  assert.equal(ts[0].src, 'rules-h');
  assert.ok(ts[0].rows[0].every((c) => c.borders && c.borders.top && c.borders.bottom), 'the header row is ruled above and below');
  assert.ok(ts[0].rows[ts[0].rows.length - 1].every((c) => c.borders && c.borders.bottom), 'the last row is ruled below');
});

test('tables: a form block ends where its paragraph starts: label/value rows, a sentence, then another block are two tables and a paragraph', async () => {
  const bytes = await makePdf((pages, { fonts }) => {
    const p = pages[0];
    // tight leading (1.0 em): the line boxes of the sentence and of the first row overlap by a few points
    const form = (y0, labels) => labels.forEach((l, k) => { p.drawText(l, { x: 72, y: y0 - k * 12.5, size: 12, font: fonts.reg }); p.drawText(':', { x: 200, y: y0 - k * 12.5, size: 12, font: fonts.reg }); p.drawText('..............................', { x: 215, y: y0 - k * 12.5, size: 12, font: fonts.reg }); });
    p.drawText('Yang bertanda tangan di bawah ini:', { x: 72, y: 772, size: 12, font: fonts.reg });
    form(760, ['Nama', 'Alamat', 'Nomor Telepon', 'Pekerjaan']);
    p.drawText('Dengan ini menyatakan bahwa data yang saya berikan adalah benar adanya.', { x: 72, y: 690, size: 12, font: fonts.reg });
    form(678, ['Nama Ibu', 'Tempat Lahir', 'Tanggal Lahir', 'Agama']);
  });
  const r = await convertBytes(bytes);
  const ts = tablesOf(r.model);
  assert.equal(ts.length, 2);
  const texts = docText(r.documentXml);
  assert.equal(texts[0], 'Yang bertanda tangan di bawah ini:');
  assert.ok(texts.indexOf('Dengan ini menyatakan bahwa data yang saya berikan adalah benar adanya.') > texts.indexOf('Pekerjaan'));
  assert.ok(texts.indexOf('Dengan ini menyatakan bahwa data yang saya berikan adalah benar adanya.') < texts.indexOf('Nama Ibu'));
  // the table sits AFTER the sentence above it even though their line boxes overlap by a few points
  assert.ok(r.documentXml.indexOf('Yang bertanda tangan') < r.documentXml.indexOf('<w:tbl>'));
});

test('tables: borders drawn cell by cell (a rule in pieces) give the column lines: three columns, not one per odd gap', async () => {
  const bytes = await makePdf((pages, { fonts, rgb }) => {
    const p = pages[0];
    const f = fonts.reg;
    const xs = [72, 300, 420, 520];
    const rows = [['Data Statistik', 'Siklus I', 'Siklus II'], ['Rata-rata', '76,73', '80,27'], ['Skor Tertinggi', '91', '93'], ['Skor Terendah', '68', '67'], ['Jumlah Peserta', '25', '25'], ['Persentase Kategori', '4%', '12%']];
    for (let j = 0; j <= rows.length; j += 1) for (let c = 0; c < 3; c += 1) p.drawLine({ start: { x: xs[c] + (c ? 0.5 : 0), y: 740 - j * 18 }, end: { x: xs[c + 1], y: 740 - j * 18 }, thickness: 0.5, color: rgb(0, 0, 0) });
    rows.forEach((row, k) => row.forEach((t, c) => {
      const w = f.widthOfTextAtSize(t, 10);
      const x = c === 0 ? xs[0] + 4 : xs[c] + (xs[c + 1] - xs[c] - w) / 2; // the figures are centred in their column
      p.drawText(t, { x, y: 740 - k * 18 - 13, size: 10, font: f });
    }));
  });
  const r = await convertBytes(bytes);
  const [t] = tablesOf(r.model);
  assert.ok(t, 'a table');
  assert.equal(t.src, 'rules-h');
  assert.deepEqual(t.colsPt.map(Math.round), [228, 120, 100]);
  assert.deepEqual(gridOf(t)[1], ['Rata-rata', '76,73', '80,27']);
  assert.ok(t.rows.every((row) => row.every((c) => c.borders && c.borders.bottom)), 'every cell carries its bottom rule');
});

test('tables: NOT a table: a slice of a two-column page (a few lines happen to share baselines, the columns carry on above)', async () => {
  const bytes = await makePdf((pages, { fonts }) => {
    const p = pages[0];
    // ragged columns (no line reaches the same right edge twice in a row), emitted line by line; the right column sits 6 pt lower
    // than the left one except for its last four lines, so only those four share baselines with the left column's
    const lens = [29, 24, 27, 22, 29, 25];
    for (let k = 0; k < 16; k += 1) {
      p.drawText(`kiri ${String(k + 1).padStart(2, '0')} ${'a'.repeat(lens[k % 6] - 8)}`, { x: 50, y: 770 - k * 14, size: 9, font: fonts.mono });
      p.drawText(`kanan ${String(k + 1).padStart(2, '0')} ${'b'.repeat(lens[(k + 3) % 6] - 9)}`, { x: 320, y: 770 - k * 14 - (k < 12 ? 6 : 0), size: 9, font: fonts.mono });
    }
  });
  const r = await convertBytes(bytes);
  assert.equal(tablesOf(r.model).length, 0);
});

// ---- reading order as evidence ---------------------------------------------------------------------------------
test('tables: streamOrder reads a block both ways: a table emitted row by row has no row-major inversions, columns emitted column by column have no column-major ones', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ i }));
  // 4 rows x 2 columns; cell (r, c) holds one run
  const runs = mk(8).map((_, k) => ({ x: 0, y: 0, k }));
  const cellRuns = (r, c) => [runs[r * 2 + c]]; // emitted row by row: stream index = r * 2 + c
  const trows = [0, 1, 2, 3].map((r) => ({ cells: [0, 1].map((c) => ({ c0: c, c1: c, runs: cellRuns(r, c) })) }));
  const rowWise = streamOrder({ runs }, trows);
  assert.equal(rowWise.inv, 0);
  assert.ok(rowWise.colInv > rowWise.inv);
  // the same grid emitted column by column: stream index = c * 4 + r
  const colRuns = mk(8).map((_, k) => ({ x: 0, y: 0, k }));
  const trows2 = [0, 1, 2, 3].map((r) => ({ cells: [0, 1].map((c) => ({ c0: c, c1: c, runs: [colRuns[c * 4 + r]] })) }));
  const colWise = streamOrder({ runs: colRuns }, trows2);
  assert.equal(colWise.colInv, 0);
  assert.ok(colWise.inv > colWise.colInv);
});

test('tables: orderRefusal: out-of-order text is refused, and so is text that reads better down the columns', () => {
  assert.equal(orderRefusal({ inv: 0, colInv: 0.4 }), null);
  assert.equal(orderRefusal({ inv: 0.08, colInv: 0.02 }), null, 'a few cells out of order is not enough');
  assert.match(orderRefusal({ inv: 0.35, colInv: 0.5 }), /^order/);
  assert.match(orderRefusal({ inv: 0.15, colInv: 0.05 }), /^column-major/);
  assert.equal(orderRefusal({ inv: 0.15, colInv: 0.3 }), null, 'row order is still the better reading');
});

test('tables: dot leaders are not prose: a label : ............ form stays a table however long its leaders run', async () => {
  const bytes = await makePdf((pages, { fonts }) => {
    const p = pages[0];
    ['Nama', 'Alamat', 'Nomor Telepon', 'Pekerjaan', 'Tanggal Lahir'].forEach((l, k) => {
      p.drawText(l, { x: 72, y: 760 - k * 14, size: 10, font: fonts.reg });
      p.drawText(':', { x: 170, y: 760 - k * 14, size: 10, font: fonts.reg });
      p.drawText('.'.repeat(80), { x: 185, y: 760 - k * 14, size: 10, font: fonts.reg });
    });
  });
  const r = await convertBytes(bytes);
  assert.equal(tablesOf(r.model).length, 1);
});

// ---- cell content and geometry ----------------------------------------------------------------------------------
test('tables: a one-line cell never out-grows its row', async () => {
  const bytes = await makePdf((pages, { fonts, rgb }) => {
    ruledGrid(pages[0], fonts, {
      widths: [140, 140], heights: [13, 13, 13], rgb, size: 11,
      cells: [['Baris pertama', 'Nilai satu'], ['Baris kedua', 'Nilai dua'], ['Baris ketiga', 'Nilai tiga']],
    });
  });
  const r = await convertBytes(bytes);
  const [t] = tablesOf(r.model);
  assert.ok(t);
  t.rows.forEach((row, ri) => row.forEach((c) => {
    for (const p of c.blocks) assert.ok(!p.lineExact || p.lineExact <= t.rowsH[ri] + 1e-6, `row ${ri}: line ${p.lineExact} > row ${t.rowsH[ri]}`);
  }));
});

test('tables: a cell keeps its widest line 3 pt of room, spent from the margin (a hair-wider substitute font must not wrap it)', async () => {
  const text = 'Baris pertama panjang';
  let w = 0;
  const bytes = await makePdf((pages, { fonts, rgb }) => {
    w = fonts.reg.widthOfTextAtSize(text, 10);
    // the text starts 8 pt in and the cell ends 1.5 pt past its end: with the right margin that leaves 0.5 pt of room
    ruledGrid(pages[0], fonts, { top: 740, widths: [w + 9.5, 100], heights: [20, 20], rgb, cells: [['', 'b1'], ['', 'b2']] });
    pages[0].drawText(text, { x: 72 + 8, y: 740 - 14, size: 10, font: fonts.reg });
    pages[0].drawText('baris dua', { x: 72 + 8, y: 740 - 34, size: 10, font: fonts.reg });
  });
  const r = await convertBytes(bytes);
  const [t] = tablesOf(r.model);
  assert.ok(t);
  const cell = t.rows[0][0];
  assert.equal(cellText(cell), text);
  const room = t.colsPt[0] - cell.mar.l - cell.mar.r;
  assert.ok(room >= w + 3 - 0.2, `room ${room.toFixed(2)} for a text ${w.toFixed(2)} wide`);
});

test('tables: cell text keeps its alignment: a right-aligned figure column and a centred header', async () => {
  const bytes = await makePdf((pages, { fonts, rgb }) => {
    const { xs } = ruledGrid(pages[0], fonts, { top: 740, widths: [150, 100], heights: [22, 22, 22], rgb, cells: [['', ''], ['Gaji pokok', ''], ['Tunjangan', '']] });
    const f = fonts.reg;
    pages[0].drawText('Rincian', { x: xs[0] + (150 - f.widthOfTextAtSize('Rincian', 10)) / 2, y: 740 - 22 + 7, size: 10, font: f });
    pages[0].drawText('Jumlah', { x: xs[1] + (100 - f.widthOfTextAtSize('Jumlah', 10)) / 2, y: 740 - 22 + 7, size: 10, font: f });
    pages[0].drawText('5.000.000', { x: xs[2] - 6 - f.widthOfTextAtSize('5.000.000', 10), y: 740 - 44 + 7, size: 10, font: f });
    pages[0].drawText('750.000', { x: xs[2] - 6 - f.widthOfTextAtSize('750.000', 10), y: 740 - 66 + 7, size: 10, font: f });
  });
  const r = await convertBytes(bytes);
  const [t] = tablesOf(r.model);
  assert.ok(t);
  assert.equal(t.rows[0][0].blocks[0].align, 'center');
  assert.equal(t.rows[1][1].blocks[0].align, 'right');
  assert.equal(t.rows[2][1].blocks[0].align, 'right');
  assert.ok(!t.rows[1][0].blocks[0].align || t.rows[1][0].blocks[0].align === 'left');
});

test('tables: vector ART (more than MAX_PATH_OPS path operators) gets no ruled-table pass and still converts', async () => {
  const { MAX_PATH_OPS } = await import('../../js/docx/tables-rules.js');
  const bytes = await makePdf((pages, { fonts, rgb }) => {
    for (let k = 0; k < MAX_PATH_OPS + 200; k += 1) pages[0].drawLine({ start: { x: 20 + (k % 500), y: 300 + (k % 17) }, end: { x: 21 + (k % 500), y: 301 + (k % 13) }, thickness: 0.2, color: rgb(0.5, 0.5, 0.5) });
    ruledGrid(pages[0], fonts, { top: 780, widths: [80, 80], heights: [20, 20, 20], rgb, cells: [['a1', 'b1'], ['a2', 'b2'], ['a3', 'b3']] });
  });
  const r = await convertBytes(bytes);
  assert.equal(r.stats.errors.length, 0);
  assert.equal(tablesOf(r.model).filter((t) => t.src === 'ruled').length, 0, 'the ruled detector stood down');
  assert.deepEqual(packageIsClean(r.files), []);
});

// ---- the classifier ----------------------------------------------------------------------------------------------
test('tables: drawingReason refuses sparse, text-less, art-heavy grids and accepts a dense ruled one', () => {
  const dense = { edgeFrac: 0.95, cross: 0, art: 0, runs: 12, textCells: 8, cells: 9, grid: 9 };
  assert.equal(drawingReason(dense), null);
  assert.equal(drawingReason({ ...dense, textCells: 2 }), 'text');
  assert.equal(drawingReason({ ...dense, edgeFrac: 0.3 }), 'edge');
  assert.equal(drawingReason({ ...dense, edgeFrac: 0.6, textCells: 4 }), 'sparse');
  assert.equal(drawingReason({ ...dense, edgeFrac: 0.7, cross: 0.3 }), 'cross');
  assert.equal(drawingReason({ ...dense, edgeFrac: 0.85, art: 0.9 }), 'art');
  assert.equal(typeof gridQuality, 'function');
});
