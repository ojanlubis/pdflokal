/*
 * A PHONE PHOTO TURNED INTO A PDF MUST NOT CARRY WHERE IT WAS TAKEN.
 * ============================================================================
 * An upright JPEG used to be stored and embedded byte-for-byte (import.js
 * `if (format && !turned) return bytes`, export.js embedJpg(source.bytes)),
 * and pdf-lib writes a JPEG into the PDF as a raw DCTDecode stream. So the
 * user's own exported file carried the EXIF block (GPS position, time, camera
 * serial, a thumbnail), the XMP block, and on a Motion Photo the whole video
 * appended after the image. A KTP photo sent to a portal told it where the
 * user lives. Measured RED against the pre-fix import.js: the GPS rationals,
 * "Exif\0\0" and the "ftypmp42" trailer were all inside the exported PDF.
 *
 * "Pixels unchanged" is proven STRUCTURALLY here (no JPEG decoder headless):
 * every segment a decoder reads (DQT, SOF, DHT, SOS and the entropy data, plus
 * APP0 JFIF, APP2 ICC and APP14 Adobe, which change colour) must come out
 * byte-identical and in order. tests/jpeg-metadata-strip.spec.js decodes both
 * in a browser and compares pixel data.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

// importImage needs createImageBitmap for the page size; an upright JPEG never
// reaches the canvas, so `document` is a tripwire, not a stub.
globalThis.window = {
  createImageBitmap: async () => ({ width: 300, height: 200, close() {} }),
};
globalThis.document = {
  createElement: () => { throw new Error('an upright JPEG must not be transcoded'); },
};

const { createDoc, getSource } = await import('../../js/core/model.js');
const { importImage, jpegExifOrientation } = await import('../../js/core/import.js');
const { buildPdfBytes } = await import('../../js/core/export.js');
const { stripJpegMetadata } = await import('../../js/core/jpeg-metadata.js');

const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};
const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

// ---- building a phone-shaped JPEG around real pixels ------------------------

const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const u16 = (v) => [(v >> 8) & 0xff, v & 0xff];
const u32 = (v) => [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
const seg = (marker, payload) => [0xff, marker, ...u16(payload.length + 2), ...payload];
const ifdEntry = (tag, type, count, value4) => [...u16(tag), ...u16(type), ...u32(count), ...value4];

// The tell-tale bytes: latitude 6°12'34.56"S as three big-endian RATIONALs.
const LAT = [...u32(6), ...u32(1), ...u32(12), ...u32(1), ...u32(3456), ...u32(100)];
const LON = [...u32(106), ...u32(1), ...u32(49), ...u32(1), ...u32(2712), ...u32(100)];
// A thumbnail is a whole JPEG inside APP1: its FFD9 must not end the parse.
const THUMB = [0xff, 0xd8, 0xff, 0xfe, 0x00, 0x04, 0x54, 0x48, 0xff, 0xd9];

function exifApp1() {
  // TIFF offsets: IFD0 @8 (30 B) · GPS IFD @38 (54 B) · LAT @92 · LON @116 · IFD1 @140 (30 B) · thumb @170
  const tiff = [
    ...ascii('MM'), ...u16(0x2a), ...u32(8),
    ...u16(2),
    ...ifdEntry(0x0112, 3, 1, [...u16(1), 0, 0]), // Orientation = 1: upright, stored as-is today
    ...ifdEntry(0x8825, 4, 1, u32(38)),            // GPSInfo IFD pointer
    ...u32(140),                                    // next IFD: IFD1 (thumbnail)
    ...u16(4),
    ...ifdEntry(0x0001, 2, 2, [...ascii('S'), 0, 0, 0]),
    ...ifdEntry(0x0002, 5, 3, u32(92)),
    ...ifdEntry(0x0003, 2, 2, [...ascii('E'), 0, 0, 0]),
    ...ifdEntry(0x0004, 5, 3, u32(116)),
    ...u32(0),
    ...LAT, ...LON,
    ...u16(2),
    ...ifdEntry(0x0201, 4, 1, u32(170)),
    ...ifdEntry(0x0202, 4, 1, u32(THUMB.length)),
    ...u32(0),
    ...THUMB,
  ];
  return seg(0xe1, [...ascii('Exif'), 0, 0, ...tiff]);
}

const XMP = seg(0xe1, [...ascii('http://ns.adobe.com/xap/1.0/'), 0,
  ...ascii('<x:xmpmeta><rdf:Description GCamera:MotionPhoto="1" GCamera:MicroVideoOffset="64"/></x:xmpmeta>')]);
const ICC = seg(0xe2, [...ascii('ICC_PROFILE'), 0, 1, 1, ...Array.from({ length: 64 }, (_, i) => i)]);
const MPF = seg(0xe2, [...ascii('MPF'), 0, ...ascii('MM'), ...u16(0x2a), ...u32(8), 0, 0]);
const IPTC = seg(0xed, [...ascii('Photoshop 3.0'), 0, ...ascii('8BIM'), 0x04, 0x04, 0, 0, 0, 0, 0, 0]);
const ADOBE = seg(0xee, [...ascii('Adobe'), 0, 100, 0, 0, 0, 0, 1]); // transform 1 = YCbCr, as the pixels are
const COMMENT = seg(0xfe, ascii('Shot on Pixel 9 Pro, serial 0042'));
const VENDOR = seg(0xe4, ascii('vendor blob'));
const MOTION = [...u32(24), ...ascii('ftypmp42'), ...Array.from({ length: 48 }, (_, i) => i)];

// The real 300×200 fixture, so pdf-lib's SOF parse and a browser decode work.
// Its own APP1 (Orientation=6) is dropped: this photo is UPRIGHT, the path
// that used to be stored untouched.
function fixtureParts() {
  const f = new Uint8Array(fs.readFileSync(path.join(root, 'tests/fixtures/exif-o6-red-blue.jpg')));
  let off = 2; const segs = [];
  while (f[off] === 0xff && f[off + 1] !== 0xda) {
    const end = off + 2 + ((f[off + 2] << 8) | f[off + 3]);
    segs.push({ marker: f[off + 1], bytes: [...f.subarray(off, end)] });
    off = end;
  }
  const app0 = segs.find((s) => s.marker === 0xe0).bytes;
  const decode = segs.filter((s) => s.marker < 0xe0 || s.marker > 0xef).flatMap((s) => s.bytes);
  return { app0, decode, scan: [...f.subarray(off)] }; // scan = SOS … EOI
}

function phonePhoto() {
  const { app0, decode, scan } = fixtureParts();
  const input = new Uint8Array([0xff, 0xd8, ...app0, ...exifApp1(), ...XMP, ...ICC, ...MPF, ...IPTC,
    ...ADOBE, ...COMMENT, ...VENDOR, ...decode, ...scan, ...MOTION]);
  const expected = new Uint8Array([0xff, 0xd8, ...app0, ...ICC, ...ADOBE, ...decode, ...scan]);
  return { input, expected };
}

const indexOf = (hay, needle) => {
  const n = Uint8Array.from(needle);
  outer: for (let i = 0; i + n.length <= hay.length; i += 1) {
    for (let j = 0; j < n.length; j += 1) if (hay[i + j] !== n[j]) continue outer;
    return i;
  }
  return -1;
};
const LEAKS = {
  'Exif header': [...ascii('Exif'), 0, 0],
  'GPS latitude': LAT,
  'GPS longitude': LON,
  'XMP Motion Photo tag': ascii('GCamera:MotionPhoto'),
  'Motion Photo video trailer': ascii('ftypmp42'),
  'MPF index': [...ascii('MPF'), 0],
  'JPEG comment': ascii('serial 0042'),
  'IPTC block': ascii('Photoshop 3.0'),
};
const assertNoLeaks = (bytes, where) => {
  for (const [what, needle] of Object.entries(LEAKS)) {
    assert.equal(indexOf(bytes, needle), -1, `${what} is still in the ${where}`);
  }
};

// ---- the user-visible property: the exported PDF ----------------------------

test('an upright phone photo exports a PDF with no GPS, no EXIF, no Motion Photo video', async () => {
  const { input, expected } = phonePhoto();
  assert.equal(jpegExifOrientation(input), 1, 'VACUITY GUARD: this photo takes the store-as-is path');
  for (const needle of Object.values(LEAKS)) assert.notEqual(indexOf(input, needle), -1, 'VACUITY GUARD: the input carries every leak');

  const doc = createDoc();
  const [page] = await importImage(doc, { name: 'IMG_20261011.jpg', bytes: input, mimeType: 'image/jpeg' });
  const stored = getSource(doc, page.sourceId).bytes;
  assertNoLeaks(stored, 'stored source');
  assert.deepEqual(stored, expected, 'stored bytes = the input minus metadata segments and trailer, nothing else');

  const pdf = await buildPdfBytes(doc, { PDFLib, fontkit });
  assertNoLeaks(pdf, 'exported PDF');
  assert.notEqual(indexOf(pdf, expected), -1, 'the cleaned JPEG is embedded byte-for-byte (no re-encode)');
  const out = await PDFLib.PDFDocument.load(pdf);
  assert.equal(out.getPageCount(), 1);
  const { width, height } = out.getPage(0).getSize();
  assert.deepEqual([width, height], [300, 200]);
});

// ---- the stripper's edges ---------------------------------------------------

test('a JPEG with nothing to drop comes back as the same bytes', () => {
  const { expected } = phonePhoto();
  assert.equal(stripJpegMetadata(expected), expected);
});

test('progressive scans: segments BETWEEN scans are walked by length, stuffed bytes and RST markers are entropy data', () => {
  const dqt = seg(0xdb, [0x00, ...Array.from({ length: 64 }, () => 1)]);
  const sof2 = seg(0xc2, [8, 0, 2, 0, 2, 1, 1, 0x11, 0]);
  // A DHT whose table bytes happen to contain FF D9: only a length walk survives it.
  const dht = seg(0xc4, [0x00, 2, ...Array.from({ length: 15 }, () => 0), 0xff, 0xd9]);
  const sos = seg(0xda, [1, 1, 0x00, 0, 63, 0]);
  const scan1 = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56];
  const scan2 = [0x78, 0xff, 0x00, 0x9a];
  const comBetween = seg(0xfe, ascii('between scans'));
  const input = new Uint8Array([0xff, 0xd8, ...exifApp1(), ...dqt, ...sof2, ...dht, ...sos, ...scan1,
    ...comBetween, ...dht, ...sos, ...scan2, 0xff, 0xd9, ...MOTION]);
  const expected = new Uint8Array([0xff, 0xd8, ...dqt, ...sof2, ...dht, ...sos, ...scan1,
    ...dht, ...sos, ...scan2, 0xff, 0xd9]);
  assert.deepEqual(stripJpegMetadata(input), expected);
});

test('malformed or truncated input never throws and never loses the image', () => {
  const { input } = phonePhoto();
  // A segment length that runs past the end, before any SOS: keep the file as it was.
  const broken = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x7f, 0xff, 1, 2, 3]);
  assert.equal(stripJpegMetadata(broken), broken);
  // Garbage where a marker must be.
  const garbage = new Uint8Array([0xff, 0xd8, 0x00, 0x11, 0x22]);
  assert.equal(stripJpegMetadata(garbage), garbage);
  // Not a JPEG at all.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
  assert.equal(stripJpegMetadata(png), png);
  // A scan that runs off the end with no EOI: metadata still goes, every scan byte stays.
  const noEoi = input.subarray(0, indexOf(input, [0xff, 0xd9, ...u32(24)]));
  const out = stripJpegMetadata(noEoi);
  assertNoLeaks(out, 'EOI-less output');
  const sosAt = indexOf(noEoi, [0xff, 0xda]);
  assert.deepEqual(out.subarray(out.length - (noEoi.length - sosAt)), noEoi.subarray(sosAt));
});
