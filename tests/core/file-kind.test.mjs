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
  for (const ext of ['pdf', 'PDF', 'jpg', 'jpeg', 'png', 'webp', 'heic', 'gif']) {
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
