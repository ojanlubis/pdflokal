/*
 * PDFLokal — v2/telemetry.js  (TELEMETRY CLIENT — spec-telemetry.md)
 * ============================================================================
 * Fire-and-forget, same-origin telemetry: tel(event, props) validates LOCALLY
 * against the shared SCHEMA (js/core/telemetry-schema.js — the SAME module
 * api/t.js imports server-side, so client and server can never disagree
 * about what's allowed), queues, and flushes via sendBeacon once the queue
 * hits FLUSH_AT or the tab goes hidden. Every exported function is
 * try/catch-armored: a bug in here must never become a bug in the editor.
 * No cookies, no localStorage, no retries — a lost batch is lost, never
 * queued for later (spec §2, §7's falsifier: accept residual loss, never
 * escalate to blocking sends).
 *
 * NOT the same rail as js/lib/analytics.js (GA4 + Vercel Web Analytics,
 * acquisition-focused, third-party) — that module is untouched. This one is
 * first-party product telemetry; the two are never dual-written to the same
 * event.
 */
import { validateEvent } from '../core/telemetry-schema.js';

const ENDPOINT = '/api/t';
const FLUSH_AT = 10;

// WHY crypto.randomUUID, generated ONCE per pageload and never persisted:
// enough to join events into one funnel (this open → this download), useless
// for tracking a person across visits (spec §2 — no cookies, no
// localStorage id, no fingerprinting).
const sessionId = crypto.randomUUID();

// <meta name="pdflokal-rev"> is stamped at deploy time (commit SHA) when
// present; local dev and any page that doesn't carry it are honestly 'dev'
// rather than guessing — api/t.js's own APP_VERSION_RE only accepts exactly
// these two shapes.
function readAppVersion() {
  try {
    const meta = document.querySelector('meta[name="pdflokal-rev"]');
    const v = meta?.content;
    return v && /^[0-9a-f]{7,40}$/.test(v) ? v : 'dev';
  } catch {
    return 'dev';
  }
}
const appVersion = readAppVersion();

// WHY localhost-only console.warn: an off-schema call site is a bug in OUR
// code (a typo'd prop, a stale enum) — dev needs to see it loudly, but a
// warning has no business reaching a real user's console.
const isLocalDev = (() => {
  try {
    return typeof location !== 'undefined'
      && (location.hostname === 'localhost' || location.hostname === '127.0.0.1');
  } catch {
    return false;
  }
})();

let queue = [];

function flush() {
  try {
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    const payload = JSON.stringify({ session_id: sessionId, app_version: appVersion, events: batch });
    if (typeof navigator?.sendBeacon !== 'function') return; // no beacon support — drop, never retry
    const blob = new Blob([payload], { type: 'application/json' });
    navigator.sendBeacon(ENDPOINT, blob);
  } catch {
    // Telemetry can NEVER throw into app code (spec §2).
  }
}

// Flush on hide, not on 'unload'/'beforeunload' (unreliable on mobile and
// actively discouraged — bfcache eviction). visibilitychange:hidden fires on
// tab-switch, app-switch, and navigation alike, which is the spec's own
// mitigation for sendBeacon loss on Android WebView/iOS Safari (spec §7).
try {
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }
} catch {
  // Never let wiring the listener itself break page load.
}

/**
 * Record a telemetry event. Validates against SCHEMA locally, queues it, and
 * flushes when the queue is full. Silently drops anything off-schema.
 * @param {string} event
 * @param {Record<string, string|number|boolean>} [props]
 */
export function tel(event, props = {}) {
  try {
    const { ok, clean } = validateEvent(event, props);
    if (!ok) {
      if (isLocalDev) {
        console.warn(`[telemetry] dropped off-schema event "${event}"`, props);
      }
      return;
    }
    queue.push({ event, props: clean });
    if (queue.length >= FLUSH_AT) flush();
  } catch {
    // Telemetry can NEVER throw into app code (spec §2).
  }
}

// ---- human feedback (BETA loop — founder ruling 2026-07-22) --------------------
// A DELIBERATE exception to this file's string-free law: the thumbs pill lets a
// user TYPE a note. That note is the ONE user-authored free field in the whole
// telemetry surface — so it does NOT ride tel()/the typed events table. It goes
// to its OWN endpoint (/api/feedback) and its OWN Supabase table, keeping the
// `events` rail's "no string field ever" invariant intact (spec-telemetry.md
// §2 — the boundary law is about the MACHINE filling a free field; a human
// consciously writing feedback is the inverse case, and it stays walled off).
// Reuses THIS session's id + app_version so a 👎 correlates with the ganti_
// commit/insert/surgery events that same session emitted. Sent immediately
// (a discrete, deliberate tap), never batched. NEVER carries document text.
const FEEDBACK_ENDPOINT = '/api/feedback';
const FEEDBACK_NOTE_MAX = 1000;

/**
 * Record a thumbs rating (+ optional free-text note) for the edit feature.
 * @param {'up'|'down'} rating
 * @param {string} [note] user-typed, capped, optional
 */
export function feedback(rating, note) {
  try {
    if (rating !== 'up' && rating !== 'down') return;
    const payload = { session_id: sessionId, app_version: appVersion, rating };
    const trimmed = typeof note === 'string' ? note.trim().slice(0, FEEDBACK_NOTE_MAX) : '';
    if (trimmed) payload.note = trimmed;
    if (typeof navigator?.sendBeacon !== 'function') return; // no beacon — drop, never retry
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    navigator.sendBeacon(FEEDBACK_ENDPOINT, blob);
  } catch {
    // Feedback can NEVER throw into app code — same law as tel().
  }
}
