/*
 * NO FIXTURE MAY CARRY A WEB-FONT CONTAINER AS ITS EMBEDDED FONT PROGRAM.
 * ============================================================================
 * FOUND 2026-09-23, the day PR #137 fixed export embedding raw .woff2 bytes as
 * /FontFile2: the fixture generators (scripts/gen-fixture-*.mjs) had the same
 * bug. They read fonts/*.woff2 and handed the bytes to pdf-lib's embedFont,
 * which writes them VERBATIM — so 11 PDFs in tests/fixtures/nasty carried 13
 * WOFF2 programs where a PDF may only carry TrueType/OpenType.
 *
 * WHY IT MATTERS: stamp.js's rung 1 (edit with the document's OWN embedded
 * font) was being tested against a font format no real-world PDF can carry,
 * and that fontkit happens to parse anyway. A pass on those fixtures said
 * nothing about the real documents rung 1 exists for. The generators now read
 * fonts/ttf/; this test keeps any future generator, or any hand-added file,
 * from bringing the impossible format back.
 *
 * HOW IT READS: every stream body in every PDF, found by the `stream` /
 * `endstream` keywords rather than by parsing (so a producer's quirks, an
 * indirect /Length or an incremental update cannot hide one), inflated when
 * it inflates, and checked for 'wOF2' / 'wOFF' at offset 0 — where a font
 * program's container tag sits. Encrypted fixtures (terkunci*) are opaque to
 * it; their fonts are the standard 14 and carry no program.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesDir = path.join(root, 'tests', 'fixtures');

const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};

// The container tag at the head of every stream body, raw and inflated.
function streamHeads(pdfBytes) {
  const buf = Buffer.from(pdfBytes);
  const heads = [];
  let at = 0;
  for (;;) {
    const kw = buf.indexOf('stream', at, 'latin1');
    if (kw < 0) break;
    at = kw + 6;
    if (buf.subarray(kw - 3, kw).toString('latin1') === 'end') continue;
    let start = at;
    if (buf[start] === 0x0d) start++;
    if (buf[start] !== 0x0a) continue;
    start++;
    const end = buf.indexOf('endstream', start, 'latin1');
    if (end < 0) break;
    const body = buf.subarray(start, end);
    heads.push(body.subarray(0, 4).toString('latin1'));
    try {
      const inflated = zlib.inflateSync(body, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
      heads.push(inflated.subarray(0, 4).toString('latin1'));
    } catch { /* not Flate, or encrypted */ }
    at = end + 9;
  }
  return heads;
}

const WEB_CONTAINERS = new Set(['wOF2', 'wOFF']);
const SFNT = new Set(['\x00\x01\x00\x00', 'true', 'OTTO']);

function allPdfs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return allPdfs(p);
    return e.name.toLowerCase().endsWith('.pdf') ? [p] : [];
  });
}

test('the scanner sees a WOFF2 program when pdf-lib embeds one (known positive)', async () => {
  const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
  const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
  const doc = await PDFLib.PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(new Uint8Array(fs.readFileSync(path.join(root, 'fonts/carlito-regular.woff2'))));
  doc.addPage().drawText('Rp 1.250.000', { x: 40, y: 700, size: 12, font });
  const heads = streamHeads(await doc.save());
  assert.ok(heads.includes('wOF2'), `scanner missed a woff2 program; heads: ${JSON.stringify(heads)}`);
});

test('no PDF under tests/fixtures carries a wOF2/wOFF font program', () => {
  const files = allPdfs(fixturesDir);
  assert.ok(files.length >= 30, `only ${files.length} fixture PDFs found — wrong directory?`);
  const offenders = [];
  let sfntPrograms = 0;
  for (const f of files) {
    const heads = streamHeads(fs.readFileSync(f));
    const bad = heads.filter((h) => WEB_CONTAINERS.has(h));
    if (bad.length) offenders.push(`${path.relative(root, f)} (${bad.length}× ${[...new Set(bad)].join('/')})`);
    sfntPrograms += heads.filter((h) => SFNT.has(h)).length;
  }
  assert.deepEqual(offenders, [], 'fixtures carrying a web-font container as a PDF font program');
  // Not vacuous: the corpus holds real embedded programs, and the scanner saw them.
  assert.ok(sfntPrograms >= 10, `only ${sfntPrograms} sfnt programs seen across the corpus`);
});
