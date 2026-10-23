/*
 * PDFLokal — core/image-format.js
 * ============================================================================
 * The ONE home of "which image format are these bytes". Import decides what to
 * store from it and export decides how to embed from it, so the two can never
 * disagree about what pdf-lib can take.
 *
 * WHY bytes, never a MIME type or file name: File.type is derived from the
 * EXTENSION, so a WebP saved as foto.jpg is labelled image/jpeg while its
 * bytes are RIFF/WEBP. createImageBitmap sniffs bytes (it decodes fine);
 * pdf-lib embeds only JPEG and PNG, by bytes.
 */

// 'jpg' | 'png' for the two formats pdf-lib can embed, else null.
export function sniffImageFormat(bytes) {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  return null;
}
