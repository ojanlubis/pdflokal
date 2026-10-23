/*
 * A real PNG built in plain Node (no canvas, no dependency), for specs and core
 * tests that need an image of a known size and known pixels. 8-bit RGBA, filled
 * with `fill`; with `clearLeftColumn` the left-most pixel column is fully
 * transparent, so alpha survival can be checked.
 */
import zlib from 'node:zlib';

function crc32(buf) {
  let crc = 0xffffffff;
  for (let n = 0; n < buf.length; n += 1) {
    let c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function pngBytes(w, h, { fill = [200, 0, 0], clearLeftColumn = false } = {}) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y += 1) {
    const row = y * (1 + w * 4);
    for (let x = 0; x < w; x += 1) {
      const o = row + 1 + x * 4;
      raw[o] = fill[0]; raw[o + 1] = fill[1]; raw[o + 2] = fill[2];
      raw[o + 3] = clearLeftColumn && x === 0 ? 0 : 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const pngDataUrl = (w, h, opts) => `data:image/png;base64,${pngBytes(w, h, opts).toString('base64')}`;
