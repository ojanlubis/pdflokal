// The toast's lifecycle: in the top layer ONLY while it is visible.
//
// #toast is popover="manual" (js/v2/top-layer.js) so it paints above an open
// modal sheet. A manual popover stays open until hidePopover(), and an open
// popover paints above every non-top-layer element, so one left open after its
// fade would sit over #support-card / #install-card / #maker-card / #vote-card
// for the rest of the session. So: raise on show, drop once the fade is done.
//
// Dependencies are injected so the timing can be driven by a fake clock; app.js
// passes the real ones.

// Longer than the 0.2s opacity transition on #toast (a test pins this): the
// popover must outlive the fade-out or the fade is cut to nothing.
export const TOAST_FADE_MS = 260;

export function createToast({
  el, durationMs, raise, drop,
  schedule = setTimeout, cancel = clearTimeout, fadeMs = TOAST_FADE_MS,
}) {
  let hideTimer = null;
  let dropTimer = null;

  function startFade() {
    el.classList.remove('show');
    cancel(dropTimer);
    dropTimer = schedule(() => drop(el), fadeMs);
  }

  return {
    show(msg) {
      el.textContent = msg;
      el.classList.add('show');
      // Every call, not once: a sheet opened since the last toast sits above it.
      raise(el);
      cancel(hideTimer);
      cancel(dropTimer);
      hideTimer = schedule(startFade, durationMs(msg));
    },
    hide() {
      cancel(hideTimer);
      startFade();
    },
  };
}
