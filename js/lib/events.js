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
 *   pages:changed — pages added/removed/reordered/restored
 *     Subscribers: sidebar (thumbnails), lifecycle (page count)
 *     Detail: { source: 'user' | 'restore' }
 *
 * NOTE: Earlier iterations defined annotations:changed, annotations:modified,
 * page:selected, and tool:changed channels, but none ever gained a subscriber
 * — direct calls (ueRedrawAnnotations etc.) were used instead. Those emits
 * were removed in May 2026. Re-introduce a channel only when a second
 * independent consumer of the same signal exists; otherwise prefer the
 * direct call to keep the data flow obvious.
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
