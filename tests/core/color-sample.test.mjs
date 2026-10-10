/*
 * core/color-sample.js: paper and ink colours from raster samples (headless
 * since 2026-10-10; it lived in js/v2/app.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  medColor, inkColorFrom, coverColorFrom, whiteoutColorFrom, whiteoutRingPoints, paperPoints, inkPoints,
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

test('sample geometry: 20 ring points, 14 paper points outside the box, 24 ink points inside it', () => {
  const line = { x: 10, y: 20, w: 90, h: 12 };
  assert.equal(whiteoutRingPoints(50, 50, 2).length, 20);
  const paper = paperPoints(line, 2);
  assert.equal(paper.length, 14);
  const inBox = ([x, y]) => x >= line.x * 2 && x <= (line.x + line.w) * 2 && y >= line.y * 2 && y <= (line.y + line.h) * 2;
  assert.ok(paper.every((p) => !inBox(p)), 'a paper sample landed inside the line box (on the ink)');
  const ink = inkPoints(line, 2);
  assert.equal(ink.length, 24);
  assert.ok(ink.every(inBox));
});
