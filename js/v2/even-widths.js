/*
 * PDFLokal — v2/even-widths.js  ("Samakan lebar": one width for every page)
 * ============================================================================
 * The founder's rulings of 2026-11-03, in one place:
 *   1. The anchor is page 1's width (core/operations.js anchorPage). Every page
 *      scales to it uniformly, ratio kept, smaller ones up and wider ones down,
 *      landscape pages included.
 *   2. A single file is never changed unasked. When one opens with pages of
 *      different displayed widths, ONE dialog asks, once per opened document.
 *      Esc, a tap outside, or "Nanti aja" keep it as it is.
 *   3. After evening (from the dialog or from Kelola Halaman) a toast says so,
 *      with one action, "Kembalikan", which restores the original sizes. Each
 *      change is one undo step.
 *   4. A merge still evens by itself (normalizePageWidths, untouched); it now
 *      says so with the same toast and the same "Kembalikan".
 *
 * Every change goes record(history) -> core op -> deps.onResized(), the same
 * order page-manager.js's own ops follow, so undo/redo, the rasters (the op
 * drops the raster of every page it moves) and the tap-text caches (keyed by
 * the page's display frame, width included) need nothing special here.
 *
 * deps = {
 *   getDoc(), history,
 *   onResized(),             app: invalidate, rebuild the stage, refit the zoom
 *   toast(msg, { action }),  app's toast (toast-layer.js), one action allowed
 *   tel(event, props),       the app's own tel wrapper
 *   dialog,                  the #even-offer <dialog> (null on a page without it)
 *   isSheetOpen(),           is Kelola Halaman open (its row speaks instead)
 * }
 */
import { evenPageWidths, restorePageWidths, pageWidthsState } from '../core/operations.js';
import { record } from '../core/history.js';
import { t as tr } from '../lib/i18n.js';

export function createEvenWidths({ getDoc, history, onResized, toast, tel, dialog, isSheetOpen = () => false }) {
  // "Once per opened document": keyed by the Doc object, which Buka Baru and a
  // restore replace wholesale (resetDoc), so a new document is asked afresh.
  const offered = new WeakSet();

  // Even every page to page 1's width. Returns true when anything moved.
  function even() {
    const doc = getDoc();
    if (pageWidthsState(doc) !== 'mixed') return false;
    record(history, doc);
    const moved = evenPageWidths(doc);
    if (moved.length === 0) return false;
    tel('tool_use', { tool: 'halaman', action: 'even_widths' });
    onResized();
    afterMerge(null); // the same toast and the same way back
    return true;
  }

  // Every page back to its own size. Returns true when anything moved.
  function restore() {
    const doc = getDoc();
    if (pageWidthsState(doc) !== 'evened') return false;
    record(history, doc);
    const moved = restorePageWidths(doc);
    if (moved.length === 0) return false;
    tel('tool_use', { tool: 'halaman', action: 'restore_widths' });
    onResized();
    return true;
  }

  // After a merge's own normalisation (app.js loadFilesInner): say what it did,
  // and offer the way back. `merged` is the merge's own message ("Dijepit jadi
  // satu, sekarang 4 halaman"), or null for files opened together onto an
  // empty editor, which never had a merge tally. The toast is one slot
  // (toast-layer.js), so the two travel as one message rather than one
  // replacing the other.
  //
  // WHY NOTHING about widths while Kelola Halaman is open (seat review
  // 2026-11-03, phone-light-3): the toast sat over the sheet's footer
  // (Putar/Ekstrak), and the sheet's own row already says exactly "Lebar
  // halaman sudah disamakan" with the same Kembalikan, right where the tap
  // was. Lifting the toast would only move it over the grid. So the row is
  // the one voice there; a merge's page count, which the row does not say,
  // still toasts, plain.
  function afterMerge(merged) {
    if (isSheetOpen()) {
      if (merged) toast(merged);
      return;
    }
    const msg = merged ? `${merged}. ${tr('even.done')}` : tr('even.done');
    toast(msg, { action: { label: tr('even.restore'), onClick: () => restore() } });
  }

  // The once-per-document offer, after a single file opens. Never over another
  // dialog (the reopen ask, a sheet): skipped, not queued, so it cannot surface
  // later in a context that no longer explains it.
  function offerOnOpen() {
    const doc = getDoc();
    if (!dialog || offered.has(doc) || pageWidthsState(doc) !== 'mixed') return false;
    if (document.querySelector('dialog[open]')) return false;
    offered.add(doc);
    dialog.querySelector('#eo-title').textContent = tr('even.title');
    dialog.querySelector('#eo-body').textContent = tr('even.body');
    const go = dialog.querySelector('#eo-go');
    const later = dialog.querySelector('#eo-later');
    go.textContent = tr('even.go');
    later.textContent = tr('even.later');

    // EXACTLY ONE outcome per showing: the close handler fires on every close,
    // the button-driven ones included (the scan offer's own rule, app.js).
    let settled = false;
    const settle = (action) => {
      if (settled) return;
      settled = true;
      tel('even_offer', { action });
    };
    go.onclick = () => {
      settle('accepted');
      dialog.close();
      even();
    };
    later.onclick = () => { settle('dismissed'); dialog.close(); };
    // A tap on the backdrop is a tap on the <dialog> itself (the global dialog
    // CSS is the overlay, the .sheet child is the card).
    dialog.onclick = (e) => { if (e.target === dialog) { settle('dismissed'); dialog.close(); } };
    dialog.addEventListener('close', function once() {
      dialog.removeEventListener('close', once);
      settle('dismissed'); // Esc
    });
    tel('even_offer', { action: 'shown' });
    dialog.showModal();
    return true;
  }

  return { even, restore, afterMerge, offerOnOpen, state: () => pageWidthsState(getDoc()) };
}
