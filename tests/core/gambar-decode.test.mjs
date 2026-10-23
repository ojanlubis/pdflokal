/*
 * GAMBAR: A PICTURE IS DECODED, CAPPED AND RE-ENCODED IN THE TAB (js/v2/image-decode.js)
 * ============================================================================
 * Headless: createImageBitmap and the canvas are stubbed, so these pin OUR
 * decisions (the pixel cap, JPEG vs PNG chosen from the BYTES, the bitmap
 * always released, a decode failure surfacing as the browser's own error for
 * core/failure-reason.js to classify). That createImageBitmap itself applies the
 * EXIF Orientation is the browser's job, proven end to end in
 * tests/v2-gambar.spec.js with a real Orientation=6 phone JPEG.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

let bitmaps = [];
let canvases = [];
globalThis.window = {
  createImageBitmap: async (blob) => {
    if (blob.__undecodable) throw Object.assign(new Error('The source image cannot be decoded.'), { name: 'InvalidStateError' });
    const b = { width: blob.__w, height: blob.__h, closed: false, close() { b.closed = true; } };
    bitmaps.push(b);
    return b;
  },
};
globalThis.document = {
  createElement: () => {
    const c = {
      width: 0, height: 0, drawn: null,
      toDataURL: (type, q) => `data:${type};q=${q ?? 'none'};${c.width}x${c.height}`,
      getContext: () => ({ drawImage: (b, x, y, w, h) => { c.drawn = { b, w, h }; } }),
    };
    canvases.push(c);
    return c;
  },
};

const { decodeImageFile, MAX_IMAGE_PX } = await import('../../js/v2/image-decode.js');

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const RIFF = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0]; // a WebP
const file = (head, w, h, extra = {}) => ({
  slice: () => ({ arrayBuffer: async () => Uint8Array.from(head).buffer }),
  type: 'image/jpeg', __w: w, __h: h, ...extra,
});
const reset = () => { bitmaps = []; canvases = []; };

test('a 12-megapixel photo is capped at MAX_IMAGE_PX on the long side, aspect kept', async () => {
  reset();
  assert.equal(MAX_IMAGE_PX, 2000);
  const r = await decodeImageFile(file(JPEG, 4000, 3000));
  assert.deepEqual([r.pxWidth, r.pxHeight], [2000, 1500]);
  assert.deepEqual([canvases[0].width, canvases[0].height], [2000, 1500]);
  assert.deepEqual([canvases[0].drawn.w, canvases[0].drawn.h], [2000, 1500], 'drawn scaled, not cropped');
});

test('a small picture is never upscaled', async () => {
  reset();
  const r = await decodeImageFile(file(PNG, 300, 120));
  assert.deepEqual([r.pxWidth, r.pxHeight], [300, 120]);
});

test('a portrait photo is capped on its HEIGHT', async () => {
  reset();
  const r = await decodeImageFile(file(JPEG, 3000, 4000));
  assert.deepEqual([r.pxWidth, r.pxHeight], [1500, 2000]);
});

test('JPEG bytes stay JPEG (a photo as PNG would balloon the PDF); PNG stays PNG (transparency)', async () => {
  reset();
  assert.match((await decodeImageFile(file(JPEG, 100, 100))).image, /^data:image\/jpeg;q=0\.92/);
  assert.match((await decodeImageFile(file(PNG, 100, 100))).image, /^data:image\/png/);
});

test('the format comes from the BYTES, not File.type: a WebP named .jpg is PNG, a JPEG typed as PNG is JPEG', async () => {
  reset();
  assert.match((await decodeImageFile(file(RIFF, 100, 100, { type: 'image/jpeg' }))).image, /^data:image\/png/);
  assert.match((await decodeImageFile(file(JPEG, 100, 100, { type: 'image/png' }))).image, /^data:image\/jpeg/);
});

test('the decoded bitmap is released, success or not', async () => {
  reset();
  await decodeImageFile(file(JPEG, 4000, 3000));
  assert.ok(bitmaps.length === 1 && bitmaps[0].closed, 'closed after a good decode');
  reset();
  const broken = file(JPEG, 0, 0);
  await assert.rejects(decodeImageFile(broken), { name: 'InvalidStateError' });
  assert.ok(bitmaps.length === 1 && bitmaps[0].closed, 'closed after a zero-size bitmap too');
});

test('an undecodable file (HEIC where the browser has no decoder) rejects with the browser\'s own error, placing nothing', async () => {
  reset();
  await assert.rejects(decodeImageFile(file(JPEG, 1, 1, { __undecodable: true })), { name: 'InvalidStateError' });
  assert.equal(canvases.length, 0, 'no canvas was ever drawn');
});
