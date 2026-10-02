/*
 * golden-ink-compare.test.mjs — the golden suite's tolerance is relative to INK.
 * ============================================================================
 * THE GAP (audit 2026-08-17, item 1). tests/golden/render-helpers.js allowed
 * 0.5% of page AREA to differ. On a 595x842 page that is ~2,400 pixels; the
 * entire ink of the committed baseline pages is 1,070-1,340. A page with every
 * word missing was inside the tolerance, so the suite could not fail on
 * content. These cases pin the property on the REAL committed baselines:
 *
 *   1. a deleted word  — the OLD area check passes it, compareInk fails it
 *   2. a deleted single letter fails
 *   3. cross-platform-style drift (sub-pixel shift, blur, stem weight) passes
 *   4. identical / blank-vs-blank pass; dimension change fails
 *
 * Case 1 asserts BOTH halves on purpose: that the area check really is blind
 * to it (so this test would have been red-on-nothing before the fix) and that
 * the ink check is not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { compareInk } from '../golden/ink-compare.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASELINES = path.join(here, '..', 'golden', 'baselines');
// The value render-helpers.js uses for the coarse area check.
const ALLOWED_DIFF_RATIO = 0.005;

const load = (name) => PNG.sync.read(fs.readFileSync(path.join(BASELINES, name)));
const clone = (p) => ({ width: p.width, height: p.height, data: Buffer.from(p.data) });
const clamp = (v) => Math.max(0, Math.min(255, v));

function erase(p, x0, y0, x1, y1) {
  const o = clone(p);
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const i = (y * p.width + x) * 4;
      o.data[i] = o.data[i + 1] = o.data[i + 2] = 255;
    }
  }
  return o;
}

// Bilinear resample at a sub-pixel offset: what a different rasteriser's
// hinting does to every glyph edge.
function shift(p, dx, dy) {
  const o = clone(p);
  const fx = Math.floor(-dx);
  const fy = Math.floor(-dy);
  const tx = -dx - fx;
  const ty = -dy - fy;
  for (let y = 0; y < p.height; y += 1) {
    for (let x = 0; x < p.width; x += 1) {
      for (let c = 0; c < 3; c += 1) {
        const g = (xx, yy) =>
          p.data[(Math.min(p.height - 1, Math.max(0, yy)) * p.width + Math.min(p.width - 1, Math.max(0, xx))) * 4 + c];
        o.data[(y * p.width + x) * 4 + c] =
          (1 - tx) * (1 - ty) * g(x + fx, y + fy) + tx * (1 - ty) * g(x + fx + 1, y + fy) +
          (1 - tx) * ty * g(x + fx, y + fy + 1) + tx * ty * g(x + fx + 1, y + fy + 1);
      }
    }
  }
  return o;
}

function blur(p) {
  const o = clone(p);
  for (let y = 1; y < p.height - 1; y += 1) {
    for (let x = 1; x < p.width - 1; x += 1) {
      for (let c = 0; c < 3; c += 1) {
        let s = 0;
        for (let j = -1; j <= 1; j += 1) for (let i = -1; i <= 1; i += 1) s += p.data[((y + j) * p.width + x + i) * 4 + c] * (i === 0 && j === 0 ? 4 : 1);
        o.data[(y * p.width + x) * 4 + c] = s / 12;
      }
    }
  }
  return o;
}

function weight(p, k) {
  const o = clone(p);
  for (let i = 0; i < o.data.length; i += 4) for (let c = 0; c < 3; c += 1) o.data[i + c] = clamp(255 - (255 - p.data[i + c]) * k);
  return o;
}

const areaRatio = (a, b) => pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 }) / (a.width * a.height);

// scenario-01 page 1: "Test Page 1" at y 44-53 and the GOLDEN annotation
// (24pt) at x 100-224, y 424-447.
const PAGE = 'scenario-01-text-helvetica-page-1.png';

test('a deleted word passes the old area check and FAILS the ink check', () => {
  const base = load(PAGE);
  const noWord = erase(base, 95, 420, 230, 450);
  assert.ok(areaRatio(base, noWord) <= ALLOWED_DIFF_RATIO, 'precondition: the area-relative check is blind to this');
  const r = compareInk(base, noWord);
  assert.equal(r.fail, true, `ink check must fail a missing word (${r.changedBlocks}/${r.inkBlocks} blocks changed)`);
});

test('a deleted single letter fails', () => {
  const base = load(PAGE);
  const r = compareInk(base, erase(base, 100, 424, 118, 447));
  assert.equal(r.fail, true);
});

test('the small original text going missing fails too', () => {
  const base = load(PAGE);
  assert.equal(compareInk(base, erase(base, 50, 40, 110, 56)).fail, true);
});

test('cross-platform style drift passes (shift, blur, stem weight)', () => {
  for (const name of fs.readdirSync(BASELINES)) {
    const base = load(name);
    const variants = {
      shift: shift(base, 0.5, 0.3),
      blur: blur(base),
      lighter: weight(base, 0.85),
      heavier: weight(base, 1.15),
      combined: weight(blur(shift(base, 0.4, 0.4)), 0.9),
    };
    for (const [label, drifted] of Object.entries(variants)) {
      const r = compareInk(base, drifted);
      assert.equal(r.fail, false, `${name} ${label}: ${r.changedBlocks}/${r.inkBlocks} blocks changed`);
    }
  }
});

test('identical passes; blank against blank passes; a dimension change fails', () => {
  const base = load(PAGE);
  assert.equal(compareInk(base, clone(base)).fail, false);
  const blank = { width: 100, height: 100, data: Buffer.alloc(100 * 100 * 4, 255) };
  assert.equal(compareInk(blank, clone(blank)).fail, false);
  assert.equal(compareInk(blank, { width: 100, height: 120, data: Buffer.alloc(100 * 120 * 4, 255) }).fail, true);
});

test('an entirely blank render against a populated baseline fails', () => {
  const base = load(PAGE);
  const blank = { width: base.width, height: base.height, data: Buffer.alloc(base.data.length, 255) };
  assert.ok(areaRatio(base, blank) <= ALLOWED_DIFF_RATIO, 'precondition: even a blank page is inside the area tolerance');
  assert.equal(compareInk(base, blank).fail, true);
});
