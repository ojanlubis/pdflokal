/*
 * ONE DOOR TO drawText, AND A SCAN THAT PROVES THERE IS ONLY ONE.
 * ============================================================================
 * THE HISTORY THIS EXISTS TO STOP REPEATING:
 *
 *   2026-07-28  A pasted invisible character (thin space, ZWSP, BOM) reaches
 *               pdf-lib's WinAnsi encoder, throws, and aborts the entire
 *               export. One user: 82 minutes, 174 annotations, 41 download
 *               attempts, nothing saved. Fixed by adding toStandardFontSafe()
 *               at the call site where it happened.
 *   2026-07-29  The SAME crash, from the SAME cause, on a build containing
 *               that fix. 24 edits, 10 failures, zero exports, twice, six
 *               minutes apart. There were four drawText sites; the fix guarded
 *               one. The Edit/ganti reinsert was not it.
 *
 * ⭐ A GUARD PLACED WHERE A BUG WAS SEEN PROTECTS THAT PLACE. A guard placed at
 * the only door protects the class. The first fix was not too small, it was in
 * the wrong SHAPE, and the telemetry then reported the identical failure from a
 * route nobody thought to re-check.
 *
 * So: every drawText goes through text-encode.js's drawTextSafe, and this test
 * fails the moment a fifth site calls pdf-lib directly. It is a static scan
 * because that is the only kind of check that can see a path no test drives.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CORE = path.join(ROOT, 'js', 'core');

// The wrapper itself is the one legal caller.
const DOOR = 'text-encode.js';

// Comments discuss drawText constantly in this repo; a scanner that reads prose
// as code produces noise, and noise gets assertions deleted.
const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

function coreFiles() {
  return fs.readdirSync(CORE).filter((f) => f.endsWith('.js')).map((f) => path.join(CORE, f));
}

test('1. only text-encode.js calls pdf-lib drawText directly', () => {
  const offenders = [];
  for (const file of coreFiles()) {
    const name = path.basename(file);
    const src = strip(fs.readFileSync(file, 'utf8'));
    // Any `<something>.drawText(` that is not our own wrapper's call.
    for (const m of src.matchAll(/(\w+)\.drawText\s*\(/g)) {
      if (name === DOOR) continue;
      offenders.push(`${name}: ${m[0]}`);
    }
  }
  assert.deepEqual(
    offenders, [],
    `these call pdf-lib's drawText directly, bypassing the sanitiser:\n  ${offenders.join('\n  ')}\n\n`
    + 'Use drawTextSafe(pdfPage, text, opts) from core/text-encode.js. A pasted thin space or ZWSP '
    + 'reaching pdf-lib throws and aborts the WHOLE export, which has now cost two separate users '
    + 'their entire session (2026-07-28 and 2026-07-29).',
  );
});

test('2. VACUITY GUARD: the scan is actually reading files and can see a call', () => {
  // If the strip() or the regex broke, test 1 would pass over an empty set and
  // the door would stand open with nobody watching. Prove both halves work.
  const files = coreFiles();
  assert.ok(files.length > 10, `only ${files.length} core files found - the scan is not reading the tree`);

  const door = strip(fs.readFileSync(path.join(CORE, DOOR), 'utf8'));
  assert.match(door, /\w+\.drawText\s*\(/, 'the scanner cannot even see the one legal call - the regex is broken');

  // And it must fire on a synthetic offender.
  const fake = strip('function x(p){ p.drawText("hi", {}); }');
  assert.match(fake, /(\w+)\.drawText\s*\(/, 'the pattern does not match an obvious direct call');
});

test('3. the door actually sanitises, not merely forwards', async () => {
  // A wrapper that forwarded unchanged would pass test 1 while restoring the
  // exact bug. Check the behaviour, not the name.
  const { drawTextSafe } = await import('../../js/core/text-encode.js');
  const seen = [];
  const fakePage = { drawText: (t) => { seen.push(t); return 'ok'; } };
  const out = drawTextSafe(fakePage, `Nama${String.fromCodePoint(0x200b)} : Budi`, { x: 1 });
  assert.equal(out, 'ok', 'drawTextSafe must return whatever pdf-lib returns');
  assert.equal(seen[0], 'Nama : Budi', 'drawTextSafe passed the invisible character straight through');
});
