/*
 * PDFLokal - lib/analytics.js (ES Module)
 * Lightweight analytics wrapper around Vercel Web Analytics va() function.
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
const sessionId = crypto.randomUUID();

/**
 * Track a custom event via Vercel Web Analytics.
 * @param {string} name - Event name (max 255 chars)
 * @param {Record<string, string|number|boolean|null>} [data] - Custom data (no nested objects)
 */
export function track(name, data = {}) {
  // WHY guard: va() only exists when Vercel Analytics script is loaded.
  // In local dev (npx serve), it won't exist — fail silently.
  if (typeof window.va !== 'function') return;

  window.va('event', {
    name,
    data: { ...data, session: sessionId }
  });
}
