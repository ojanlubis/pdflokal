/*
 * PDFLokal — core/user-fonts.js  (HEADLESS: a font the user brings)
 * ============================================================================
 * His call 2026-11-27, from his brother's ask for Futura / Century Gothic: we
 * cannot ship licensed fonts in an open-source repo, so the user brings their
 * own. The file never leaves the device, like their PDFs: it is read in the
 * browser, kept in this browser's storage (js/v2/user-fonts.js), shown through
 * a FontFace, and embedded into the downloaded PDF by core/export.js.
 *
 * SINGLE SOURCE OF TRUTH for: what a user font's family key looks like, the
 * CSS name it is registered under, and whether a file is a font we may embed.
 * An annotation names a user font by its key in `fontFamily`, exactly as it
 * names a bundled one ('Helvetica', 'Tinos'): one field, so copy, undo, saved
 * documents and the format bar need no second notion of "font".
 */
import { isSfntFontProgram } from './clone-fonts.js';

export const USER_FONT_PREFIX = 'user:';

export function isUserFont(family) {
  return typeof family === 'string' && family.startsWith(USER_FONT_PREFIX);
}

// The key is the file's own fingerprint, so the same font added twice is one
// font, and a saved document finds its font again by content, not by name.
export function userFontKey(hashHex) {
  return USER_FONT_PREFIX + String(hashHex).slice(0, 16);
}

// The family the FontFace is registered under. Never the font's own name: a
// user font called "Helvetica" must not hijack the bundled stack.
export function userFontCss(key) {
  return 'pdflokal-user-' + String(key).slice(USER_FONT_PREFIX.length);
}

// fsType (OS/2): bit 1 (0x0002) = Restricted License embedding, which forbids
// putting the font in a document at all. Every other value permits it for a
// document (print & preview, editable, installable). A font with no OS/2 table
// sets no restriction.
export function embeddingAllowed(fsType) {
  const v = Number(fsType) || 0;
  return (v & 0x000F) !== 0x0002;
}

// Can this file be a user font? { ok: true, family } or { ok: false, reason }.
// reason: 'not-font' (not TTF/OTF, or fontkit cannot read it; a .woff/.woff2
// would embed as dots, see isSfntFontProgram) | 'collection' (a .ttc holds
// several fonts and pdf-lib embeds one) | 'no-embed' (its licence flag
// forbids embedding: the PDF would break that licence).
export function inspectFontBytes(bytes, fontkit) {
  if (!isSfntFontProgram(bytes)) return { ok: false, reason: 'not-font' };
  let font;
  try { font = fontkit.create(bytes); } catch { return { ok: false, reason: 'not-font' }; }
  if (!font || Array.isArray(font.fonts)) return { ok: false, reason: 'collection' };
  if (!(font.numGlyphs > 1)) return { ok: false, reason: 'not-font' };
  const os2 = font['OS/2'];
  if (os2 && !embeddingAllowed(os2.fsType)) return { ok: false, reason: 'no-embed' };
  const family = String(font.familyName || font.fullName || font.postscriptName || '').trim() || 'Font';
  return { ok: true, family };
}
