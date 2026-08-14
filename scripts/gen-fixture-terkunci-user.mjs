#!/usr/bin/env node
/*
 * Generate tests/fixtures/nasty/terkunci-user.pdf — a PDF that requires a
 * USER password, i.e. one PDF.js itself cannot open at all (not the
 * owner-password-only shape terkunci.pdf covers, which PDF.js decrypts and
 * renders with no prompt).
 * Run: `node scripts/gen-fixture-terkunci-user.mjs`.
 *
 * WHY this fixture exists: STATE.md "RATIFIED 2026-08-14" adds a distinct
 * toast — "File itu dikunci sandi, jadi nggak bisa dibuka di sini" — for the
 * import branch at js/v2/app.js where the ONLY file offered fails to open at
 * all AND the failure classifies as `encrypted` (failureReason() reads
 * err.name === 'PasswordException'). Nothing in tests/fixtures/nasty/ drove
 * that branch before this file: terkunci.pdf and terkunci-izin.pdf both use
 * an EMPTY user password (deliberately — they exist to prove a file that
 * OPENS FINE but cannot be written back). A non-empty user password is the
 * only way to make pdfjsLib.getDocument() reject with PasswordException,
 * since this app never supplies an onPassword callback (js/core/import.js).
 *
 * Same generator shape as gen-fixture-terkunci.mjs (own pdf-lib for the
 * plain content, pypdf via python3 for the security handler) — see that
 * file's header for why pdf-encrypt-lite is not used here either.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, 'tests/fixtures/nasty/terkunci-user.pdf');

const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};

const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');

const doc = await PDFLib.PDFDocument.create();
const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
doc.addPage([595, 842]).drawText('HALAMAN TERKUNCI SANDI', {
  x: 72, y: 760, size: 18, font, color: PDFLib.rgb(0, 0, 0),
});
const plainPath = path.join(root, 'tests/fixtures/nasty/.terkunci-user-plain.tmp.pdf');
fs.writeFileSync(plainPath, await doc.save());

// A NON-EMPTY user password: no PDF reader can open this without it. PDF.js
// throws PasswordException on getDocument() with no callback supplied.
const py = `
import sys
from pypdf import PdfReader, PdfWriter
r = PdfReader(sys.argv[1])
w = PdfWriter()
for p in r.pages: w.add_page(p)
w.encrypt(user_password="rahasia123", owner_password="owner-only-permissions")
with open(sys.argv[2], "wb") as f: w.write(f)
`;
const res = spawnSync('python3', ['-c', py, plainPath, dest], { encoding: 'utf8' });
fs.unlinkSync(plainPath);
if (res.status !== 0) {
  console.error(`python3/pypdf failed:\n${res.stderr || res.stdout}`);
  console.error('install with: python3 -m pip install pypdf');
  process.exit(1);
}

const bytes = fs.readFileSync(dest);
const hasEncryptDict = /\/Filter\s*\/Standard/.test(Buffer.from(bytes).toString('latin1'));
let pdfLibRefuses = false;
try { await PDFLib.PDFDocument.load(bytes); } catch (e) { pdfLibRefuses = /encrypted/i.test(e.message); }

console.log(`wrote ${path.relative(root, dest)} (${bytes.length.toLocaleString()} bytes, 1 page)`);
console.log(`  carries an /Encrypt dict : ${hasEncryptDict}`);
console.log(`  pdf-lib refuses to load  : ${pdfLibRefuses}`);
if (!hasEncryptDict || !pdfLibRefuses) {
  console.error('  FIXTURE IS NOT ACTUALLY PROTECTED — do not write tests against it.');
  process.exit(1);
}
console.log('  (PDF.js PasswordException is validated by tests/pdf-terkunci-user.spec.js itself,');
console.log('   which is the real reader this fixture has to fool — not asserted here.)');
