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
