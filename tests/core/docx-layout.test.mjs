/*
 * docx/layout.js: reading order on synthetic pages (pdf-lib draws, the whole pipeline runs, the order
 * of the words in the written document.xml is the assertion). Each test is one failure the corpus
 * showed (scripts/docx-gate.mjs, per page): a headline that hides a column gutter, a gutter narrower
 * than the line grouper's guard, a centred page number read in the middle of the page, a grid of
 * cards read column by column, a figure between two text columns.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadLibs, makePdf, convertBytes, docText } from './docx-helpers.mjs';
import { stockFont, dominantFont, wrapJoin } from '../../js/docx/layout.js';

loadLibs();

// Word indexes (first occurrence of each tag) in the order the document reads them.
const order = (xml, tags) => {
  const text = docText(xml).join(' ');
  return tags.map((t) => text.indexOf(t));
};
const ascending = (a) => a.every((v, k) => v >= 0 && (k === 0 || v > a[k - 1]));

// `n` lines "<tag>1 ... <tag>n" of fixed Courier width, `step` apart from (x, top).
const column = (page, font, tag, n, { x, top, step = 12, size = 9, width = 34 }) => {
  for (let k = 0; k < n; k += 1) page.drawText(`${tag}${k + 1} lorem ipsum dolor sit amet`.padEnd(width, ' lorem').slice(0, width), { x, y: top - k * step, size, font });
};

test('layout: a headline across both columns does not make the page read row by row', async () => {
  const bytes = await makePdf((pages, { fonts }) => {
    const p = pages[0];
    p.drawText('HEADLINE spanning the whole page width of the layout here', { x: 50, y: 800, size: 14, font: fonts.mono });
    column(p, fonts.mono, 'LEFT', 14, { x: 50, top: 740, step: 14 });
    column(p, fonts.mono, 'RIGHT', 14, { x: 320, top: 740, step: 14 });
  });
  const { documentXml } = await convertBytes(bytes);
  assert.ok(ascending(order(documentXml, ['HEADLINE', 'LEFT1', 'LEFT14', 'RIGHT1', 'RIGHT14'])), JSON.stringify(docText(documentXml)));
});

test('layout: columns 8pt apart (narrower than the line grouper guard) are read column by column', async () => {
  const bytes = await makePdf((pages, { fonts }) => {
    const p = pages[0];
    column(p, fonts.mono, 'LEFT', 16, { x: 50, top: 760, width: 40 });
    column(p, fonts.mono, 'RIGHT', 16, { x: 50 + 40 * 5.4 + 8, top: 760, width: 40 });
  });
  const { documentXml } = await convertBytes(bytes);
  assert.ok(ascending(order(documentXml, ['LEFT1', 'LEFT16', 'RIGHT1', 'RIGHT16'])), JSON.stringify(docText(documentXml)));
});

test('layout: a page number at the foot is read after the body, a running header before it', async () => {
  const bytes = await makePdf((pages, { fonts }) => {
    const p = pages[0];
    p.drawText('RUNNING header of the journal', { x: 50, y: 815, size: 8, font: fonts.mono });
    column(p, fonts.mono, 'LEFT', 14, { x: 50, top: 700 });
    column(p, fonts.mono, 'RIGHT', 14, { x: 320, top: 700 });
    p.drawText('PAGENUM 12', { x: 270, y: 25, size: 8, font: fonts.mono });
  });
  const { documentXml } = await convertBytes(bytes);
  assert.ok(ascending(order(documentXml, ['RUNNING', 'LEFT1', 'RIGHT14', 'PAGENUM'])), JSON.stringify(docText(documentXml)));
});

test('layout: a grid of cards (three columns, a picture band between the rows) reads row by row', async () => {
  const bytes = await makePdf((pages, { fonts }) => {
    const p = pages[0];
    for (const [c, x] of [['A', 40], ['B', 230], ['C', 420]]) {
      column(p, fonts.mono, `${c}TOP`, 6, { x, top: 780, width: 28 });
      column(p, fonts.mono, `${c}BOT`, 6, { x, top: 520, width: 28 });
    }
  });
  const { documentXml } = await convertBytes(bytes);
  assert.ok(ascending(order(documentXml, ['ATOP1', 'BTOP1', 'CTOP1', 'ABOT1', 'BBOT1', 'CBOT1'])), JSON.stringify(docText(documentXml)));
});

test('layout: two text columns with a figure between them keep each column in one piece', async () => {
  const bytes = await makePdf((pages, { fonts }) => {
    const p = pages[0];
    column(p, fonts.mono, 'LTOP', 6, { x: 50, top: 780 });
    column(p, fonts.mono, 'RTOP', 6, { x: 320, top: 780 });
    column(p, fonts.mono, 'LBOT', 6, { x: 50, top: 520 });
    column(p, fonts.mono, 'RBOT', 6, { x: 320, top: 520 });
  });
  const { documentXml } = await convertBytes(bytes);
  assert.ok(ascending(order(documentXml, ['LTOP1', 'LBOT1', 'RTOP1', 'RBOT1'])), JSON.stringify(docText(documentXml)));
});

test('layout: a running head that sits right on one column is read before both columns', async () => {
  const bytes = await makePdf((pages, { fonts }) => {
    const p = pages[0];
    p.drawText('RUNNINGHEAD of the journal 495', { x: 300, y: 820, size: 8, font: fonts.mono });
    column(p, fonts.mono, 'LEFT', 14, { x: 50, top: 806, step: 14, size: 10 });
    column(p, fonts.mono, 'RIGHT', 14, { x: 320, top: 806, step: 14, size: 10 });
  });
  const { documentXml } = await convertBytes(bytes);
  assert.ok(ascending(order(documentXml, ['RUNNINGHEAD', 'LEFT1', 'LEFT14', 'RIGHT1', 'RIGHT14'])), JSON.stringify(docText(documentXml)));
});

test('layout: a line the typesetter hyphenated is one word again, a real hyphen stays', async () => {
  const lines = [
    'aaaa bbbb cccc dddd eeee ffff gggg pro-',
    'gram hhhh iiii jjjj kkkk llll sehari-',
    'hari nnnn oooo pppp qqqq rrrr ssss tttt',
  ];
  const bytes = await makePdf((pages, { fonts }) => {
    lines.forEach((t, k) => pages[0].drawText(t.padEnd(39, ' '), { x: 60, y: 760 - k * 14, size: 10, font: fonts.mono }));
  });
  const { documentXml } = await convertBytes(bytes);
  const text = docText(documentXml).join(' ');
  assert.ok(text.includes('pro­gram'), text);
  assert.ok(text.includes('sehari-hari'), text);
});

test('layout: a right-aligned single line gets the whole column, so a wider fallback font cannot wrap it', async () => {
  const bytes = await makePdf((pages, { fonts }) => {
    const p = pages[0];
    column(p, fonts.mono, 'BODY', 8, { x: 50, top: 700, width: 82, size: 10 });
    p.drawText('RIGHT01', { x: 50 + 82 * 6 - 7 * 6, y: 500, size: 10, font: fonts.mono });
  });
  const { model } = await convertBytes(bytes);
  const blocks = model.pages[0].segments.flatMap((s) => s.blocks);
  const right = blocks.find((b) => b.kind === 'p' && b.align === 'right');
  assert.ok(right, 'a right-aligned paragraph is found');
  assert.ok(!right.indentLeft, `indentLeft ${right.indentLeft}`);
});

test('layout: a footer under a body that nearly fills the page is pulled up, so Word drift does not push it onto a page of its own', async () => {
  const bytes = await makePdf((pages, { fonts }) => {
    const p = pages[0];
    column(p, fonts.mono, 'BODY', 52, { x: 50, top: 800, step: 14, size: 10, width: 80 });
    p.drawText('FOOTER 7', { x: 270, y: 40, size: 8, font: fonts.mono });
  });
  const { model } = await convertBytes(bytes);
  const blocks = model.pages[0].segments.flatMap((s) => s.blocks);
  const foot = blocks[blocks.length - 1];
  assert.ok(/FOOTER/.test(foot.runs.map((r) => r.t).join('')), 'the footer is the last block');
  assert.ok(foot.spaceBefore < 10, `footer spaceBefore ${foot.spaceBefore}`);
});

test('layout: a title centred in several lines stays several centred paragraphs (each line keeps its own break)', async () => {
  const bytes = await makePdf((pages, { fonts }) => {
    const p = pages[0];
    ['DECISION OF THE', 'HEAD OF THE EDUCATION OFFICE', 'EAST JAVA PROVINCE'].forEach((t, k) => {
      p.drawText(t, { x: 297.5 - (t.length * 7.2) / 2, y: 780 - k * 16, size: 12, font: fonts.mono });
    });
    column(p, fonts.mono, 'BODY', 10, { x: 60, top: 650, width: 72, size: 10 });
  });
  const { model } = await convertBytes(bytes);
  const blocks = model.pages[0].segments.flatMap((s) => s.blocks);
  const lines = ['DECISION OF THE', 'HEAD OF THE EDUCATION OFFICE', 'EAST JAVA PROVINCE'];
  const paras = lines.map((t) => blocks.find((x) => x.kind === 'p' && x.runs.map((r) => r.t).join('') === t));
  assert.ok(paras.every(Boolean), `each title line is a paragraph of its own: ${JSON.stringify(blocks.map((x) => x.runs && x.runs.map((r) => r.t).join('')))}`);
  assert.equal(paras[0].align, 'center');
  assert.equal(paras[2].align, 'center');
});

test('layout: two short columns side by side (4 lines each) are one column band, not two blocks stacked', async () => {
  const bytes = await makePdf((pages, { fonts }) => {
    const p = pages[0];
    column(p, fonts.mono, 'BODY', 8, { x: 50, top: 780, width: 82, size: 10 });
    column(p, fonts.mono, 'LEFT', 4, { x: 50, top: 600, step: 14, size: 10, width: 36 });
    column(p, fonts.mono, 'RIGHT', 4, { x: 320, top: 600, step: 14, size: 10, width: 36 });
  });
  const { model, documentXml } = await convertBytes(bytes);
  const bands = model.pages[0].segments.filter((s) => s.cols > 1);
  assert.equal(bands.length, 1, JSON.stringify(model.pages[0].segments.map((s) => s.cols)));
  assert.ok(ascending(order(documentXml, ['LEFT1', 'LEFT4', 'RIGHT1', 'RIGHT4'])));
});

test('layout: the stock-font test and the dominant font of a paragraph; wrapJoin decisions', () => {
  assert.ok(stockFont('Times New Roman') && stockFont('Arial') && stockFont('Tahoma'));
  assert.ok(!stockFont('Whyte') && !stockFont('Barlow') && !stockFont(''));
  assert.equal(dominantFont([{ t: 'ab', f: 'Arial' }, { t: 'abcdef', f: 'Whyte' }, { t: 'x', f: 'Arial' }]), 'Whyte');
  assert.equal(wrapJoin('pro-', 'gram'), 'soft');
  assert.equal(wrapJoin('sehari-', 'hari'), 'keep');
  assert.equal(wrapJoin('Covid-', '19'), 'keep');
  assert.equal(wrapJoin('non-', 'aktif'), 'keep');
  assert.equal(wrapJoin('ini', 'itu'), 'space');
  assert.equal(wrapJoin('x -', 'Tim'), 'space');
});
