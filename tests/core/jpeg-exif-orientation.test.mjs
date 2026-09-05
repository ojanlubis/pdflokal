/*
 * jpegExifOrientation — the tiny EXIF reader behind the import-time re-encode
 * (js/core/import.js, 2026-09-06). tests/image-orientation.spec.js proves the
 * whole path in a browser; this pins the reader itself, headless, against the
 * same fixture and against a JPEG with no EXIF at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jpegExifOrientation } from '../../js/core/import.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = new Uint8Array(fs.readFileSync(path.join(root, 'tests/fixtures/exif-o6-red-blue.jpg')));

test('reads Orientation=6 off the PIL-written fixture (little-endian TIFF)', () => {
  assert.equal(jpegExifOrientation(fixture), 6);
});

test('a JPEG with the APP1 block stripped reads as upright (1)', () => {
  // Walk the markers (PIL writes APP0/JFIF before APP1) and splice APP1 out.
  let off = 2; let found = null;
  while (off + 4 <= fixture.length && fixture[off] === 0xff) {
    const size = (fixture[off + 2] << 8) | fixture[off + 3];
    if (fixture[off + 1] === 0xe1) { found = [off, off + 2 + size]; break; }
    off += 2 + size;
  }
  assert.ok(found, 'fixture must carry an APP1 segment or this proves nothing');
  const stripped = new Uint8Array([...fixture.subarray(0, found[0]), ...fixture.subarray(found[1])]);
  assert.equal(jpegExifOrientation(stripped), 1);
});

test('big-endian TIFF ("MM") is read in its own byte order', () => {
  // Hand-built minimal APP1: Exif\0\0 + MM header + one IFD entry, Orientation=3.
  const app1 = [
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00,           // Exif\0\0
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // MM, 42, IFD0 at 8
    0x00, 0x01,                                     // 1 entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x03, 0x00, 0x00, // 0x0112 SHORT ×1 = 3
    0x00, 0x00, 0x00, 0x00,                         // next IFD: none
  ];
  const len = app1.length + 2;
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 0xff, ...app1, 0xff, 0xd9]);
  assert.equal(jpegExifOrientation(bytes), 3);
});

test('garbage never throws and never invents a turn', () => {
  assert.equal(jpegExifOrientation(null), 1);
  assert.equal(jpegExifOrientation(new Uint8Array([1, 2, 3])), 1);
  assert.equal(jpegExifOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x02])), 1);
  assert.equal(jpegExifOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), 1); // a PNG
});
