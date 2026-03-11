/*
 * PDFLokal - lib/events.js (ES Module)
 * SINGLE SOURCE OF TRUTH — app-wide event emitter (Fabric.js pattern)
 *
 * WHY: Decouples state mutations from UI sync. Modules emit events after
 * mutating state; subscribers react without the emitter knowing who listens.
 * Prevents the class of bugs where a new code path forgets to call
 * ueRenderThumbnails() or ueUpdatePageCount() after modifying pages.
 *
 * Events:
 *   pages:changed        — pages added/removed/reordered/restored
 *   annotations:changed  — annotation structurally added or removed
 *   annotations:modified — gesture complete (mouseup after drag/resize/edit)
 *   page:selected        — current page changed
 *   tool:changed         — active tool switched
 *
 * Detail objects include { source: 'user' | 'restore' } where applicable,
 * so subscribers can skip redundant work during undo/redo restores.
 */

const listeners = {};

export function on(event, fn) {
  if (!listeners[event]) listeners[event] = [];
  listeners[event].push(fn);
  return () => off(event, fn);
}

export function off(event, fn) {
  const arr = listeners[event];
  if (arr) listeners[event] = arr.filter(f => f !== fn);
}

export function emit(event, detail) {
  const arr = listeners[event];
  if (arr) arr.slice().forEach(fn => fn(detail));
}
