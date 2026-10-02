#!/usr/bin/env node
/*
 * Generate tests/fixtures/nasty/orphan-rusak.pdf — a PDF that PDF.js opens and
 * pdf-lib cannot parse. Run: `node scripts/gen-fixture-orphan-rusak.mjs`.
 *
 * WHAT IT IS: sample-2pages.pdf plus ONE truncated, unreferenced object spliced
 * in before the xref table. PDF.js reads through the xref table, never reaches
 * object 99, and renders both pages. pdf-lib parses top to bottom, hits the
 * truncated object and throws "Failed to parse invalid PDF object". That is the
 * `export/corrupt` (hint `parse`) the rail saw on merged documents: five
 * sessions on 2026-08-20, 09-18 and 10-01, each one a merge, none recoverable.
 * The real files are unknown; this is the smallest member of the class that
 * reproduces the signature, and the fix catches any pdf-lib load failure.
 *
 * ⚠️ BOTH HALVES ARE PROVEN, not assumed. terpotong.pdf was built expecting this
 * very divergence and PDF.js rejected it too (see gen-fixture-terpotong.mjs),
 * which is why this script proves the pdf-lib half here and
 * tests/orphan-rusak.spec.js proves the PDF.js half in the browser. Of ~15
 * damage shapes tried on 2026-10-02 (junk before the header, a BOM, junk
 * between objects, junk after %%EOF, a missing endobj, bad names/dicts/refs in
 * orphans), only a TRUNCATED orphan object split the two parsers; pdf-lib is
 * the more forgiving of the two for most damage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'tests/fixtures/sample-2pages.pdf');
const OUT = path.join(root, 'tests/fixtures/nasty/orphan-rusak.pdf');

const whole = fs.readFileSync(SRC);
const at = whole.indexOf('xref\n');
if (at < 0) throw new Error('sample-2pages.pdf no longer has a classic xref table; pick another base');
const out = Buffer.concat([whole.subarray(0, at), Buffer.from('99 0 obj\n<< /Foo '), whole.subarray(at)]);
fs.writeFileSync(OUT, out);
console.log(`orphan-rusak.pdf  ${out.length} bytes (from ${whole.length}, +${out.length - whole.length})`);

// PROVE THE FIXTURE STILL BITES. If a future pdf-lib learns to skip this, the
// fixture stops testing anything and every spec using it would keep passing.
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'window', 'define', 'globalThis',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports && Object.keys(module.exports).length ? module.exports : globalThis.PDFLib;
};
const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
try {
  await PDFLib.PDFDocument.load(new Uint8Array(out));
  throw new Error('FIXTURE IS TOOTHLESS — pdf-lib loaded it; pick another damage');
} catch (err) {
  if (/TOOTHLESS/.test(err.message)) throw err;
  console.log(`pdf-lib rejects it, as required: ${err.name}: ${String(err.message).slice(0, 60)}…`);
}
