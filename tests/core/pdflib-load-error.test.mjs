/*
 * pdfLibLoadError — does pdf-lib parse this file? (the merge guard's probe)
 * ============================================================================
 * Rail: `export/corrupt` on merged documents, 2026-08-20 / 09-18 / 10-01. PDF.js
 * reads through the xref table, pdf-lib parses top to bottom, so a file with one
 * damaged ORPHAN object renders fine and cannot be rebuilt. orphan-rusak.pdf is
 * the smallest reproduction (scripts/gen-fixture-orphan-rusak.mjs). The browser
 * behaviour is pinned by tests/orphan-rusak.spec.js; this pins the probe itself,
 * with REAL pdf-lib errors, so a vendored upgrade that changes the wording or
 * learns to skip the damage turns this red instead of silently doing nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as model from '../../js/core/model.js';
import * as ops from '../../js/core/operations.js';
import { buildPdfBytes } from '../../js/core/export.js';
import { pdfLibLoadError } from '../../js/core/import.js';
import { failureReason, failureCause } from '../../js/core/failure-reason.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};
const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fixture = (...p) => new Uint8Array(fs.readFileSync(path.join(root, 'tests', 'fixtures', ...p)));

test('an ordinary file loads: null', async () => {
  assert.equal(await pdfLibLoadError(PDFLib, fixture('sample-2pages.pdf')), null);
  assert.equal(await pdfLibLoadError(PDFLib, fixture('nasty', 'surat-word.pdf')), null);
});

test('a file with a damaged orphan object is the error pdf-lib throws, classified exactly as export would', async () => {
  const err = await pdfLibLoadError(PDFLib, fixture('nasty', 'orphan-rusak.pdf'));
  assert.ok(err instanceof Error, 'expected pdf-lib to refuse the fixture');
  assert.equal(failureReason(err), 'corrupt');
  assert.deepEqual(failureCause(err), { name: 'Error', hint: 'parse' }); // the rail's own signature
});

test('a truncated file is an error too', async () => {
  const err = await pdfLibLoadError(PDFLib, fixture('nasty', 'terpotong.pdf'));
  assert.equal(failureReason(err), 'corrupt');
});

test('an ENCRYPTED file is null: that is the protected-PDF path, never "corrupt"', async () => {
  assert.equal(await pdfLibLoadError(PDFLib, fixture('nasty', 'terkunci.pdf')), null);
});

test('it never throws, whatever it is handed', async () => {
  for (const junk of [new Uint8Array(0), new Uint8Array([1, 2, 3]), null, undefined]) {
    const out = await pdfLibLoadError(PDFLib, junk);
    assert.ok(out === null || out instanceof Error);
  }
  // even a non-Error throw comes back as a value, not an exception
  assert.equal(await pdfLibLoadError({ PDFDocument: { load() { throw 7; } } }, new Uint8Array(4)), 7);
});

// The failure the guard front-runs, end to end: a merge that contains the file
// cannot be exported, and says `corrupt` / `parse`, the rail's exact signature.
// A lone untouched copy still exports (pass-through) — so the guard may only
// ever look at merges.
async function docOf(...files) {
  const doc = model.createDoc();
  for (const [name, bytes] of files) {
    const source = ops.addSource(doc, model.createSource({ name, bytes, numPages: 2 }));
    ops.addPages(doc, [0, 1].map((n) => model.createPage({ source, sourcePageNum: n, width: 595, height: 842, rotation: 0 })));
  }
  return doc;
}

test('export of a merge containing it fails as corrupt/parse; the lone file passes through', async () => {
  const good = fixture('sample-2pages.pdf');
  const bad = fixture('nasty', 'orphan-rusak.pdf');
  await assert.rejects(
    async () => buildPdfBytes(await docOf(['a.pdf', good], ['b.pdf', bad]), { PDFLib }),
    (err) => failureReason(err) === 'corrupt' && failureCause(err).hint === 'parse',
  );
  const lone = await buildPdfBytes(await docOf(['b.pdf', bad]), { PDFLib });
  assert.deepEqual([...lone], [...bad]);
});
