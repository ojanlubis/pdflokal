#!/usr/bin/env node
/*
 * Generate tests/fixtures/nasty/terkunci-izin.pdf — a protected PDF whose
 * owner has REVOKED printing and text extraction.
 * Run: `node scripts/gen-fixture-terkunci-izin.mjs`.
 *
 * WHY A SECOND PROTECTED FIXTURE, when terkunci.pdf already exists.
 * `terkunci.pdf` carries `/P -4`: encrypted, but with every permission bit
 * GRANTED. It reproduces the pdf-lib refusal perfectly and is the right
 * fixture for that — but it cannot distinguish an implementation that IGNORES
 * the permission flags from one that HONOURS them, because there is nothing in
 * it to honour. Both answer "yes, you may".
 *
 * On 2026-08-09 the image export was changed to fall back to rasterizing the
 * SOURCE bytes when pdf-lib refuses to rebuild them, so a locked PDF can be
 * saved as images. That change is only meaningful if it holds for a file whose
 * owner said no — and only checkable against a file that actually says no.
 * This is that file. [[fixture-must-distinguish]]: name the two answers the
 * fixture must tell apart, then check it can.
 *
 * THE PRODUCT POSITION IT PINS, stated plainly so nobody has to infer it from
 * a test: PDFLokal already RENDERS these pages on screen — PDF.js implements
 * the standard security handler, and the owner-permission bits are advisory
 * flags addressed to a conforming reader, not encryption. An image export is
 * the same pixels the user is already looking at, produced on their own device
 * and never leaving it. We do not decrypt anything (there is no decrypt path
 * anywhere in this stack) and we do not claim to remove protection. The PDF
 * export still refuses, honestly, because pdf-lib genuinely cannot write these
 * bytes back.
 *
 * /P -24: start from -4 (all granted), clear bit 3 (value 4, PRINT) and bit 5
 * (value 16, COPY/EXTRACT). -4 & ~4 & ~16 === -24. Written as a 32-bit signed
 * integer, which is what a PDF /P is.
 *
 * ⚠️ Like gen-fixture-terkunci.mjs this needs python3 with `pypdf` — same
 * reason (the vendored pdf-encrypt-lite cannot be driven from a `new Function`
 * shim; see that file's header for the two failed attempts). RC4-128 on
 * purpose: pypdf 6 cannot READ BACK its own AES-256 output without the owner
 * password, so an AES-256 fixture could not self-verify here.
 * `python3 -m pip install pypdf` if it is missing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, 'tests/fixtures/nasty/terkunci-izin.pdf');

const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};

const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');

// Content is ours (vendored pdf-lib); python only applies the security handler.
const doc = await PDFLib.PDFDocument.create();
const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
['SURAT KETERANGAN', 'LAMPIRAN'].forEach((heading, i) => {
  const page = doc.addPage([595, 842]);
  page.drawText(heading, { x: 72, y: 760, size: 18, font, color: PDFLib.rgb(0, 0, 0) });
  page.drawText(`Cetak dan salin dilarang, halaman ${i + 1}`, { x: 72, y: 720, size: 12, font, color: PDFLib.rgb(0, 0, 0) });
});
const plainPath = path.join(root, 'tests/fixtures/nasty/.terkunci-izin-plain.tmp.pdf');
fs.writeFileSync(plainPath, await doc.save());

const py = `
import sys
from pypdf import PdfReader, PdfWriter
r = PdfReader(sys.argv[1])
w = PdfWriter()
for p in r.pages: w.add_page(p)
# -24 == all-granted (-4) with PRINT (4) and EXTRACT (16) cleared.
w.encrypt(user_password="", owner_password="owner-only-permissions",
          permissions_flag=-24, algorithm="RC4-128")
with open(sys.argv[2], "wb") as f: w.write(f)
`;
const res = spawnSync('python3', ['-c', py, plainPath, dest], { encoding: 'utf8' });
fs.unlinkSync(plainPath);
if (res.status !== 0) {
  console.error(`python3/pypdf failed:\n${res.stderr || res.stdout}`);
  console.error('install with: python3 -m pip install pypdf');
  process.exit(1);
}

// Prove all three claims BEFORE anyone writes a test against it: it is
// protected, pdf-lib refuses it (so the fallback is genuinely exercised), and
// the permission bits really are revoked (so the fixture can tell a
// /P-ignoring implementation from a /P-honouring one).
const bytes = fs.readFileSync(dest);
const latin = Buffer.from(bytes).toString('latin1');
const hasEncryptDict = /\/Filter\s*\/Standard/.test(latin);
// The /Encrypt dictionary is itself plaintext in the file, so /P is readable
// without any password — read it from the bytes rather than from a library's
// interpretation of them.
const pMatch = /\/P\s+(-?\d+)/.exec(latin);
// `| 0` reads it as the 32-bit SIGNED integer a /P is — pypdf writes the
// unsigned form (4294967272), and -24 is the number anyone reviewing this
// would recognise.
const pValue = pMatch ? (Number(pMatch[1]) | 0) : null;
const printDenied = pValue !== null && (pValue & 4) === 0;
const copyDenied = pValue !== null && (pValue & 16) === 0;
let pdfLibRefuses = false;
try { await PDFLib.PDFDocument.load(bytes); } catch (e) { pdfLibRefuses = /encrypted/i.test(e.message); }

console.log(`wrote ${path.relative(root, dest)} (${bytes.length.toLocaleString()} bytes, 2 pages)`);
console.log(`  carries an /Encrypt dict : ${hasEncryptDict}`);
console.log(`  /P                       : ${pValue}`);
console.log(`  printing DENIED          : ${printDenied}`);
console.log(`  copy/extract DENIED      : ${copyDenied}`);
console.log(`  pdf-lib refuses to load  : ${pdfLibRefuses}`);
if (!hasEncryptDict || !pdfLibRefuses || !printDenied || !copyDenied) {
  console.error('  FIXTURE IS NOT WHAT IT CLAIMS — do not write tests against it.');
  process.exit(1);
}
