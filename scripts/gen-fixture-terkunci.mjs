#!/usr/bin/env node
/*
 * Generate tests/fixtures/nasty/terkunci.pdf — a genuinely PROTECTED PDF.
 * Run: `node scripts/gen-fixture-terkunci.mjs`.
 *
 * WHY this fixture exists: a founder-supplied 444-page government table
 * (KBLI 2020→2025) opened and rendered perfectly, then failed at Unduh with
 * "Waduh, gagal membuat file. Coba sekali lagi ya." The document is encrypted
 * with the standard security handler. PDF.js implements decryption, so it
 * views fine; pdf-lib implements NONE, so `PDFDocument.load` throws and the
 * file can never be written back out.
 *
 * WHY NOT commit a slice of the real file: it is a real government document
 * belonging to a user, this repo is public and AGPL, and it is 5 MB. Detection
 * cares about neither the cipher nor the page count — a two-page generated file
 * proves exactly the same thing. (The real file is preserved OUTSIDE the repo
 * at ../archive/bug2-file/, md5 106c42e353bb72219f08efe1d71c31d9.)
 *
 * WHY the /P permissions matter more than any password: the real file uses
 * `/P -3884` with an EMPTY user password — an owner-permissions restriction.
 * No reader ever prompts, so the user has no idea their document is protected
 * and we had no reason to warn them until the export failed. That is why this
 * hid for a week, and this fixture reproduces that shape: opens with no
 * password, still unwritable.
 *
 * ⚠️ THIS GENERATOR IS THE ONE EXCEPTION IN THIS DIRECTORY — it needs python3
 * with `pypdf`, where every sibling is self-contained against js/vendor/.
 * That is a real cost and it was not the first choice. The vendored
 * pdf-encrypt-lite CAN write a standard-security PDF (it is what powers "Kunci
 * PDF"), but it ships as an ES module whose lazy factory resolves
 * `require('pdf-lib')` at init; under `new Function` with a shimmed require it
 * silently yields an undefined PDFDocument. Two attempts at shimming it failed,
 * and burning more time on generator purity was the wrong trade when the
 * fixture is two pages of throwaway text. If you regenerate and pypdf is
 * missing: `python3 -m pip install pypdf`.
 *
 * NOTE the cipher differs from the real file — pypdf writes RC4/AES depending
 * on version, the KBLI table is AESV2. Deliberate and sufficient: detection
 * reads PDF.js's own `EncryptFilterName` (the /Filter, i.e. 'Standard') and
 * never looks at the cipher, and pdf-lib refuses every variant identically.
 * If we ever gain a decrypt path, this fixture stops being sufficient.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, 'tests/fixtures/nasty/terkunci.pdf');

const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};

const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');

// The plain document is built with our own vendored pdf-lib, so the page
// content is ours; python only applies the security handler.
const doc = await PDFLib.PDFDocument.create();
const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
['TABEL KONVERSI', 'HALAMAN DUA'].forEach((heading, i) => {
  const page = doc.addPage([595, 842]);
  page.drawText(heading, { x: 72, y: 760, size: 18, font, color: PDFLib.rgb(0, 0, 0) });
  page.drawText(`Baris contoh halaman ${i + 1}`, { x: 72, y: 720, size: 12, font, color: PDFLib.rgb(0, 0, 0) });
});
const plainPath = path.join(root, 'tests/fixtures/nasty/.terkunci-plain.tmp.pdf');
fs.writeFileSync(plainPath, await doc.save());

// Empty USER password + a non-empty OWNER password: opens with no prompt,
// still carries /Encrypt — the real file's shape.
const py = `
import sys
from pypdf import PdfReader, PdfWriter
r = PdfReader(sys.argv[1])
w = PdfWriter()
for p in r.pages: w.add_page(p)
w.encrypt(user_password="", owner_password="owner-only-permissions")
with open(sys.argv[2], "wb") as f: w.write(f)
`;
const res = spawnSync('python3', ['-c', py, plainPath, dest], { encoding: 'utf8' });
fs.unlinkSync(plainPath);
if (res.status !== 0) {
  console.error(`python3/pypdf failed:\n${res.stderr || res.stdout}`);
  console.error('install with: python3 -m pip install pypdf');
  process.exit(1);
}

// Prove the fixture is what it claims BEFORE anyone writes a test against it.
// A fixture that isn't actually protected would make every assertion below it
// pass for the wrong reason — the same "decoration, not coverage" trap the
// dash-leader fixture taught us.
const bytes = fs.readFileSync(dest);
const hasEncryptDict = /\/Filter\s*\/Standard/.test(Buffer.from(bytes).toString('latin1'));
let pdfLibRefuses = false;
try { await PDFLib.PDFDocument.load(bytes); } catch (e) { pdfLibRefuses = /encrypted/i.test(e.message); }

console.log(`wrote ${path.relative(root, dest)} (${bytes.length.toLocaleString()} bytes, 2 pages)`);
console.log(`  carries an /Encrypt dict : ${hasEncryptDict}`);
console.log(`  pdf-lib refuses to load  : ${pdfLibRefuses}`);
if (!hasEncryptDict || !pdfLibRefuses) {
  console.error('  FIXTURE IS NOT ACTUALLY PROTECTED — do not write tests against it.');
  process.exit(1);
}
