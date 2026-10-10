/*
 * PDFLokal — core/jpeg-metadata.js
 * ============================================================================
 * Drops a JPEG's metadata without touching its pixels.
 *
 * WHY: an upright JPEG is stored and embedded as-is (import.js), and pdf-lib
 * writes a JPEG into the PDF as a raw DCTDecode stream. Everything a phone
 * puts in the file therefore travelled into the user's PDF: EXIF (GPS
 * position, time, camera serial, a thumbnail), XMP, IPTC, comments, and on a
 * Motion Photo the whole video appended after the image. None of it is
 * needed to show the page, and a KTP photo sent to a portal should not say
 * where the user lives. Nothing leaves the device either way; this is about
 * what the user's own file carries when THEY send it on.
 *
 * WHY lossless, not a canvas re-encode: re-encoding loses quality and costs
 * a decode of a 12-megapixel photo. Removing whole segments leaves every byte
 * a decoder reads identical, so the pixels are the same by construction.
 *
 * KEPT, because a decoder reads them: everything that is not APPn/COM (DQT,
 * DHT, SOFn, DRI, SOS and the entropy data), APP0 JFIF/JFXX (density, and the
 * colour-space default), APP2 ICC_PROFILE (dropping it changes the colours
 * shown), APP14 Adobe (CMYK/YCCK transform; without it those decode wrong).
 * DROPPED: every other APPn (APP1 Exif/XMP, APP2 MPF whose offsets point at
 * the trailer cut below, APP13 IPTC, vendor blobs), COM, and anything after
 * EOI (Motion Photo video, MPF secondary images, gain maps).
 *
 * Orientation is NOT this module's concern: the caller only passes JPEGs
 * whose EXIF Orientation is 1, so dropping the tag changes nothing visible.
 */

const SOS = 0xda;
const EOI = 0xd9;
const COM = 0xfe;

const startsWith = (bytes, at, end, sig) => {
  if (at + sig.length > end) return false;
  for (let i = 0; i < sig.length; i += 1) if (bytes[at + i] !== sig.charCodeAt(i)) return false;
  return true;
};

// Whether a segment with this marker survives. `p`/`end` bound its payload.
function keepSegment(bytes, marker, p, end) {
  if (marker === COM) return false;
  if (marker < 0xe0 || marker > 0xef) return true;                  // not APPn: decoder data
  if (marker === 0xe0) return startsWith(bytes, p, end, 'JFIF\0') || startsWith(bytes, p, end, 'JFXX\0');
  if (marker === 0xe2) return startsWith(bytes, p, end, 'ICC_PROFILE\0');
  if (marker === 0xee) return startsWith(bytes, p, end, 'Adobe');
  return false;
}

// Markers with no length field: TEM and RST0-7 (only legal inside a scan,
// tolerated anywhere so a sloppy encoder does not abort the walk).
const isStandalone = (m) => m === 0x01 || (m >= 0xd0 && m <= 0xd7);

// The JPEG with its metadata segments and any trailing bytes removed, or the
// SAME `bytes` when there is nothing to remove or the structure is not one
// this walk can trust. Never throws: createImageBitmap already decoded this
// file, so a metadata walk must not be what refuses it.
export function stripJpegMetadata(bytes) {
  try {
    if (!(bytes?.length > 4) || bytes[0] !== 0xff || bytes[1] !== 0xd8) return bytes;
    const n = bytes.length;
    const keep = [[0, 2]];          // [start, end) ranges copied to the output
    let dropped = false;
    let off = 2;
    let inScan = false;
    let sawScan = false;
    while (off < n) {
      if (inScan) {
        // Entropy data: FF00 is a stuffed byte, FFD0-D7 a restart marker, a
        // run of FF is fill. Anything else is a real marker.
        const scanStart = off;
        while (off < n) {
          if (bytes[off] === 0xff && off + 1 < n) {
            const m = bytes[off + 1];
            if (m !== 0x00 && m !== 0xff && !(m >= 0xd0 && m <= 0xd7)) break;
          }
          off += 1;
        }
        if (off > scanStart) keep.push([scanStart, off]);
        if (off >= n) break;        // no EOI: keep the scan to the end
        inScan = false;
        continue;
      }
      if (bytes[off] !== 0xff) return bytes;                        // lost the structure
      let m = off + 1;
      while (m < n && bytes[m] === 0xff) m += 1;                    // fill bytes
      if (m >= n) return bytes;
      const marker = bytes[m];
      if (marker === EOI) {
        keep.push([off, m + 1]);
        if (m + 1 < n) dropped = true;                              // trailer after the image
        break;
      }
      if (isStandalone(marker)) { keep.push([off, m + 1]); off = m + 1; continue; }
      if (m + 2 >= n) return bytes;
      const size = (bytes[m + 1] << 8) | bytes[m + 2];
      const end = m + 1 + size;
      if (size < 2 || end > n) return bytes;
      if (keepSegment(bytes, marker, m + 3, end)) keep.push([off, end]);
      else dropped = true;
      off = end;
      if (marker === SOS) { inScan = true; sawScan = true; }
    }
    if (!dropped || !sawScan) return bytes;                        // no image data found: not ours to cut
    const total = keep.reduce((sum, [a, b]) => sum + (b - a), 0);
    const out = new Uint8Array(total);
    let w = 0;
    for (const [a, b] of keep) { out.set(bytes.subarray(a, b), w); w += b - a; }
    return out;
  } catch {
    return bytes;
  }
}
