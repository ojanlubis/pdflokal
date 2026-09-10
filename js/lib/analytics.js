/*
 * PDFLokal - lib/analytics.js (ES Module)
 * THE THIRD-PARTY EVENT FAN-OUT. track(name, data) is the single call site the
 * whole app uses; this file decides who hears it. Four sinks, in order: a Sentry
 * breadcrumb, Vercel Web Analytics va(), GA4 gtag(), and (since 2026-09-10)
 * Mixpanel. Every one is guarded, so a blocked or unloaded SDK is a no-op, never
 * an error. ⚠️ This is NOT the first-party Neon rail - that is tel() in
 * js/v2/telemetry.js, a different module with its own schema. The two rails are
 * never dual-written to the same event.
 * Generates a per-session ID to approximate user behavior patterns.
 *
 * WHY session ID: Vercel Analytics doesn't track sessions natively.
 * With session IDs, we can estimate heavy vs light users by counting
 * events per session in the dashboard.
 *
 * Privacy: No personal data, no file names, no file content.
 * Only tool names, action types, and anonymous session IDs.
 */

// WHY crypto.randomUUID: Resets on page refresh — not a persistent user ID.
// This is intentional: we only care about single-session behavior.
// WHY the fallback: randomUUID exists only in SECURE contexts (https/localhost).
// Over LAN http (phone → http://192.168.x.x:5050, the founder's device-test
// path) it is undefined — and because this line runs at module top level, the
// throw killed the ENTIRE app.js import graph: page rendered, every button
// dead. A session id needs uniqueness, not cryptography.
const sessionId = typeof crypto?.randomUUID === 'function'
  ? crypto.randomUUID()
  : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * Track a custom event via Vercel Web Analytics.
 * @param {string} name - Event name (max 255 chars)
 * @param {Record<string, string|number|boolean|null>} [data] - Custom data (no nested objects)
 */
export function track(name, data = {}) {
  // WHY Sentry breadcrumb first: even if Vercel Analytics is blocked (ad
  // blockers) or fails to load, we still get the breadcrumb attached to any
  // crash that follows. JAVASCRIPT-4 would have told us "user did X then Y
  // then crashed" instead of just "user tapped canvas then crashed".
  // Safe to call when SDK not loaded — guard the global.
  if (typeof window.Sentry?.addBreadcrumb === 'function') {
    window.Sentry.addBreadcrumb({
      category: 'app.action',
      type: 'user',
      level: 'info',
      message: name,
      data,
    });
  }

  // WHY guard: va() only exists when Vercel Analytics script is loaded.
  // In local dev (npx serve), it won't exist — fail silently.
  if (typeof window.va !== 'function') return;

  window.va('event', {
    name,
    data: { ...data, session: sessionId }
  });

  // WHY: Send same events to GA4 so we can compare dashboards.
  // gtag() exists when Google tag script is loaded (not in local dev).
  if (typeof window.gtag === 'function') {
    window.gtag('event', name, data);
  }

  // MIXPANEL — fourth sink, added 2026-09-10 for the one-month session-replay
  // UX study (seat decisions.md 2026-09-10). Init + config live in index.html's
  // head; this line is the whole wire.
  //
  // WHY THE GUARD IS `typeof ... === 'function'` AND NOT A TRUTHINESS CHECK: the
  // official loader snippet sets `window.mixpanel` to an ARRAY before the CDN
  // bundle lands, and stubs .track onto it so early calls queue instead of being
  // lost. An array is truthy; only the function check is honest about both
  // states, and both states are correct to call.
  //
  // WHY `data` GOES STRAIGHT THROUGH: every call site in this repo passes fixed
  // vocabulary (tool names, action names, enum-ish outcomes). That is a standing
  // invariant, not an accident. ⛔ A FILENAME, A PAGE OF DOCUMENT TEXT, OR
  // ANYTHING THE USER TYPED MAY NEVER BE PUT IN `data` — this function fans out
  // to three third parties and one of them now records sessions.
  //
  // NOT the Neon rail. That is tel() in js/v2/telemetry.js, a separate module
  // with its own schema validator; the two are never dual-written. Do not merge
  // them to "simplify".
  if (typeof window.mixpanel?.track === 'function') {
    try {
      window.mixpanel.track(name, { ...data, session: sessionId });
    } catch {
      // Analytics may never throw into app code (same law as tel()).
    }
  }
}
