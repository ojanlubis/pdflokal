/*
 * THE OCR LAYER IS INVISIBLE IN THE PRODUCT. ALWAYS. NO EXCEPTIONS.
 * ============================================================================
 * core/ocr-layer.js accepts a `renderMode` so a TEST can write the visible twin
 * of a layer, which is the only way the "our OCR output still gets declined by
 * Edit" assertion has any power (an editor that declined everything, a writer
 * that emitted nothing, and a probe that could only say false would all pass it).
 *
 * ⚠️ THAT SEAM IS ALSO A LOADED GUN. A product caller passing renderMode: 0
 * would paint OCR guesses visibly on top of the user's scan, and then Edit would
 * start cutting them: the 2026-07-28 corruption, with us supplying the input.
 *
 * So the seam is allowed to exist and forbidden to be used outside tests, and
 * this scan is what makes "forbidden" checkable rather than a comment nobody
 * reads. Same shape as drawtext-chokepoint.test.mjs: the danger is a path no
 * test drives, so the check has to be static.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Everything the browser actually runs, plus the lab pages.
function productFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'vendor') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) productFiles(full, out);
    else if (e.isFile() && /\.(js|html)$/.test(e.name)) out.push(full);
  }
  return out;
}

const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

test('1. no product file passes renderMode to the OCR writer', () => {
  const files = [
    ...productFiles(path.join(ROOT, 'js')),
    ...fs.readdirSync(ROOT).filter((f) => f.endsWith('.html')).map((f) => path.join(ROOT, f)),
  ];
  const offenders = [];
  for (const file of files) {
    const rel = path.relative(ROOT, file);
    // ocr-layer.js DEFINES the seam; it is the only file allowed to name it.
    if (rel === path.join('js', 'core', 'ocr-layer.js')) continue;
    const src = strip(fs.readFileSync(file, 'utf8'));
    if (/renderMode/.test(src)) offenders.push(rel);
  }
  assert.deepEqual(
    offenders, [],
    `these product files reference renderMode:\n  ${offenders.join('\n  ')}\n\n`
    + 'The OCR layer must be invisible in the product, always. A visible layer paints OCR guesses '
    + "on top of the user's scan, and Edit then cuts them. renderMode exists for tests only.",
  );
});

test('2. VACUITY GUARD: the scan reads real files and the token is findable', () => {
  const files = productFiles(path.join(ROOT, 'js'));
  assert.ok(files.length > 30, `only ${files.length} files scanned - the walk is broken`);
  // The one file that legitimately contains it must contain it, or the scan is
  // searching for a token that no longer exists and can never fire.
  const seam = strip(fs.readFileSync(path.join(ROOT, 'js', 'core', 'ocr-layer.js'), 'utf8'));
  assert.match(seam, /renderMode/, 'ocr-layer.js no longer has the seam - update or delete this test');
});

test('3. the default really is invisible, with no options at all', async () => {
  // The guard above is about callers. This is about the default: if it ever
  // stopped being 3, every caller would be writing visible text correctly by
  // the letter of test 1.
  const { buildInvisibleTextOps } = await import('../../js/core/ocr-layer.js');
  const words = [{ text: 'Halo', x: 72, y: 700, w: 30, h: 11 }];
  for (const opts of [{ fontRes: 'F' }, { fontRes: 'F', renderMode: undefined }, { fontRes: 'F', renderMode: 'x' }]) {
    const ops = buildInvisibleTextOps(words, opts);
    assert.match(ops, /\b3 Tr\b/, `default render mode is not 3 for opts ${JSON.stringify(opts)}`);
    assert.ok(!/\b0 Tr\b/.test(ops), 'a visible mode leaked into the default path');
  }
});
