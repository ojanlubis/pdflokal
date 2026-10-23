/*
 * PDFLokal — v2/leave-guard.js  (the browser's "leave site?" prompt)
 * ============================================================================
 * Armed ONLY while there is work nobody has downloaded: the document changed
 * (core/history.js decides that, isDirty/markClean, and calls setLeaveGuard on
 * every flip), or an open text editor holds typed text (guardDraft, below).
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
let dirty = false;  // core/history.js: the document changed since the last download
let draft = null;   // the open text editor's live "holds typed text?" check, or null

// The open editor's text is not in the history until its commit, and the editor
// now stays open across a window or app switch (editor-blur.js). So typed text on
// a clean document counts too, WITHOUT recording a history step: the editor
// registers a check (guardDraft) and its commit releases it. The check is read
// at unload time, not cached, so an editor destroyed without its commit (a file
// dropped while typing) reads false instead of prompting for nothing.
function onBeforeUnload(e) {
  if (!dirty && !(draft && draft())) return;
  e.preventDefault();
  e.returnValue = ''; // legacy engines need this to show the prompt
}

function sync() {
  const on = dirty || !!draft;
  if (on === armed) return;
  armed = on;
  if (on) window.addEventListener('beforeunload', onBeforeUnload);
  else window.removeEventListener('beforeunload', onBeforeUnload);
}

export function setLeaveGuard(on) {
  dirty = on;
  sync();
}

// Returns the release. It drops the check only if it is still the current one:
// opening a second editor focuses it, and the first editor's blur commits (and
// releases) after the second has registered.
export function guardDraft(hasTypedText) {
  draft = hasTypedText;
  sync();
  return () => {
    if (draft !== hasTypedText) return;
    draft = null;
    sync();
  };
}
