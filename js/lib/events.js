/*
 * PDFLokal - lib/events.js (ES Module)
 * ⚠️ OLD WING ONLY — dies with js/editor/ + js/pdf-tools/ at demolition.
 * Verified 2026-08-09 by import graph: NOTHING in js/v2/, js/core/ or js/render/
 * imports this file. Every consumer is the legacy wing (js/editor/, js/pdf-tools/,
 * js/init*.js, js/image-tools.js, js/img-to-pdf.js, js/keyboard.js, js/mobile-ui.js),
 * reachable only from alat-gambar.html. `js/lib/analytics.js` is the ONE module in
 * this directory the live product still imports.
 *
 * WHY THIS BANNER: the folder name says "lib" and CLAUDE.md lists these as the
 * project's SSOT helpers, so a session doing v2 work reaches for them on the
 * strength of that and gets either silent failure (they touch ueState, which v2
 * has no equivalent of) or the dying wing dragged into v2's module graph.
 * js/theme.js's own header records that happening once already. Do not import
 * this from the live wing; the v2 equivalent is what you want.
 *
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
