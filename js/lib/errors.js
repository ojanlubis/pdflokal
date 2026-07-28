/*
 * PDFLokal - lib/errors.js (ES Module) — ⚠️ OLD WING ONLY
 * ============================================================================
 * Global error capture for the legacy app. Imported by `js/init.js`, which is
 * loaded ONLY by `alat-gambar.html`. **It does not run on the live product.**
 * Editor v2 (`index.html`) has its own capture at the bottom of js/v2/app.js,
 * which reports to the first-party rail instead.
 *
 * That distinction was missed on 2026-07-28 and is written here so the next
 * reader does not have to re-derive it: this file was reported as a live
 * production issue, ruled on, and only then did anyone check what actually
 * loads it. Finding a second instance of something is not the same as knowing
 * either one's reach.
 *
 * WHAT CHANGED 2026-07-28 — free text removed (seat ruling):
 * this used to send `message`, `source`, `line`, `col` and a 500-char `stack`
 * to GA4 on every uncaught error. An error message is free text we do not
 * control: `String(reason)` stringifies whatever a rejection happens to hold,
 * and a PDF parse error can quote stream content. Nobody observed content
 * leaving — the defect was the ASYMMETRY. On our own rail, content-blindness
 * is enforced BY CONSTRUCTION (SCHEMA has no string-typed prop, so content
 * cannot ride along even by accident); on this path nothing prevented it at all.
 *
 * The ruling was STOP, not sanitise: you cannot enumerate what an arbitrary
 * error might quote, so a sanitiser is a guess wearing a guarantee's clothes.
 * The count is kept — knowing THAT errors happen is most of the value, and the
 * diagnostic detail for the live product lives in Sentry.
 *
 * Legacy hygiene, not a production fix: this wing dies at demolition.
 */

import { track } from './analytics.js';

let installed = false;

export function installErrorCapture() {
  if (installed) return;
  installed = true;

  // `kind` only. No message, no stack, no filename — see the header. The
  // browser console still has everything for anyone debugging locally.
  window.addEventListener('error', () => {
    track('client_error', { kind: 'error' });
  });

  window.addEventListener('unhandledrejection', () => {
    track('client_error', { kind: 'unhandledrejection' });
  });
}
