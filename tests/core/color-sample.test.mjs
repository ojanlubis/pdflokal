/*
 * core/color-sample.js: paper and ink colours from raster samples (headless
 * since 2026-10-10; it lived in js/v2/app.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  medColor, inkColorFrom, coverColorFrom, whiteoutColorFrom, whiteoutRingPoints, paperPoints, inkBoxRect, rgbaSamples,
} from '../../js/core/color-sample.js';

const gray = (v) => [v, v, v];

test('inkColorFrom: solid BLACK bold text is black, not the gray of its anti-aliased edges (founder 2026-07-19)', () => {
  const paper = Array(10).fill(gray(250));
  // A sparse grid over bold glyphs: mostly paper, many edge blends, few solid cores.
  const inside = [...Array(12).fill(gray(250)), ...Array(9).fill(gray(140)), ...Array(3).fill(gray(0))];
  // Known-positive for the bug: the old quartile median lands in the edges.
  const byDist = [...inside].sort((a, b) => a[0] - b[0]).slice(0, 6);
  assert.equal(medColor(byDist), '#8c8c8c', 'the instrument no longer reproduces the gray it guards against');
  assert.equal(inkColorFrom(inside, paper), '#000000');
});

test('inkColorFrom: faint anti-aliasing on plain paper never tints the text', () => {
  const paper = Array(10).fill(gray(250));
  assert.equal(inkColorFrom([...Array(20).fill(gray(250)), gray(225)], paper), null);
  assert.equal(inkColorFrom([], paper), null);
});

test('navy heading on cream paper: cover is cream, ink is navy', () => {
  const cream = [245, 238, 220];
  const navy = [20, 30, 90];
  assert.equal(coverColorFrom(Array(14).fill(cream)), '#f5eedc');
  assert.equal(inkColorFrom([...Array(16).fill(cream), ...Array(8).fill(navy)], Array(14).fill(cream)), '#141e5a');
});

test('too few samples: no colour is invented', () => {
  assert.equal(coverColorFrom(Array(5).fill(gray(200))), null);
  assert.equal(whiteoutColorFrom(Array(7).fill(gray(200))), null);
  assert.equal(whiteoutColorFrom(Array(8).fill(gray(200))), '#c8c8c8');
});

test('sample geometry: 20 ring points, 14 paper points outside the box, the ink rect inside it', () => {
  const line = { x: 10, y: 20, w: 90, h: 12 };
  assert.equal(whiteoutRingPoints(50, 50, 2).length, 20);
  const paper = paperPoints(line, 2);
  assert.equal(paper.length, 14);
  const inBox = ([x, y]) => x >= line.x * 2 && x <= (line.x + line.w) * 2 && y >= line.y * 2 && y <= (line.y + line.h) * 2;
  assert.ok(paper.every((p) => !inBox(p)), 'a paper sample landed inside the line box (on the ink)');
  assert.deepEqual(inkBoxRect(line, 2, 400, 400), { x: 20, y: 40, w: 180, h: 24 });
  assert.deepEqual(inkBoxRect(line, 2, 100, 400), { x: 20, y: 40, w: 80, h: 24 }, 'clamped to the raster');
  assert.equal(inkBoxRect(line, 2, 10, 400), null, 'a box wholly off the raster yields no samples');
});

// Feedback 100356 / 100108: regular-weight black text came back gray. A raster of
// 1px black stems (every 8th column) each flanked by an anti-aliased gray column,
// the shape of 8-12pt body text at 2x. The OLD reader took a 24-point grid.
test('inkColorFrom: thin black stems read black off the whole box, not gray off a sparse grid (feedback 100356)', () => {
  const W = 180; const H = 24; const line = { x: 0, y: 0, w: W / 2, h: H / 2 };
  const data = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const m = x % 8; // 3 = core, 2 and 4 = anti-aliased edges, the rest paper
      const v = m === 3 ? 0 : (m === 2 || m === 4) ? 150 : 255;
      data.set([v, v, v, 255], (y * W + x) * 4);
    }
  }
  const paper = Array(14).fill(gray(255));
  // The old reader, as it was: 8 x 3 grid at (ix/9, iy/4) of the box.
  const grid = [];
  for (let ix = 1; ix <= 8; ix += 1) {
    for (let iy = 1; iy <= 3; iy += 1) {
      const x = Math.round((W * ix) / 9); const y = Math.round((H * iy) / 4);
      const o = (y * W + x) * 4;
      grid.push([data[o], data[o + 1], data[o + 2]]);
    }
  }
  const sparse = inkColorFrom(grid, paper);
  assert.notEqual(sparse, '#000000', 'the fixture no longer reproduces the gray the grid produced');
  assert.equal(inkColorFrom(rgbaSamples(data), paper), '#000000');
});

test('rgbaSamples: strides big boxes down and keeps [r, g, b] shape', () => {
  const data = new Uint8ClampedArray(100 * 4).fill(7);
  assert.equal(rgbaSamples(data).length, 100);
  const some = rgbaSamples(data, 10);
  assert.ok(some.length <= 10 && some.length > 0);
  assert.deepEqual(some[0], [7, 7, 7]);
});
