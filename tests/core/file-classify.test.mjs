/*
 * A PDF WHOSE NAME LOST ITS EXTENSION IS STILL A PDF — AND ONE BAD FILE STAYS ONE.
 * ============================================================================
 * WhatsApp and some download managers hand over "Surat Undangan" with no
 * ".pdf" and a type of '' or application/octet-stream. Name and type both say
 * "unknown", so the open path refused it with the "pick a PDF or photo" toast
 * even though the bytes are a perfectly good PDF. The spec lets the %PDF-
 * header sit anywhere in the first 1024 bytes, so classifyFiles reads those.
 *
 * The first attempt read the header outside the per-file guard: one file that
 * went unreadable between the picker and the read (Sentry JAVASCRIPT-G) made
 * the whole load throw. classifyFiles must absorb that per file.
 *
 * Real File objects, not stubs: the property is about what slice() returns.
 * app.js is a browser module (DOM at import), so ITS wiring is guarded by
 * reading loadFilesInner's source: revert the call and these go red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const core = await import('../../js/core/file-kind.js');
const { classifyFiles } = core;
const APP = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'js', 'v2', 'app.js'), 'utf8');
const head = APP.slice(APP.indexOf('async function loadFilesInner'), APP.indexOf('showProcessing(usable.length)'));

const mk = (bytes, name, type) => new File([bytes], name, { type });
const kindOf = async (f) => (await classifyFiles([f])).get(f) ?? null;
/** A file that went unreadable after the picker handed it over. */
class UnreadableFile extends File {
  slice() {
    return { arrayBuffer: () => Promise.reject(new DOMException('gone', 'NotReadableError')) };
  }
}

test('1. a .pdf name or application/pdf type is a pdf without reading bytes', async () => {
  assert.equal(await kindOf(mk('junk', 'a.PDF', '')), 'pdf');
  assert.equal(await kindOf(mk('junk', 'Surat', 'application/pdf')), 'pdf');
});

test('2. the bug: no extension + empty type, but %PDF- bytes, is a pdf', async () => {
  assert.equal(await kindOf(mk('%PDF-1.7\n%...', 'Surat Undangan', '')), 'pdf');
});

test('3. the bug: no extension + octet-stream, but %PDF- bytes, is a pdf', async () => {
  assert.equal(await kindOf(mk('%PDF-1.4', 'Surat Undangan', 'application/octet-stream')), 'pdf');
});

test('4. the header may sit after junk, up to byte 1024 (spec), and no further', async () => {
  assert.equal(await kindOf(mk(' '.repeat(1019) + '%PDF-', 'x', '')), 'pdf'); // ends at byte 1024
  assert.equal(await kindOf(mk(' '.repeat(1020) + '%PDF-', 'x', '')), null);
});

test('5. images keep their type-based classification', async () => {
  assert.equal(await kindOf(mk('x', 'foto', 'image/jpeg')), 'image');
});

test('6. no false positive: unknown type, non-PDF bytes, is refused', async () => {
  assert.equal(await kindOf(mk('PK\x03\x04 zip', 'arsip', 'application/octet-stream')), null);
  assert.equal(await kindOf(mk('', 'kosong', '')), null);
});

test('7. a file with a KNOWN non-PDF type is not sniffed, even if it holds %PDF-', async () => {
  assert.equal(await kindOf(mk('%PDF-1.7', 'catatan.txt', 'text/plain')), null);
});

test('8. an unreadable file is skipped, the rest still classify, in picker order', async () => {
  const bad = new UnreadableFile(['x'], 'WhatsApp Document', { type: '' });
  const good = mk('x', 'report.pdf', 'application/pdf');
  const photo = mk('x', 'foto.jpg', 'image/jpeg');
  const sniffed = mk('%PDF-1.7', 'Surat', '');
  const kinds = await classifyFiles([bad, good, photo, sniffed]); // must not reject
  assert.deepEqual([...kinds.keys()], [good, photo, sniffed]);
  assert.deepEqual([...kinds.values()], ['pdf', 'image', 'pdf']);
});

test('9. only the guarded classifier is public: the raw sniff cannot be called around the guard', () => {
  assert.equal(core.fileKind, undefined);
});

test('10. app.js classifies through classifyFiles and keeps no name/type test of its own', () => {
  assert.match(APP, /import \{[^}]*\bclassifyFiles\b[^}]*\} from '\.\.\/core\/file-kind\.js'/);
  assert.ok(head.includes('await classifyFiles(files)'), 'loadFilesInner must await classifyFiles(files)');
  assert.ok(!/application\/pdf/.test(head) && !/\\\.pdf\$/.test(head), 'no inline pdf name/type test before the loop');
  assert.ok(!/startsWith\('image\//.test(head), 'no inline image type test before the loop');
});
