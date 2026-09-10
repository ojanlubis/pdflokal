/*
 * PDFLokal — v2/telemetry.js  (TELEMETRY CLIENT — spec-telemetry.md)
 * ============================================================================
 * Fire-and-forget, same-origin telemetry: tel(event, props) validates LOCALLY
 * against the shared SCHEMA (js/core/telemetry-schema.js — the SAME module
 * api/t.js imports server-side, so client and server can never disagree
 * about what's allowed), queues, and flushes via sendBeacon once the queue
 * hits FLUSH_AT or the tab goes hidden. Every exported function is
 * try/catch-armored: a bug in here must never become a bug in the editor.
 * No cookies, no retries — a lost batch is lost, never queued for later
 * (spec §2, §7's falsifier: accept residual loss, never escalate to
 * blocking sends).
 *
 * ⚠️ "NO LOCALSTORAGE" STOPPED BEING TRUE 2026-09-10, AND THIS IS THE ONE
 * DELIBERATE EXCEPTION. `visitor_id` (below) is a single UUID in
 * `pdflokal_visitor_id`, generated once and reused on every later visit from
 * the same browser — his ruling, because retention ("does anyone come back")
 * is structurally unanswerable from `session_id` alone (spec above: a fresh
 * id every pageload, measured 2026-09-10 at 0.25% of ids ever seen on a
 * second day, almost all midnight straddles). It rides ONLY this rail's
 * envelope, to THIS product's own Neon table. It is never read by, written
 * to, or forwarded into js/lib/analytics.js's track() — Mixpanel, GA4,
 * Vercel Analytics and Sentry never see it, and privasi.html says so.
 *
 * NOT the same rail as js/lib/analytics.js (GA4 + Vercel Web Analytics,
 * acquisition-focused, third-party) — that module is untouched. This one is
 * first-party product telemetry; the two are never dual-written to the same
 * event.
 */
import { validateEvent } from '../core/telemetry-schema.js';
import { validateSample } from '../core/feedback-sample.js';
import { validateShot } from '../core/feedback-shot.js';

const ENDPOINT = '/api/t';
const FLUSH_AT = 10;

// WHY crypto.randomUUID, generated ONCE per pageload and never persisted:
// enough to join events into one funnel (this open → this download), useless
// for tracking a person across visits (spec §2 — no cookies, no
// localStorage id, no fingerprinting).
// WHY THE FALLBACK, and why it is not optional: randomUUID is absent on iOS
// Safari < 15.4 and in any NON-SECURE context (LAN http). This line runs at
// module TOP LEVEL and app.js imports this module, so an unguarded throw here
// takes the entire import graph with it — page renders, every button dead
// (Sentry JAVASCRIPT-T; js/lib/analytics.js took the identical fix in July and
// this sibling was missed). A session id needs UNIQUENESS, not cryptography.
//
// WHY THE FALLBACK MUST BE SHAPED LIKE A UUID (2026-09-07, found while fixing
// the above): the FIRST fallback (682cb7e) stopped the throw but shipped
// `s-${Date.now()...}-${Math.random()...}` — never a UUID. api/t.js's own
// `UUID_RE` rejects anything that isn't `[0-9a-f]{8}-...{4}-...{4}-...{4}-
// ...{12}`, and a session_id that fails it drops the WHOLE envelope, not just
// the id ("either failing means we can't trust the envelope at all"). So the
// exact population this exists to save — old iOS Safari, LAN http — went from
// "kills the app" to "invisible to the rail, silently, forever": worse in one
// way (unmeasurable) though better in the one that matters (the editor still
// works). `crypto.getRandomValues` is the still-cryptographic middle rung
// (present on far more runtimes than `randomUUID`, e.g. any secure-context
// browser before randomUUID's 2021 rollout); `Math.random` is the last resort
// for a runtime with no `crypto` object at all. Both branches below are laid
// out as an RFC4122 v4 string on purpose — a session id needs uniqueness and
// SHAPE, not cryptographic strength, and shape is the part the server checks.
function randomUUIDFromBytes(bytes) {
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
// __ prefix marks a test-only export (same convention as api/t.js's
// __setQueryForTests) — nothing in this module's own code calls it directly
// by name, `sessionId` and `readVisitorId()` below do.
export function __randomUUIDFallback() {
  if (typeof crypto?.getRandomValues === 'function') {
    return randomUUIDFromBytes(crypto.getRandomValues(new Uint8Array(16)));
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return randomUUIDFromBytes(bytes);
}
function freshUUID() {
  return typeof crypto?.randomUUID === 'function' ? crypto.randomUUID() : __randomUUIDFallback();
}
const sessionId = freshUUID();

// ---- visitor_id: the ONE persistent id on this rail (his ruling, 2026-09-10) --
// A UUID in localStorage, generated once, reused forever, so `events` rows
// from the same browser can be joined ACROSS visits — the thing `sessionId`
// above is deliberately unable to do. See the file header for why this
// exception exists and what it is walled off from.
//
// WHY IT NEVER THROWS AND NEVER BLOCKS: same law as everything else in this
// file (spec §2) — a storage failure (private mode, blocked storage, quota)
// must degrade telemetry, never break it. On failure this returns null, and
// EVERY caller below treats null as "omit the field" — sending a value that
// only looks persistent (freshly minted, never actually saved) would be
// worse than sending nothing, because it would silently poison the
// retention read with visitors who are each counted as new every time.
//
// WRITE-BACK IS VERIFIED, NOT ASSUMED: some browsers' private-mode
// localStorage accepts a setItem that never actually persists (Safari's old
// behaviour). Reading the value back is the only way to know the id will
// still be there on the NEXT visit, which is the entire point of this key.
const VISITOR_ID_KEY = 'pdflokal_visitor_id';
const VISITOR_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function readVisitorId() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const existing = localStorage.getItem(VISITOR_ID_KEY);
    if (typeof existing === 'string' && VISITOR_ID_RE.test(existing)) return existing;
    const fresh = freshUUID();
    localStorage.setItem(VISITOR_ID_KEY, fresh);
    return localStorage.getItem(VISITOR_ID_KEY) === fresh ? fresh : null;
  } catch {
    return null; // private mode / blocked storage — tel() still runs, just without a persistent id
  }
}
const visitorId = readVisitorId();

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
let appVersion = readAppVersion();

