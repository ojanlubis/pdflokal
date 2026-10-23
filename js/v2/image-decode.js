/*
 * PDFLokal — v2/image-decode.js  (A PICTURE THE USER BROUGHT, READY TO EMBED)
 * ============================================================================
 * Turns a File (the Gambar picker, or an image on the clipboard) into the one
 * thing the editor's picture object stores: a data-URL plus its pixel size.
 * Nothing leaves the tab: the file is decoded and re-drawn on a canvas here.
 *
 * WHY createImageBitmap and not <img>:
 *   - it applies the EXIF Orientation tag (imageOrientation 'from-image' is the
 *     default), which is what core/import.js already depends on. A portrait
 *     phone photo stays portrait. The canvas re-draw below then carries the
 *     ORIENTED pixels and no EXIF at all, so GPS position, time and camera
 *     serial do not ride into the user's PDF (same intent as
 *     core/jpeg-metadata.js, reached by re-encoding because we resize anyway).
 *   - a format the browser cannot decode (HEIC on most Androids/desktops, a
 *     truncated JPEG) REJECTS with a DOMException that core/failure-reason.js
 *     already classifies; <img>.onerror gives a bare Event with no name.
 *
 * WHY the cap (MAX_IMAGE_PX): a 12-megapixel photo embedded whole is several
 * MB per picture and rides every undo snapshot. 2000px on the long side is
 * sharp at any page zoom (a picture lands at most ~0.6 of an A4, ~500pt) and
 * keeps a JPEG near 0.5 MB.
 *
 * WHY JPEG vs PNG is decided from the BYTES (core/image-format.js), not
 * File.type: the type comes from the extension, so a WebP saved as foto.jpg
 * claims image/jpeg. JPEG in -> JPEG out (a photo as PNG would be several
 * times bigger); everything else (PNG, WebP, GIF, ...) -> PNG, which keeps
 * transparency for a logo or stamp.
 */
import { sniffImageFormat } from '../core/image-format.js';

export const MAX_IMAGE_PX = 2000;
const JPEG_QUALITY = 0.92;

/**
 * @param {File|Blob} file
 * @param {number} [maxPx] long-side cap in pixels
 * @returns {Promise<{image: string, pxWidth: number, pxHeight: number}>}
 *   rejects with the browser's own DOMException when the file cannot be decoded.
 */
export async function decodeImageFile(file, maxPx = MAX_IMAGE_PX) {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const asJpeg = sniffImageFormat(head) === 'jpg';
  const bitmap = await window.createImageBitmap(file);
  try {
    if (!bitmap.width || !bitmap.height) throw new globalThis.DOMException('empty image', 'InvalidStateError');
    const k = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bitmap.width * k));
    c.height = Math.max(1, Math.round(bitmap.height * k));
    const ctx = c.getContext('2d');
    if (!ctx) throw new globalThis.DOMException('no 2d context', 'NotSupportedError');
    ctx.drawImage(bitmap, 0, 0, c.width, c.height);
    return {
      image: asJpeg ? c.toDataURL('image/jpeg', JPEG_QUALITY) : c.toDataURL('image/png'),
      pxWidth: c.width,
      pxHeight: c.height,
    };
  } finally {
    bitmap.close?.();
  }
}
