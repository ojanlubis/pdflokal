/*
 * STRIPPING A PHOTO'S METADATA MUST NOT CHANGE ONE PIXEL.
 * ============================================================================
 * core/jpeg-metadata.js cuts EXIF (GPS, time, camera), XMP and any Motion
 * Photo video out of an upright JPEG before it is stored and embedded. The
 * headless test (tests/core/jpeg-metadata-strip.test.mjs) proves the decoder-
 * read segments are byte-identical; this one DECODES both in a real browser
 * and compares every pixel, and checks the exported PDF carries no GPS.
 *
 * FIXTURE: tests/fixtures/exif-o6-red-blue.jpg with its Orientation=6 APP1
 * replaced by an upright (Orientation=1) EXIF block carrying a GPS IFD, plus
 * an 'ftypmp42' trailer after EOI, the shape a Motion Photo has.
 */
import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'exif-o6-red-blue.jpg');

const u16 = (v) => [(v >> 8) & 0xff, v & 0xff];
const u32 = (v) => [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const LAT = [...u32(6), ...u32(1), ...u32(12), ...u32(1), ...u32(3456), ...u32(100)];

function gpsTaggedPhoto() {
  const f = fs.readFileSync(FIXTURE);
  // Walk to the fixture's APP1 and splice it out.
  let off = 2;
  while (f[off + 1] !== 0xe1) off += 2 + ((f[off + 2] << 8) | f[off + 3]);
  const app1End = off + 2 + ((f[off + 2] << 8) | f[off + 3]);
  const tiff = [
    ...ascii('MM'), ...u16(0x2a), ...u32(8),
    ...u16(2),
    ...u16(0x0112), ...u16(3), ...u32(1), ...u16(1), 0, 0,   // Orientation = 1
    ...u16(0x8825), ...u16(4), ...u32(1), ...u32(38),        // GPSInfo IFD @38
    ...u32(0),
    ...u16(1),
    ...u16(0x0002), ...u16(5), ...u32(3), ...u32(56),        // GPSLatitude @56
    ...u32(0),
    ...LAT,
  ];
  const payload = [...ascii('Exif'), 0, 0, ...tiff];
  const app1 = [0xff, 0xe1, ...u16(payload.length + 2), ...payload];
  const trailer = [...u32(24), ...ascii('ftypmp42'), ...new Array(32).fill(7)];
  return [...f.subarray(0, off), ...app1, ...f.subarray(app1End), ...trailer];
}

test('an upright GPS-tagged photo stores and exports with the same pixels and no GPS', async ({ page }) => {
  await page.goto('/alat-gambar.html');
  await page.waitForFunction(() => !!window.pdfjsLib && !!window.PDFLib);

  const r = await page.evaluate(async ({ arr, lat }) => {
    const model = await import('/js/core/model.js');
    const imp = await import('/js/core/import.js');
    const exp = await import('/js/core/export.js');
    const input = new Uint8Array(arr);
    const doc = model.createDoc();
    await imp.importImage(doc, { name: 'IMG_0001.jpg', bytes: input, mimeType: 'image/jpeg' });
    const p0 = doc.pages[0];
    const stored = model.getSource(doc, p0.sourceId).bytes;

    const pixels = async (bytes) => {
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      return { w: bmp.width, h: bmp.height, data: ctx.getImageData(0, 0, c.width, c.height).data };
    };
    const a = await pixels(input);
    const b = await pixels(stored);
    let diff = 0;
    for (let i = 0; i < a.data.length; i += 1) if (a.data[i] !== b.data[i]) diff += 1;

    const has = (hay, needle) => {
      outer: for (let i = 0; i + needle.length <= hay.length; i += 1) {
        for (let j = 0; j < needle.length; j += 1) if (hay[i + j] !== needle[j]) continue outer;
        return true;
      }
      return false;
    };
    const pdf = await exp.buildPdfBytes(doc);
    return {
      pageW: p0.width, pageH: p0.height,
      sizes: [a.w, a.h, b.w, b.h],
      diff,
      shrank: stored.length < input.length,
      inputHasGps: has(input, lat),
      pdfHasGps: has(pdf, lat),
      pdfHasExif: has(pdf, [0x45, 0x78, 0x69, 0x66, 0, 0]),
      pdfHasTrailer: has(pdf, [...'ftypmp42'].map((c) => c.charCodeAt(0))),
    };
  }, { arr: gpsTaggedPhoto(), lat: LAT });

  expect(r.inputHasGps, 'VACUITY GUARD: the input carries GPS').toBe(true);
  expect(r.shrank, 'VACUITY GUARD: something was actually cut').toBe(true);
  expect([r.pageW, r.pageH]).toEqual([300, 200]);
  expect(r.sizes).toEqual([300, 200, 300, 200]);
  expect(r.diff, 'decoded pixels differ between the original and the stored bytes').toBe(0);
  expect(r.pdfHasGps).toBe(false);
  expect(r.pdfHasExif).toBe(false);
  expect(r.pdfHasTrailer).toBe(false);
});
