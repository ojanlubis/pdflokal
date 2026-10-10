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
import { TARGETS, fmtMB, sizeSide } from '../../js/v2/download-sheet.js';
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

// DISPLAY AGREES WITH THE CAP. The sheet prints a result next to a preset label
// ("204 KB, belum masuk 200 KB"). If fmtMB divided by 1024 the same 204,000 bytes
// read "199 KB" beside "belum masuk 200 KB": the page contradicting itself.
test('fmtMB is decimal: a result over a preset never displays at or under its label', () => {
  assert.equal(fmtMB(204_000), '204 KB');
  assert.equal(fmtMB(200_000), '200 KB');
  assert.equal(fmtMB(199_999), '200 KB'); // rounds up to the label, never below the true size read in decimal
  assert.equal(fmtMB(1_000_000), '1,0 MB');
  assert.equal(fmtMB(1_048_576), '1,0 MB');
  assert.equal(fmtMB(2_500_000), '2,5 MB');
  assert.equal(fmtMB(1), '1 KB');
  for (const t of PRESETS.filter((x) => x.label.endsWith('KB'))) {
    const over = fmtMB(t.v + 4000);
    const label = fmtMB(t.v);
    assert.notEqual(over, label, `${t.label}: 4 KB over the cap must not display as the cap`);
  }
});

// THE SHOWN NUMBER NEVER SITS ON OR ACROSS THE CAP IT IS PRINTED BESIDE.
// fmtMB rounds to nearest, so beside a cap "2,040,000 B" read "2,0 MB, belum masuk
// 2 MB" (the number says it fits, the words say it does not) and 999,600 B read
// "1000 KB" beside "muat di bawah 1 MB". The side comes from the compress result
// (sizeSide), so the rounding direction is chosen by the same fact the words are.
const shownBytes = (txt) => {
  const m = /^([\d.]+(?:,\d+)?) (KB|MB)$/.exec(txt);
  assert.ok(m, `unparseable size "${txt}"`);
  return Number(m[1].replace(',', '.')) * (m[2] === 'KB' ? 1000 : 1_000_000);
};

test('size line: a missed result reads strictly above the cap, a fitting one at or under it', () => {
  for (const t of PRESETS) {
    const missed = sizeSide({ target: t.v, reachedTarget: false });
    const fits = sizeSide({ target: t.v, reachedTarget: true });
    assert.equal(missed, 'over');
    assert.equal(fits, 'under');
    let n = 0;
    for (let b = t.v - 40_000; b <= t.v + 40_000; b += 37) {
      if (b <= 0) continue;
      n++;
      if (b > t.v) assert.ok(shownBytes(fmtMB(b, missed)) > t.v, `${t.label}: ${b} B missed the cap but reads "${fmtMB(b, missed)}"`);
      else assert.ok(shownBytes(fmtMB(b, fits)) <= t.v, `${t.label}: ${b} B fits but reads "${fmtMB(b, fits)}"`);
    }
    assert.ok(n > 1000, 'vacuity guard: the sweep ran');
  }
  // the two reported cases, by name
  assert.equal(fmtMB(2_040_000, 'over'), '2,1 MB');
  assert.equal(fmtMB(999_600, 'under'), '999 KB');
  assert.equal(fmtMB(999_600, 'over'), '1,0 MB'); // never "1000 KB"
});

test('size line: no cap, no side; rounding to nearest is unchanged', () => {
  assert.equal(sizeSide(null), undefined);
  assert.equal(sizeSide({ target: null, reachedTarget: true }), undefined);
  assert.equal(fmtMB(2_040_000), '2,0 MB');
  assert.equal(fmtMB(999_600), '1,0 MB'); // not '1000 KB'
});