// ASK THE SERVER WHICH BUILD THIS IS. `readAppVersion()` above always returns
// 'dev' in production: nothing stamps the meta tag, because there is no build
// step. So api/t.js used to overwrite it with the server's deploy SHA AT THE
// MOMENT THE BATCH ARRIVED — which made one 82-minute session on 2026-07-28
// carry FOUR versions (four deploys landed while it flushed; nothing reloaded),
// and made "did the build we just shipped break this?" unanswerable.
//
// /api/rev answers it once, here, pinned to THIS page load. Deliberately:
//   - NOT awaited. The first batch or two may still go out as 'dev'; that is
//     strictly better than delaying a flush, because a flush that loses its
//     race with the tab closing loses the events entirely.
//   - failure is silent and terminal. No retry: offline means the answer would
//     describe a deploy this page never loaded (see api/rev.js), so 'dev'
//     falling through to the server's stamp is the HONEST degradation.
(function askRev() {
  try {
    if (typeof fetch !== 'function') return;
    fetch('/api/rev', { cache: 'no-store', credentials: 'omit' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const rev = d && typeof d.rev === 'string' ? d.rev : '';
        if (/^[0-9a-f]{7,40}$/.test(rev)) appVersion = rev;
      })
      .catch(() => {});
  } catch { /* telemetry can never throw into app code */ }
}());

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

// WHY EACH EVENT CARRIES `dt` (2026-07-28): the stored `events.ts` used to be
// the BATCH FLUSH time — api/t.js stamped one `new Date()` for the whole batch,
// so ten events in a session shared a timestamp to the millisecond. Intra-
// session ordering only worked by `id`, and anything reasoning about INTERVALS
// (a funnel, an alarm, "how long between tap and commit") was reasoning about
// nothing.
//
// `dt` is milliseconds BEFORE the flush, not an absolute clock reading, and
// that is deliberate: a client clock can be wrong by hours (skew, manual
// change, a wrong timezone), and an absolute client timestamp would import that
// error straight into the table. A relative offset is immune to skew and still
// preserves both ordering and the intervals between events. The server does
// `ts = received - dt`, so the only clock that matters is the server's.
//
// Clamped to [0, 6h] here as well as on the server: a queued event older than a
// session has no meaning, and an unclamped value would let a wrong client clock
// write far-future or far-past rows.
const MAX_EVENT_AGE_MS = 6 * 60 * 60 * 1000;

function flush() {
  try {
    if (queue.length === 0) return;
    const now = Date.now();
    const batch = queue.map((e) => ({
      event: e.event,
      props: e.props,
      dt: Math.max(0, Math.min(MAX_EVENT_AGE_MS, now - e.t)),
    }));
    queue = [];
    // visitor_id rides every batch, null when storage failed (see readVisitorId
    // above) — api/t.js treats null/absent/invalid identically: write NULL,
    // never drop the batch over it. Never let a rejected visitor_id take
    // session_id/app_version/events down with it.
    const payload = JSON.stringify({
      session_id: sessionId,
      app_version: appVersion,
      visitor_id: visitorId,
      events: batch,
    });
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
    queue.push({ event, props: clean, t: Date.now() });
    if (queue.length >= FLUSH_AT) flush();
  } catch {
    // Telemetry can NEVER throw into app code (spec §2).
  }
}

