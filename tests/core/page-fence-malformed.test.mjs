/*
 * A MALFORMED PAGE EXPORTS EXACTLY AS IT DID BEFORE THE FENCE.
 * ============================================================================
 * core/page-fence.js runs on every rebuild, links or not. Its first version
 * read /Annots and /Resources through pdf-lib's typed getters
 * (page.node.Annots(), page.node.Resources()), which THROW when the value has
 * the wrong type, so a kept page whose /Annots was a dict or whose /Resources
 * was an array failed the whole download. Before the fence, copyPages carried
 * the bad value across and a reader ignored it (review of 5245a21, probe2).
 *
 * The fence must never throw on a value it does not understand, and must
 * leave such a value exactly as it found it. Both halves are asserted: the
 * export resolves and the malformed value is still on the output page, and
 * the fence run on its own changes not one byte of the source it fenced.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as model from '../../js/core/model.js';
import * as ops from '../../js/core/operations.js';
import { buildPdfBytes } from '../../js/core/export.js';
import { fenceUnkeptPages } from '../../js/core/page-fence.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};
const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
const { PDFName, PDFDict, PDFArray, PDFNumber } = PDFLib;
const N = 3;

async function source(mutate) {
  const s = await PDFLib.PDFDocument.create();
  const pages = [];
  for (let i = 0; i < N; i += 1) {
    const p = s.addPage([595, 842]);
    p.drawText(`Halaman ${i + 1}`, { x: 50, y: 700, size: 12 });
    pages.push(p);
  }
  mutate(s, pages);
  return s.save();
}

// The malformed values, each on page 1, each one a reader ignores.
const CASES = {
  'an /Annots that is a dict': (s, p) => p[0].node.set(PDFName.of('Annots'), s.context.obj({ Foo: 1 })),
  'an /Annots that is a number': (s, p) => p[0].node.set(PDFName.of('Annots'), s.context.obj(7)),
  'an /Annots that is a ref to a dict': (s, p) =>
    p[0].node.set(PDFName.of('Annots'), s.context.register(s.context.obj({ Foo: 1 }))),
  'a /Resources that is an array': (s, p) => p[0].node.set(PDFName.of('Resources'), s.context.obj([1])),
  'a /Resources that is a number': (s, p) => p[0].node.set(PDFName.of('Resources'), s.context.obj(7)),
  'an inherited /Resources that is an array': (s, p) => {
    p[0].node.delete(PDFName.of('Resources'));
    s.catalog.Pages().set(PDFName.of('Resources'), s.context.obj([1]));
  },
};

// The raw value of `key` on `node`, resolved once, never type-asserted.
const raw = (context, node, key) => context.lookup(node.get(PDFName.of(key)));

for (const [name, mutate] of Object.entries(CASES)) {
  test(`a kept page with ${name} still exports, carrying the value unchanged`, async () => {
    const bytes = await source(mutate);
    const doc = model.createDoc();
    const src = ops.addSource(doc, model.createSource({ name: 's.pdf', bytes, numPages: N }));
    // Pages 1 and 2 of 3: a subset, so this is a rebuild and the fence runs.
    ops.addPages(doc, [0, 1].map((n) => model.createPage({ source: src, sourcePageNum: n, width: 595, height: 842 })));
    const out = await buildPdfBytes(doc, { PDFLib, fontkit });
    const d = await PDFLib.PDFDocument.load(out);
    assert.equal(d.getPageCount(), 2);
    const page = d.getPages()[0].node;
    if (name.includes('/Annots')) {
      const v = raw(d.context, page, 'Annots');
      if (name.includes('number')) {
        assert.ok(v instanceof PDFNumber && v.asNumber() === 7, `/Annots still 7, got ${v}`);
      } else {
        assert.ok(v instanceof PDFDict && v.get(PDFName.of('Foo'))?.toString() === '1', `/Annots still the dict, got ${v}`);
      }
    } else {
      // copyPages writes an inherited /Resources onto the page it copies.
      const v = raw(d.context, page, 'Resources');
      if (name.includes('number')) assert.ok(v instanceof PDFNumber, `/Resources still a number, got ${v}`);
      else assert.ok(v instanceof PDFArray && v.size() === 1, `/Resources still the array, got ${v}`);
    }
  });

  test(`the fence alone changes not one byte of a source with ${name}`, async () => {
    const bytes = await source(mutate);
    const fenced = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
    const control = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
    // Every subset, including keeping none: nothing here references a page.
    for (const kept of [[0, 1], [0], [1, 2], []]) {
      assert.equal(fenceUnkeptPages(fenced, new Set(kept), 'T', PDFLib), false, `kept ${kept}: no placeholder`);
    }
    assert.deepEqual(await fenced.save(), await control.save());
  });
}
