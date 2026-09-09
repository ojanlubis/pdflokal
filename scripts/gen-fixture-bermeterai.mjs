#!/usr/bin/env node
/*
 * Generate tests/fixtures/nasty/bermeterai.pdf — a PDF carrying a DIGITAL
 * SIGNATURE dictionary, the structure an Indonesian e-meterai (Peruri) and
 * every PAdES signature share.
 * Run: `node scripts/gen-fixture-bermeterai.mjs`.
 *
 * WHY this fixture exists: pdflokal's export rebuilds the document with
 * pdf-lib and has no incremental-update path, so saving a stamped document
 * silently destroys its seal — the visible meterai graphic survives as page
 * content, the cryptography does not. core/import.js `detectSigned` reads the
 * /ByteRange marker so the download sheet can say so; this is the file that
 * makes that detector able to go green for a real reason.
 *
 * ⚠️ WHAT THIS FIXTURE IS NOT. The PKCS#7 blob in /Contents here is ZERO
 * PADDING and the /ByteRange numbers are arbitrary. It is a structurally
 * shaped document, NOT a cryptographically valid signature, and it is NOT a
 * Peruri e-meterai. It proves the detector reads the right BYTES; it cannot
 * prove the detector fires on a real e-meterai, because nobody on this bench
 * has one. Do not let a green test here be read as that. (We do not ship a
 * real one for the same reasons terkunci.pdf is generated: a real stamped
 * document belongs to a real person, carries their name, and this repo is
 * public.)
 *
 * ⚠️ `useObjectStreams: false` IS LOAD-BEARING. pdf-lib's default (and
 * core/export.js's own save) compresses indirect objects into an object
 * stream — which would hide /ByteRange from a byte scan and make this fixture
 * agree with a BROKEN detector as readily as a correct one. Real signed files
 * cannot do that: ISO 32000 requires direct objects in a signature dictionary
 * precisely because the digest is taken over fixed file offsets. So writing
 * this uncompressed is reproducing the format's own constraint, not dodging
 * one. [[fixture-must-distinguish]]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, 'tests/fixtures/nasty/bermeterai.pdf');

const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};

const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const { PDFHexString, PDFString, PDFName, PDFArray } = PDFLib;

const doc = await PDFLib.PDFDocument.create();
const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
const page = doc.addPage([595, 842]);
page.drawText('SURAT PERJANJIAN', { x: 72, y: 760, size: 18, font, color: PDFLib.rgb(0, 0, 0) });
page.drawText('Contoh dokumen untuk pengujian.', { x: 72, y: 720, size: 12, font, color: PDFLib.rgb(0, 0, 0) });
// The VISIBLE stamp — deliberately just page content, which is the whole
// point: this box survives an export perfectly while the seal below does not.
page.drawRectangle({
  x: 380, y: 90, width: 130, height: 130, borderWidth: 1, borderColor: PDFLib.rgb(0.6, 0.1, 0.1),
});
page.drawText('e-METERAI', { x: 398, y: 148, size: 12, font, color: PDFLib.rgb(0.6, 0.1, 0.1) });

const ctx = doc.context;

// The signature dictionary. /ByteRange + /Contents are what make it one; the
// rest is the shape a real signer writes so the fixture reads as a document
// rather than as a marker in a wrapper.
const sigDict = ctx.obj({
  Type: 'Sig',
  Filter: 'Adobe.PPKLite',
  SubFilter: 'ETSI.CAdES.detached',
  ByteRange: [0, 840, 960, 1200],
  Contents: PDFHexString.of('00'.repeat(512)),
  M: PDFString.of("D:20260909120000+07'00'"),
  Reason: PDFString.of('e-Meterai'),
});
const sigRef = ctx.register(sigDict);

// A signature field + its widget annotation on page 1, wired into an AcroForm
// with SigFlags 3 (signatures exist, append-only) — the arrangement a reader
// looks for before it will show a signature panel at all.
const widgetRef = ctx.nextRef();
const widget = ctx.obj({
  Type: 'Annot',
  Subtype: 'Widget',
  FT: 'Sig',
  Rect: [380, 90, 510, 220],
  T: PDFString.of('Signature1'),
  V: sigRef,
  F: 4,
  P: page.ref,
});
ctx.assign(widgetRef, widget);
page.node.set(PDFName.of('Annots'), ctx.obj([widgetRef]));

const acroFields = PDFArray.withContext(ctx);
acroFields.push(widgetRef);
const acroForm = ctx.obj({ SigFlags: 3 });
acroForm.set(PDFName.of('Fields'), acroFields);
doc.catalog.set(PDFName.of('AcroForm'), ctx.register(acroForm));

fs.writeFileSync(dest, await doc.save({ useObjectStreams: false }));

// Prove the fixture is what it claims BEFORE anyone writes a test against it,
// and prove BOTH directions: a signed fixture the detector reads as signed,
// and — the half that carries the information — the plain fixture beside it
// still reading as unsigned. A generator that silently produced an ordinary
// PDF would otherwise turn the whole suite into decoration.
const { detectSigned } = await import(path.join(root, 'js/core/import.js'));
const bytes = new Uint8Array(fs.readFileSync(dest));
const plain = new Uint8Array(fs.readFileSync(path.join(root, 'tests/fixtures/nasty/surat-resmi.pdf')));
const reloads = await PDFLib.PDFDocument.load(bytes).then((d) => d.getPageCount(), () => 0);

console.log(`wrote ${path.relative(root, dest)} (${bytes.length.toLocaleString()} bytes, 1 page)`);
console.log(`  detectSigned(this fixture)     : ${detectSigned(bytes)}`);
console.log(`  detectSigned(surat-resmi.pdf)  : ${detectSigned(plain)}`);
console.log(`  pdf-lib reloads it, page count : ${reloads}`);
if (!detectSigned(bytes) || detectSigned(plain) || reloads !== 1) {
  console.error('  FIXTURE CANNOT DISTINGUISH A SIGNED FILE FROM A PLAIN ONE — do not write tests against it.');
  process.exit(1);
}