// ---- human feedback (BETA loop — founder ruling 2026-07-22) --------------------
// A DELIBERATE exception to this file's string-free law: the thumbs pill lets a
// user TYPE a note. That note is the ONE user-authored free field in the whole
// telemetry surface — so it does NOT ride tel()/the typed events table. It goes
// to its OWN endpoint (/api/feedback) and its OWN table, keeping the
// `events` rail's "no string field ever" invariant intact (spec-telemetry.md
// §2 — the boundary law is about the MACHINE filling a free field; a human
// consciously writing feedback is the inverse case, and it stays walled off).
// Reuses THIS session's id + app_version so a 👎 correlates with the ganti_
// commit/insert/surgery events that same session emitted. Sent immediately
// (a discrete, deliberate tap), never batched. NEVER carries document text.
const FEEDBACK_ENDPOINT = '/api/feedback';
const FEEDBACK_NOTE_MAX = 1000;

// ---- Increment D: the consent-gated sample (spec-edit-fidelity-instrumentation.md) --
// Two small crops (before/after PNG data URLs of the edited line's OWN box) a
// user explicitly asked us to send after a 👎 — never automatic, never the
// page or the file (decisions.md 2026-07-23/2026-07-27). Only PLUMBING lives
// here: js/v2/app.js decides WHETHER to offer a sample and captures the
// crops; js/v2/edit-feedback.js decides whether the user actually tapped
// Kirim. This module's only job is "is this pair small/well-formed enough to
// go out the wire at all" (validateSample, shared with api/feedback.js's
// server-side mirror so the two never disagree) and "which transport".
//
// TRANSPORT FINDING (builder, 2026-07-27): sendBeacon's common ~64KiB payload
// cap is NOT sendBeacon-specific — fetch's own spec enforces the identical
// 64KiB budget for ANY keepalive:true request ("if contentLengthValue +
// inflightKeepaliveBytes > 64 KiB, network error", confirmed against the
// Fetch Standard + real Chromium/WebKit behavior). Two PNG crops capped at
// 70KB combined (core/feedback-sample.js) base64-encode to ~93KB — still
// comfortably over BOTH. So `keepalive`
// buys nothing here; a PLAIN (non-keepalive) fetch is the actual fix, and is
// safe for this specific call because a 👎→Kirim tap is a synchronous,
// foreground user action — the page stays open (the pill still has to show
// "Makasih" for ~1.7s), unlike flush()'s visibilitychange-triggered batch
// send above, which genuinely needs beacon/keepalive's survive-navigation
// guarantee. If fetch itself is unavailable/throws synchronously, fall back
// to sendBeacon WITHOUT the images — the core rating+note signal must never
// be lost just because the bonus sample couldn't go.

/**
 * Record a thumbs rating (+ optional free-text note, + optional consent-
 * gated before/after sample) for the edit feature.
 * @param {'up'|'down'} rating
 * @param {string} [note] user-typed, capped, optional
 * @param {{before: string, after: string}} [sample] two PNG data URLs — only
 *   ever passed when the user saw them rendered in the pill and tapped Kirim.
 * @param {string} [shot] ONE JPEG data URL, and only ever a screenshot the user
 *   PASTED into the general feedback form themselves (js/v2/feedback-form.js).
 *   A FOURTH POSITIONAL ARGUMENT ON PURPOSE, rather than widening `sample`:
 *   the two images have different producers, different validators and different
 *   consent stories, and the day they share a parameter is the day a crop can
 *   arrive on the screenshot's path without anyone choosing it.
 */
export function feedback(rating, note, sample, shot) {
  try {
    if (rating !== 'up' && rating !== 'down') return;
    const payload = { session_id: sessionId, app_version: appVersion, rating };
    const trimmed = typeof note === 'string' ? note.trim().slice(0, FEEDBACK_NOTE_MAX) : '';
    if (trimmed) payload.note = trimmed;

    const validSample = validateSample(sample);
    if (validSample) {
      payload.sample_before = validSample.before;
      payload.sample_after = validSample.after;
    }
    const validShot = validateShot(shot);
    if (validShot) payload.screenshot = validShot;

    // Either image makes the body too large for sendBeacon's 64KB, so the fetch
    // path is what carries them. The condition used to name only the sample.
    if ((validSample || validShot) && typeof fetch === 'function') {
      try {
        // Plain fetch, no keepalive — see the transport finding above. Never
        // awaited, never surfaced to app code; a failed send here just means
        // no beacon fallback fires either (accepted residual loss, same as
        // every other telemetry drop in this file).
        fetch(FEEDBACK_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).catch(() => {});
        return;
      } catch {
        // fetch threw synchronously (disabled/CSP/etc) — fall through to the
        // beacon path below, WITHOUT the images (they're what made this
        // request too big for beacon in the first place).
      }
    }

    if (typeof navigator?.sendBeacon !== 'function') return; // no beacon — drop, never retry
    // Beacon fallback: the images are exactly what made this too big, so they
    // are what gets dropped. Rating and note still land — which is the same
    // trade every other drop in this file makes.
    if (validSample) { delete payload.sample_before; delete payload.sample_after; }
    if (validShot) delete payload.screenshot;
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    navigator.sendBeacon(FEEDBACK_ENDPOINT, blob);
  } catch {
    // Feedback can NEVER throw into app code — same law as tel().
  }
}
