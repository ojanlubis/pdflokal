/*
 * PDFLokal — core/incoming-files.js  (IS THIS PICK / DROP WORTH OPENING AT ALL?)
 * ============================================================================
 * SINGLE SOURCE OF TRUTH for the two refusals that need no parsing: nothing in
 * the selection is a PDF or an image, or a usable file is over the size block.
 *
 * WHY it is a module and not two lines inside loadFiles: the REPLACE paths
 * (Ganti in #drop-choice, File > Buka Baru) wipe the open document and its undo
 * history, so they must ask this BEFORE the wipe. Asked after, as it used to
 * be, a .docx or a 100 MB+ file destroyed the work and then was refused,
 * leaving a blank editor. loadFiles asks the same function, so the rule has one
 * home and the two cannot drift.
 *
 * Returns WHICH refusal ('pickFile' | 'tooBig'), not toast text: the caller owns
 * the toast, and i18n's scanner needs every tr() key to be a literal in the
 * file that calls it.
 */

// Block at 100MB — a 100MB+ file will OOM the weak phones we build for before
// it ever renders. (The old >20MB heads-up toast was retired when the
// processing overlay landed — see showProcessing in v2/app.js.)
export const SIZE_BLOCK = 100 * 1024 * 1024;

export const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const isImg = (f) => f.type.startsWith('image/');

// → { usable } (in picker order: PDFs append their pages, images become one
// page each) or { usable, refusal: 'pickFile' | 'tooBig', name } (name: the
// first oversize file).
export function checkIncoming(files) {
  const usable = [...files].filter((f) => isPdf(f) || isImg(f));
  if (usable.length === 0) return { usable, refusal: 'pickFile' };
  const oversize = usable.find((f) => f.size > SIZE_BLOCK);
  if (oversize) return { usable, refusal: 'tooBig', name: oversize.name };
  return { usable };
}

// The ONE guard both replace paths (Ganti, Buka Baru) ask before they wipe the
// open document: a load already running (loadFiles would refuse after the wipe,
// leaving nothing), then the selection itself. → null when the replace may go
// ahead, else the checkIncoming verdict or { refusal: 'stillLoading' }.
export function replaceRefusal({ loading, files }) {
  if (loading) return { refusal: 'stillLoading' };
  const verdict = checkIncoming(files);
  return verdict.refusal ? verdict : null;
}
