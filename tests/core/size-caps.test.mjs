/*
 * A SIZE PRESET NEVER OVERSHOOTS ANY READING OF "KB".
 * ============================================================================
 * "Kompres PDF 200KB" promises a file a portal will accept. A portal that reads
 * KB as 1000 bytes rejects a 204,000-byte file that the page said "muat di bawah
 * 200 KB". We cannot know which base a given portal enforces, so the caps are the
 * SMALLER reading: 200 KB is 200,000 bytes, and a file under that passes both.
 *
 * THREE CHECKS, each of which goes red alone:
 *   1. the table itself: every preset <= its label read in decimal
 *   2. the pages: every seo/pages.json `target` is a preset (else download-sheet's
 *      "only honour one we offer" quietly degrades the page to Otomatis) and equals
 *      the decimal bytes of the size in its slug
 *   3. the behaviour: the REAL ladder search, run against the REAL table, with the
 *      rasteriser and PDF writer faked. The size model puts exactly one rung
 *      (quality 0.62) between "<= limit read in decimal" and "<= limit read in
 *      binary" (x1.0235), so a table in 1024-based bytes picks that rung and
 *      overshoots, and a table in decimal steps past it. A fixture that fits under
 *      BOTH tables would pass on the broken build and prove nothing.
 *
 * ⚠️ WHAT THIS DOES NOT PROVE: real JPEG sizes. tests/compress-target.spec.js
 * checks real downloaded bytes in a browser, in CI. Node has no canvas.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TARGETS } from '../../js/v2/download-sheet.js';
import { compressToTargetBytes } from '../../js/core/compress.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PAGES = JSON.parse(fs.readFileSync(path.join(ROOT, 'seo/pages.json'), 'utf8')).pages;

const decimalBytes = (label) => {
  const m = /^(\d+) (KB|MB)$/.exec(label);
  assert.ok(m, `unparseable preset label "${label}"`);
  return Number(m[1]) * (m[2] === 'KB' ? 1000 : 1_000_000);
};
const PRESETS = TARGETS.filter((t) => t.v !== null);

test('1. every size preset is at most its label read in decimal bytes', () => {
  assert.equal(PRESETS.length, 5, `expected 5 sized presets, got ${PRESETS.length}`); // vacuity guard
  const over = PRESETS.filter((t) => t.v > decimalBytes(t.label)).map((t) => `${t.label} is ${t.v} bytes`);
  assert.deepEqual(over, [], `presets overshoot a decimal portal:\n  ${over.join('\n  ')}`);
  for (const t of PRESETS) assert.equal(t.v, decimalBytes(t.label), `${t.label}: cap should be exactly the decimal reading`);
});

test('2. every sized page targets a preset, and the one its slug names', () => {
  const sized = PAGES.filter((p) => p.target);
  assert.equal(sized.length, 4, `expected 4 pages with a data-target, got ${sized.length}`); // vacuity guard
  const bad = [];
  for (const p of sized) {
    if (!PRESETS.some((t) => t.v === p.target)) bad.push(`${p.slug}: target ${p.target} is not in TARGETS (the sheet would silently fall back to Otomatis)`);
    const m = /-(\d+)(kb|mb)$/.exec(p.slug);
    if (!m) { bad.push(`${p.slug}: no size in the slug to check the target against`); continue; }
    const want = decimalBytes(`${m[1]} ${m[2].toUpperCase()}`);
    if (p.target !== want) bad.push(`${p.slug}: target ${p.target}, slug says ${want}`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

// ---- fakes for the one platform dependency (canvas) and the two vendor libs ----
function fakeEnv(limit) {
  // size at quality q; 0.62 -> limit * 1.0235: over the decimal limit, under the binary one
  const jpegSize = (q) => Math.round(limit * (q / 0.62) * 1.0235);
  class FakeCanvas {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { fillRect() {}, set fillStyle(_v) {} }; }
    async convertToBlob({ quality }) { return new Blob([new Uint8Array(jpegSize(quality))]); }
  }
  const pdfjsLib = {
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({
          getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
          render: () => ({ promise: Promise.resolve() }),
          cleanup() {},
        }),
        destroy: async () => {},
      }),
    }),
  };
  const PDFLib = {
    PDFDocument: {
      create: async () => {
        let total = 0;
        return {
          embedJpg: async (b) => { total += b.length; return {}; },
          addPage: () => ({ drawImage() {} }),
          save: async () => new Uint8Array(total),
        };
      },
    },
  };
  return { FakeCanvas, pdfjsLib, PDFLib };
}

test('3. the ladder search, run against each preset, never lands over the decimal limit', async () => {
  const had = globalThis.OffscreenCanvas;
  try {
    for (const t of PRESETS) {
      const limit = decimalBytes(t.label);
      const { FakeCanvas, pdfjsLib, PDFLib } = fakeEnv(limit);
      globalThis.OffscreenCanvas = FakeCanvas;
      const input = new Uint8Array(limit * 3); // comfortably over every cap, so the search runs
      const out = await compressToTargetBytes(input, { targetBytes: t.v, PDFLib, pdfjsLib });
      assert.equal(out.unchanged, false, `${t.label}: the search did not run`);
      assert.ok(out.reachedTarget, `${t.label}: the fixture has a rung that fits, so the cap should be reached`);
      assert.ok(out.size <= limit, `${t.label}: result is ${out.size} bytes, over ${limit}. A decimal portal rejects it after we said it fits.`);
    }
  } finally {
    if (had === undefined) delete globalThis.OffscreenCanvas; else globalThis.OffscreenCanvas = had;
  }
});
