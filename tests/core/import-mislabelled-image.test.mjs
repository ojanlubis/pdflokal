/*
 * AN IMAGE'S REAL BYTES DECIDE WHETHER IT IS STORED AS-IS, NOT ITS FILE NAME.
 * ============================================================================
 * The browser derives File.type from the EXTENSION, so a WebP saved from the
 * web as foto.jpg arrives labelled image/jpeg. It was stored untouched, opened
 * fine (createImageBitmap sniffs bytes), and then Unduh threw because export
 * sniffs bytes too and pdf-lib embeds only JPEG/PNG. Round-3 hunt, 2026-10-10.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const JPEG_MAGIC = [0xff, 0xd8, 0xff, 0xe0];
const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);
let canvasUsed = false;
globalThis.window = {
  createImageBitmap: async () => ({ width: 40, height: 30, close() {} }),
};
globalThis.document = {
  createElement: () => ({
    width: 0, height: 0,
    getContext: () => ({ drawImage() { canvasUsed = true; } }),
    toBlob(cb, type) {
      const head = type === 'image/jpeg' ? JPEG_MAGIC : PNG_MAGIC;
      cb({ arrayBuffer: async () => Uint8Array.from([...head, 0, 0, 0, 0]).buffer });
    },
  }),
};

const { createDoc, getSource } = await import('../../js/core/model.js');
const { importImage } = await import('../../js/core/import.js');
const { sniffImageFormat } = await import('../../js/core/image-format.js');

async function storedBytes(args) {
  const doc = createDoc();
  const [page] = await importImage(doc, args);
  return getSource(doc, page.sourceId).bytes;
}

for (const mimeType of ['image/jpeg', 'image/png']) {
  test(`a WebP labelled ${mimeType} is stored as bytes pdf-lib can embed`, async () => {
    canvasUsed = false;
    const stored = await storedBytes({ name: 'foto.jpg', bytes: WEBP, mimeType });
    assert.ok(['jpg', 'png'].includes(sniffImageFormat(stored)), 'export sniffs the bytes and must recognise them');
    assert.ok(canvasUsed, 'VACUITY GUARD: the transcode path ran');
  });
}

test('a real PNG labelled image/jpeg is stored untouched', async () => {
  canvasUsed = false;
  const png = Uint8Array.from([...PNG_MAGIC, 1, 2, 3, 4, 5]);
  const stored = await storedBytes({ name: 'x.jpg', bytes: png, mimeType: 'image/jpeg' });
  assert.equal(canvasUsed, false, 'no needless re-encode');
  assert.deepEqual([...stored], [...png]);
});

test('a real JPEG labelled image/webp is stored untouched', async () => {
  canvasUsed = false;
  const jpg = Uint8Array.from([...JPEG_MAGIC, 1, 2, 3, 4, 5]);
  const stored = await storedBytes({ name: 'x.webp', bytes: jpg, mimeType: 'image/webp' });
  assert.equal(canvasUsed, false, 'no needless re-encode');
  assert.deepEqual([...stored], [...jpg]);
});
