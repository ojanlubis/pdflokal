/*
 * PDFLokal — core/file-kind.js  (WHAT IS THIS FILE, AND WHAT IS IT CALLED?)
 * ============================================================================
 * SINGLE HOME of the open path's decisions about a file's identity.
 */

// The extensions the open path accepts (PDF and importImage's formats). A name
// with no extension at all ("Surat Undangan Bpk. Ahmad") keeps every character:
// the export is named after it, and ". Ahmad" is not an extension.
const REAL_EXT = /\.(pdf|jpe?g|png|webp|heic|gif)$/i;

/** The file's name without its extension — a REAL extension only. */
export function baseNameOf(name) {
  return name.replace(REAL_EXT, '');
}
