/*
 * PDFLokal — v2/edit-expectations.js  (the Edit tool says its limits when they bite)
 * ============================================================================
 * Pure decisions behind seven messages (founder-approved copy, 2026-10-03):
 * the moments where Edit cannot do what the person expects — a tap with no text
 * under it, a line that cannot wrap, a locked or signed file, text that is only
 * covered rather than removed. No DOM and no i18n here, so tests/core can drive
 * every rule headless; app.js and download-sheet.js own the words (tr('...')
 * with literal keys, which tests/core/i18n.test.mjs needs to see).
 */

// ---- toast duration ------------------------------------------------------------
// WHY: one 2.6 s toast was shorter than the longest of these sentences takes to
// read. Short text keeps 2.6 s; every word past ~5 adds 330 ms.
export const TOAST_MIN_MS = 2600;
export function toastDurationMs(msg) {
  const words = String(msg ?? '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(TOAST_MIN_MS, 900 + 330 * words);
}

// ---- once per document -----------------------------------------------------------
// Keyed by the Doc object: "Buka Baru" creates a new one (resetDoc), so a fresh
// document starts with every message unseen and nothing needs resetting by hand.
const seen = new WeakMap(); // doc -> Set<string>
export function firstTimeForDoc(doc, key) {
  if (!doc || typeof doc !== 'object') return false;
  let set = seen.get(doc);
  if (!set) { set = new Set(); seen.set(doc, set); }
  if (set.has(key)) return false;
  set.add(key);
  return true;
}
// Look without consuming (the editor's per-keystroke guard asks this first).
export function alreadyShownForDoc(doc, key) {
  return !!(doc && typeof doc === 'object' && seen.get(doc)?.has(key));
}

// ---- arming Edit: locked / signed notice -----------------------------------------
// Returns the toast key to show in place of 'toast.armEdit', or null for the
// normal one. Encrypted wins over signed (a locked file cannot be saved at all,
// so a signature warning would be the lesser news). Each fires once per document.
export function armEditNoticeKey(doc) {
  const sources = doc?.sources || [];
  if (sources.some((s) => s.encrypted)) {
    return firstTimeForDoc(doc, 'armEditLocked') ? 'armEditLocked' : null;
  }
  if (sources.some((s) => s.signed)) {
    return firstTimeForDoc(doc, 'armEditSigned') ? 'armEditSigned' : null;
  }
  return null;
}

// ---- single-line edit: did the typed text outgrow the original line? ---------------
export const LINE_WIDTH_TOLERANCE = 0.02;
// The editor has min-width 40px (index.html .v2-text-edit), so a shorter original
// would read as "wider" on the first keystroke; never compare against less.
export const EDITOR_MIN_WIDTH = 40;
export function lineOutgrew(editorWidth, originalWidth) {
  if (!(editorWidth > 0) || !(originalWidth > 0)) return false;
  return editorWidth > Math.max(originalWidth, EDITOR_MIN_WIDTH) * (1 + LINE_WIDTH_TOLERANCE);
}

// ---- Unduh note: covered text is still in the file --------------------------------
// `covered` is how many Tip-Ex rectangles the export build actually PAINTED
// (core/export.js onCoverDrawn): a plain Tip-Ex, a scan patch, or an Edit/Hapus
// whose cut fell back to a cover. Counting what is drawn into the file, rather
// than flagging edits as they happen, cannot go stale on undo and cannot miss a
// bake that failed. Image format has no PDF left to carry text. Compress
// rasterises every page, so the text is gone there, unless it handed the file
// back unchanged ("sudah optimal").
export function coveredNoteShows({ format, size, covered, compressedUnchanged = false }) {
  if (format !== 'pdf' || !(covered > 0)) return false;
  if (size === 'kompres') return !!compressedUnchanged;
  return true;
}
