/*
 * WHAT THE OPEN PATH CALLS A FILE, AND WHETHER app.js REALLY ASKS.
 * ============================================================================
 * A PDF can arrive with no extension ("Surat Undangan Bpk. Ahmad"). The export
 * is named after the opened file, so stripping "the last dot and what follows"
 * ate ". Ahmad" and produced "Surat Undangan Bpk-pdflokal.pdf". Only a REAL
 * extension may be stripped.
 *
 * The decision lives in core/file-kind.js; the part that can silently regress
 * is app.js forgetting to ask it. app.js is a browser module (DOM at import),
 * so the wiring is guarded by reading its loadFilesInner source: revert the
 * call and these go red, even though the pure function is untouched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { baseNameOf } = await import('../../js/core/file-kind.js');
const APP = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'js', 'v2', 'app.js'), 'utf8');

// loadFilesInner from its declaration to the processing overlay: everything
// that decides what the files are and what the document is called.
const head = APP.slice(APP.indexOf('async function loadFilesInner'), APP.indexOf('showProcessing(usable.length)'));

test('baseNameOf strips a real extension, any case', () => {
  for (const ext of ['pdf', 'PDF', 'jpg', 'jpeg', 'jpe', 'jfif', 'png', 'webp', 'heic', 'HEIF', 'gif', 'bmp', 'avif', 'tif', 'tiff', 'svg', 'ico']) {
    assert.equal(baseNameOf(`Surat.${ext}`), 'Surat', ext);
  }
});

test('baseNameOf keeps a dot that is not an extension', () => {
  assert.equal(baseNameOf('Surat Undangan Bpk. Ahmad'), 'Surat Undangan Bpk. Ahmad');
  assert.equal(baseNameOf('laporan v1.2'), 'laporan v1.2');
  assert.equal(baseNameOf('Surat Undangan Bpk. Ahmad.pdf'), 'Surat Undangan Bpk. Ahmad');
});

test('app.js names the document through baseNameOf, not an inline regex', () => {
  assert.ok(head.includes('baseNameOf(usable[0].name)'), 'loadFilesInner must call baseNameOf(usable[0].name)');
  assert.ok(!/replace\(\s*\/\\\.\[\^\.\]\+\$\//.test(head), 'no inline extension-strip regex left in loadFilesInner');
  assert.match(APP, /import \{[^}]*\bbaseNameOf\b[^}]*\} from '\.\.\/core\/file-kind\.js'/);
});

// Re-editing a file pdflokal itself exported must not stack our suffix
// ("surat-pdflokal-pdflokal.pdf" is what HR would receive). The suffix is
// download-sheet's `${baseName}-pdflokal.pdf`; a browser may also append its
// own " (1)" duplicate counter to the saved name.
test('baseNameOf drops our own export suffix and a browser duplicate counter', () => {
  assert.equal(baseNameOf('Surat Lamaran-pdflokal.pdf'), 'Surat Lamaran');
  assert.equal(baseNameOf('Surat Lamaran-pdflokal (1).pdf'), 'Surat Lamaran');
  assert.equal(baseNameOf('Surat Lamaran-pdflokal(2).pdf'), 'Surat Lamaran');
  assert.equal(baseNameOf('Surat Lamaran-pdflokal-pdflokal.pdf'), 'Surat Lamaran', 'already stacked by an earlier version');
  assert.equal(baseNameOf('Surat Lamaran-PDFLokal.PDF'), 'Surat Lamaran');
  assert.equal(baseNameOf('Surat Lamaran-pdflokal'), 'Surat Lamaran', 'extensionless, as WhatsApp hands it over');
});

test('baseNameOf only strips the suffix at the END and never empties the name', () => {
  assert.equal(baseNameOf('pdflokal-notes.pdf'), 'pdflokal-notes');
  assert.equal(baseNameOf('a-pdflokal-b.pdf'), 'a-pdflokal-b');
  assert.equal(baseNameOf('Laporan (1).pdf'), 'Laporan (1)', 'a counter without our suffix is the user\'s own');
  assert.equal(baseNameOf('-pdflokal.pdf'), '-pdflokal', 'nothing left to name the export after: keep it');
});
