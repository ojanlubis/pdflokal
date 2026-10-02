/*
 * docx/model.js: the intermediate document model every lane reads and writes.
 * validateModel is the guard a lane's output goes through before it reaches the writer, so
 * each rule below is pinned by a model that breaks it (a validator that cannot go red is decoration).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDoc, makePage, makePara, makeSegment, validateModel, median, percentile, A4 } from '../../js/docx/model.js';
import { loadLibs } from './docx-helpers.mjs';
import { encodePng } from '../../js/docx/png.js';

const png = () => encodePng(loadLibs().fflate, 2, 2, 3, new Uint8Array(12).fill(200));
const goodPage = () => makePage({ segments: [makeSegment({ blocks: [makePara('Halo dunia', { runs: [{ t: 'Halo', b: true, c: 'FF0000', sz: 11 }, { t: ' dunia' }] })] })] });

test('model: a well-formed document has no problems', () => {
  assert.deepEqual(validateModel(makeDoc([goodPage(), makePage()])), []);
});

test('model: factories give A4 and one empty segment', () => {
  const p = makePage();
  assert.equal(p.widthPt, A4.widthPt);
  assert.equal(p.heightPt, A4.heightPt);
  assert.equal(p.segments.length, 1);
  assert.deepEqual(makePara('').runs, []);
});

const breaks = [
  ['a NaN length', (d) => { d.pages[0].segments[0].blocks[0].indentLeft = NaN; }, /indentLeft/],
  ['a negative margin', (d) => { d.pages[0].segments[0].marginPt.left = -1; }, /marginPt\.left/],
  ['a colour that is not 6 hex digits', (d) => { d.pages[0].segments[0].blocks[0].runs[0].c = 'red'; }, /bad colour/],
  ['a zero page width', (d) => { d.pages[0].widthPt = 0; }, /page size/],
  ['a run with neither text nor xml', (d) => { d.pages[0].segments[0].blocks[0].runs.push({ b: true }); }, /run needs/],
  ['an image with no bytes', (d) => { d.pages[0].anchors.push({ kind: 'img', ext: 'png', wPt: 5, hPt: 5, bytes: new Uint8Array(0) }); }, /no bytes/],
  ['an image of an unknown type', (d) => { d.pages[0].anchors.push({ kind: 'img', ext: 'gif', wPt: 5, hPt: 5, bytes: new Uint8Array(3) }); }, /ext/],
  ['an anchored image without a position', (d) => { d.pages[0].anchors.push({ kind: 'img', ext: 'png', wPt: 5, hPt: 5, bytes: png(), anchor: { x: 1 } }); }, /anchor/],
  ['a table whose row spans the wrong number of columns', (d) => { d.pages[0].segments[0].blocks.push({ kind: 'tbl', colsPt: [50, 50], rows: [[{ blocks: [] }]] }); }, /spans 1 columns/],
  ['a table with a bad cell fill', (d) => { d.pages[0].segments[0].blocks.push({ kind: 'tbl', colsPt: [50], rows: [[{ blocks: [], fill: 'zz' }]] }); }, /bad fill/],
  ['a block with no kind', (d) => { d.pages[0].segments[0].blocks.push({}); }, /without kind/],
];
for (const [what, mutate, re] of breaks) {
  test(`model: validateModel goes red on ${what}`, () => {
    const d = makeDoc([goodPage()]);
    mutate(d);
    const bad = validateModel(d);
    assert.ok(bad.length > 0, 'expected a problem');
    assert.match(bad.join('\n'), re);
  });
}

test('model: a table whose cells span the grid is valid', () => {
  const d = makeDoc([makePage({ segments: [makeSegment({ blocks: [{ kind: 'tbl', colsPt: [50, 50, 50], rows: [[{ blocks: [makePara('a')], span: 2, fill: 'EEEEEE' }, { blocks: [] }]] }] })] })]);
  assert.deepEqual(validateModel(d), []);
});

test('model: median and percentile', () => {
  assert.equal(median([]), 0);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 10);
  assert.equal(percentile([], 0.5), 0);
});
