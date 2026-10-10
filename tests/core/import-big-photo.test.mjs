/*
 * A 48 MP PHONE PHOTO IMPORTS ON AN iPHONE, AND NEVER LEAKS ITS BITMAP.
 * ============================================================================
 * WEBP/HEIC-decoded or EXIF-rotated photos are transcoded through a canvas.
 * It was sized at the photo's full pixel count: an iPhone "HEIF Max" photo is
 * 8064x6048 = 48.8 MP, past iOS Safari's ~16.7 MP canvas limit, so
 * getContext('2d') returned null, drawImage threw, the import was refused as
 * unreadable, and the decoded bitmap (~195 MB) was never closed because
 * close() sat after the throw. Round-3 hunt, 2026-10-10.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const CAP = 16_777_216;
let openBitmaps = 0;
let lastCanvas = null; // the canvas's size when it was drawn into
let toBlobResult = 'ok';
globalThis.window = {
  createImageBitmap: async () => { openBitmaps += 1; return { width: 8064, height: 6048, close() { openBitmaps -= 1; } }; },
};
globalThis.document = {
  createElement: () => {
    const c = {
      width: 0, height: 0,
      // iOS Safari: a canvas over the limit gives no context at all.
      getContext() {
        lastCanvas = { width: c.width, height: c.height };
        return c.width * c.height > CAP ? null : { drawImage() {} };
      },
      toBlob(cb) { cb(toBlobResult === 'ok' ? { arrayBuffer: async () => new ArrayBuffer(8) } : null); },
    };
    return c;
  },
};

const { createDoc } = await import('../../js/core/model.js');
const { importImage } = await import('../../js/core/import.js');

test('a 48 MP WEBP imports as one page at its full size, through a canvas within the cap', async () => {
  openBitmaps = 0; toBlobResult = 'ok';
  const doc = createDoc();
  const pages = await importImage(doc, { name: 'IMG_0001.webp', bytes: new Uint8Array(16), mimeType: 'image/webp' });
  assert.equal(pages.length, 1);
  assert.deepEqual([pages[0].width, pages[0].height], [8064, 6048], 'the PAGE keeps the photo\'s size');
  assert.ok(lastCanvas, 'VACUITY GUARD: the transcode canvas was used');
  assert.ok(lastCanvas.width * lastCanvas.height <= CAP, `canvas ${lastCanvas.width}x${lastCanvas.height}`);
  assert.ok(Math.abs(lastCanvas.width / lastCanvas.height - 8064 / 6048) < 0.01, 'aspect ratio kept');
  assert.equal(openBitmaps, 0, 'the decoded bitmap was closed');
});

test('a failed encode is a clear error, and still closes the bitmap', async () => {
  openBitmaps = 0; toBlobResult = 'null';
  await assert.rejects(
    importImage(createDoc(), { name: 'x.webp', bytes: new Uint8Array(16), mimeType: 'image/webp' }),
    (err) => err instanceof Error && !/arrayBuffer/.test(err.message),
    'a null toBlob must not surface as "cannot read arrayBuffer of null"',
  );
  assert.equal(openBitmaps, 0, 'the bitmap leaked on the failure path');
});
