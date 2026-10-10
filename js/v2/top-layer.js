// Transient feedback (the toast, the Memproses overlay) must paint ABOVE an open
// modal sheet. `dialog.showModal()` puts the sheet in the browser's top layer, and
// nothing in the normal stacking order (any z-index) outranks the top layer, so
// a plain `position:fixed` toast fired from inside the Halaman sheet was drawn
// under it and never seen. The way above is to be in the top layer ourselves
// and enter it AFTER the dialog: `popover="manual"` + `showPopover()`.
//
// Re-entering matters: a manual popover that is already open keeps its OLD place
// in the top-layer order, so a toast shown before a sheet opened would stay
// beneath it. Hide-then-show in the same task moves it to the top without a
// paint in between.
//
// Never throws, and degrades to the old stacking where the Popover API is absent
// (Chrome < 114, Safari < 17): feedback is then hidden under a sheet exactly as
// it was before, not broken.

export function raiseToTopLayer(el) {
  if (!el || typeof el.showPopover !== 'function') return false;
  try {
    if (el.matches(':popover-open')) el.hidePopover();
    el.showPopover();
    return true;
  } catch {
    return false;
  }
}

export function dropFromTopLayer(el) {
  if (!el || typeof el.hidePopover !== 'function') return;
  try {
    if (el.matches(':popover-open')) el.hidePopover();
  } catch { /* detached: nothing to leave */ }
}

// The modal dialogs open right now. `dialog:modal` is the precise selector;
// where the browser does not know it (Safari < 15.6) fall back to every open
// dialog, which in this app are all modal.
export function openModalDialogs(doc) {
  if (!doc) return [];
  try {
    return [...doc.querySelectorAll('dialog:modal')];
  } catch {
    return [...doc.querySelectorAll('dialog[open]')];
  }
}

// The Memproses overlay is raised 180ms after showProcessing(). Raise it only if
// no modal dialog has opened since: a dialog opened in that window must stay
// above the cover. A dialog that was already open at the start (the Halaman
// sheet's [+] add) is exactly the case the raise exists for, so it does not block.
export function shouldRaiseOverlay(openAtStart, openNow) {
  const before = new Set(openAtStart);
  return !openNow.some((d) => !before.has(d));
}
