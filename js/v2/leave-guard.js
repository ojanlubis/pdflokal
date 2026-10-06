/*
 * PDFLokal — v2/leave-guard.js  (the browser's "leave site?" prompt)
 * ============================================================================
 * Armed ONLY while the document has changes nobody has downloaded; core/history.js
 * decides that (isDirty, markClean) and calls setLeaveGuard on every flip.
 *
 * WHY add/remove instead of one always-on handler: a page with a beforeunload
 * listener is not eligible for the back/forward cache in some browsers, and
 * telemetry.js flushes on visibilitychange for the same reason. So the listener
 * exists for the minutes a user holds unsaved edits, and not otherwise.
 *
 * NO CUSTOM TEXT: browsers ignore it and show their own sentence, so there is
 * no copy here. Mobile Safari mostly shows nothing at all; nothing to do about it.
 */
let armed = false;

function onBeforeUnload(e) {
  e.preventDefault();
  e.returnValue = ''; // legacy engines need this to show the prompt
}

export function setLeaveGuard(on) {
  if (on === armed) return;
  armed = on;
  if (on) window.addEventListener('beforeunload', onBeforeUnload);
  else window.removeEventListener('beforeunload', onBeforeUnload);
}
