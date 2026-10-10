/*
 * PDFLokal — core/file-kind.js  (WHAT IS THIS FILE, AND WHAT IS IT CALLED?)
 * ============================================================================
 * SINGLE HOME of the open path's decisions about a file's identity.
 *
 * IS IT A PDF OR A PHOTO? WhatsApp and some download managers strip the ".pdf"
 * and hand the file over as type '' or application/octet-stream; name and type
 * then both say "unknown" and the file was refused although the bytes are a
 * good PDF. So: trust a positive name/type first (free), and only when the type
 * is unknown, read the header.
 *
 * Only an UNKNOWN type is sniffed. A file the OS labelled text/plain or
 * application/zip is somebody's declared choice and stays refused. Images are
 * not sniffed: importImage needs a real MIME type to decode, and guessing one
 * here would widen the change beyond the reported bug.
 *
 * The sniff READS the file, and a read can fail (a file that went unreadable
 * after the picker handed it over: Sentry JAVASCRIPT-G). It therefore lives
 * behind classifyFiles, which absorbs a failed read per file; the raw sniff is
 * deliberately not exported, so no caller can run it outside that guard.
 */

// The extensions the open path accepts (PDF and importImage's formats). A name
// with no extension at all ("Surat Undangan Bpk. Ahmad") keeps every character:
// the export is named after it, and ". Ahmad" is not an extension.
const REAL_EXT = /\.(pdf|jpe?g|png|webp|heic|gif)$/i;

/** The file's name without its extension — a REAL extension only. */
export function baseNameOf(name) {
  return name.replace(REAL_EXT, '');
}

// PDF 32000-1 Annex H: the header may sit anywhere in the first 1024 bytes
// (some producers prepend junk); readers must look that far.
const HEADER_WINDOW = 1024;
const UNKNOWN_TYPES = new Set(['', 'application/octet-stream']);
const MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

function hasPdfHeader(bytes) {
  for (let i = 0; i + MAGIC.length <= bytes.length; i++) {
    if (MAGIC.every((b, k) => bytes[i + k] === b)) return true;
  }
  return false;
}

/** @returns {Promise<'pdf'|'image'|null>} null = neither, refuse it. May reject on a failed read. */
async function sniffKind(f) {
  if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) return 'pdf';
  if (f.type.startsWith('image/')) return 'image';
  if (!UNKNOWN_TYPES.has(f.type)) return null;
  const head = new Uint8Array(await f.slice(0, HEADER_WINDOW).arrayBuffer());
  return hasPdfHeader(head) ? 'pdf' : null;
}

/**
 * The files the open path can use, each with its kind, in picker order.
 * A file that is neither, or that cannot be read to find out, is left out (the
 * same outcome as any file the editor does not take); it never rejects the rest.
 * @param {Iterable<File>} files
 * @returns {Promise<Map<File,'pdf'|'image'>>}
 */
export async function classifyFiles(files) {
  const kinds = new Map();
  for (const f of files) {
    let kind = null;
    try { kind = await sniffKind(f); } catch { /* unreadable: skipped like any file we cannot take */ }
    if (kind) kinds.set(f, kind);
  }
  return kinds;
}
