/*
 * THE FONT PROGRAM IN THE EXPORTED PDF MUST BE ONE A PDF VIEWER CAN READ.
 * ============================================================================
 * LIVE BREAKAGE (founder report 2026-09-23, session c66f831f): a Ganti Teks
 * edit looked right in the editor and downloaded as a row of dots in Chrome's
 * viewer and Preview. The rail logged it green end to end — insert
 * path:clone reason:clean, visual_oracle near-parity, export success —
 * because the text was there (pdftotext read it back) and only the font
 * program was wrong.
 *
 * WHY: export.js and stamp.js fetched the self-hosted .woff2 files and handed
 * the bytes to pdf-lib's embedFont, which writes them VERBATIM into the PDF
 * as /FontFile2. FontFile2 must be TrueType (sfnt); a WOFF2 container there
 * is invalid ("Embedded font file may be invalid" — poppler), and PDFium /
 * Preview / Acrobat paint every glyph as a dot. pdf.js silently substitutes a
 * fallback face by name, which is why the editor preview, the reloaded file
 * in-app, and every Playwright check looked fine. `{ subset: true }` is NOT a
 * fix: fontkit's subsetter reads glyf/loca the TrueType way and emits empty /
 * corrupt outlines from a WOFF2 source (measured — fontTools cannot decode
 * the result). The embed must start from real TrueType bytes: fonts/ttf/.
 *
 * WHAT DISTINGUISHES: against the old mapping (.woff2 URLs) the first test
 * finds 'wOF2' magic and the second finds it inside the saved PDF; against
 * fonts/ttf/ both read an sfnt header. Asserting on the saved bytes, not on a
 * pdf.js render, is the point — pdf.js is the instrument that hid this.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import * as model from '../../js/core/model.js';
import * as ops from '../../js/core/operations.js';
import { buildPdfBytes, CUSTOM_FONT_URLS } from '../../js/core/export.js';
import { CLONE_FONT_URLS, isSfntFontProgram } from '../../js/core/clone-fonts.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};

const magic = (bytes) => Buffer.from(bytes.slice(0, 4)).toString('latin1');

test('every font URL export or the clone rung can fetch is a TrueType/OpenType program, not a web container', () => {
  const urls = { ...CUSTOM_FONT_URLS, ...CLONE_FONT_URLS };
  assert.ok(Object.keys(urls).length >= 24, 'catalog unexpectedly small');
  for (const [name, url] of Object.entries(urls)) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(root, url)));
    assert.ok(isSfntFontProgram(bytes), `${name} -> ${url} starts with '${magic(bytes)}', not an sfnt header`);
  }
});

test('isSfntFontProgram rejects woff/woff2 and accepts the sfnt tags', () => {
  const b = (s) => new Uint8Array(Buffer.from(s, 'latin1'));
  assert.equal(isSfntFontProgram(b('wOF2....')), false);
  assert.equal(isSfntFontProgram(b('wOFF....')), false);
  assert.equal(isSfntFontProgram(b('\x00\x01\x00\x00')), true);
  assert.equal(isSfntFontProgram(b('true')), true);
  assert.equal(isSfntFontProgram(b('OTTO')), true);
  assert.equal(isSfntFontProgram(new Uint8Array(2)), false);
});

// Every FontFile2 stream in the saved PDF, inflated.
function fontFile2Streams(pdfBytes) {
  const s = Buffer.from(pdfBytes).toString('latin1');
  const out = [];
  const re = /(\d+) 0 obj\s*<<([\s\S]*?)>>\s*stream\r?\n/g;
  let m;
  while ((m = re.exec(s))) {
    const dict = m[2];
    const len = Number(/\/Length (\d+)/.exec(dict)?.[1]);
    const raw = Buffer.from(s.slice(m.index + m[0].length, m.index + m[0].length + len), 'latin1');
    let data;
    try { data = /FlateDecode/.test(dict) ? zlib.inflateSync(raw) : raw; } catch { continue; }
    // A FontFile2 stream is the one a /FontDescriptor points at; its content
    // is the only stream here that starts with a font container tag.
    if (/^(wOF2|wOFF|true|OTTO|\x00\x01\x00\x00)/.test(data.subarray(0, 4).toString('latin1'))) out.push(data);
  }
  return out;
}

for (const fontFamily of ['Arimo', 'Tinos', 'Cousine', 'Carlito', 'Caladea', 'Montserrat']) {
  test(`${fontFamily}: the exported PDF embeds an sfnt program`, async () => {
    const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
    const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
    // A source with NO embedded font, built here: several tests/fixtures/nasty
    // PDFs were themselves generated through this bug and carry WOFF2
    // programs, which would pass through export and mask the assertion.
    const blank = await PDFLib.PDFDocument.create();
    blank.addPage([595.28, 841.89]);
    const bytes = await blank.save();
    const [width, height] = [595.28, 841.89];
    const doc = model.createDoc();
    const source = ops.addSource(doc, model.createSource({ name: 'blank.pdf', bytes, numPages: 1 }));
    const page = model.createPage({ source, sourcePageNum: 0, width, height, rotation: 0 });
    ops.addPages(doc, [page]);
    ops.addAnnotation(doc, page.id, model.createAnnotation('text', {
      text: 'No. PPSJ/127/MKT-DEV/IX/2026', x: 40, y: 40, fontSize: 14, fontFamily, bold: true, italic: false, color: '#000000',
    }));

    const realFetch = globalThis.fetch;
    const fallbacks = [];
    globalThis.fetch = async (url) => {
      const buf = fs.readFileSync(path.join(root, String(url)));
      return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    };
    let out;
    try {
      out = await buildPdfBytes(doc, { PDFLib, fontkit, onFontFallback: (n) => fallbacks.push(n) });
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.deepEqual(fallbacks, [], 'the font must embed, not fall back to Helvetica');
    const programs = fontFile2Streams(out);
    assert.ok(programs.length >= 1, 'no embedded font program found');
    for (const p of programs) {
      assert.ok(isSfntFontProgram(new Uint8Array(p)), `embedded program starts with '${magic(p)}'`);
    }
  });
}
