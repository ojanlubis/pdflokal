import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimatePaper, paperAt } from '../../js/core/scan-paper.js';

const original = (x, y) => [240 - 60 * x - 12 * y, 235 - 60 * x - 12 * y, 225 - 60 * x - 12 * y];
function ring() {
  const s = [];
  for (let i = 0; i <= 20; i += 1) for (const [x, y] of [[i / 20, -0.2], [i / 20, 1.2], [-0.1, i / 20], [1.1, i / 20]]) {
    s.push({ x, y, rgb: original(x, y) });
  }
  return s;
}
test('shading follows the known paper inside the box, unlike a flat median', () => {
  const plane = estimatePaper(ring());
  assert.ok(plane);
  for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.3, 0.6]]) {
    paperAt(plane, x, y).forEach((v, ch) => assert.ok(Math.abs(v - original(x, y)[ch]) < 0.1));
  }
});
test('sparse neighboring ink is excluded, rather than smeared into the cover', () => {
  const samples = ring();
  for (let i = 7; i < samples.length; i += 13) samples[i].rgb = [20, 20, 20];
  const plane = estimatePaper(samples);
  assert.ok(plane);
  paperAt(plane, 0.6, 0.4).forEach((v, ch) => assert.ok(Math.abs(v - original(0.6, 0.4)[ch]) < 1));
});
test('page edge, discontinuous shadow, and invalid pixels decline', () => {
  assert.equal(estimatePaper(ring().filter((s) => s.y >= 0)), null);
  assert.equal(estimatePaper(ring().map((s) => ({ ...s, rgb: s.x < 0.5 ? [240, 240, 240] : [100, 100, 100] }))), null);
  const bad = ring(); bad[0].rgb[0] = NaN;
  assert.equal(estimatePaper(bad), null);
});
