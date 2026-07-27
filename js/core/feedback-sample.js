/*
 * PDFLokal — core/feedback-sample.js  (Increment D — consent-gated sample,
 * spec-edit-fidelity-instrumentation.md)
 * ============================================================================
 * Pure, DOM-free validation for the two opt-in crop data URLs the beta Edit
 * feedback pill may carry: a small "before" (pristine) and "after" (stamped)
 * PNG of the ONE edited line's own box, sent ONLY when the user taps 👎 then
 * Kirim (decisions.md 2026-07-23/2026-07-27 — no automatic upload of document
 * content or renders, ever).
 *
 * Zero vendor/DOM imports (same discipline as core/visual-oracle.js) — string
 * arithmetic only, so this is trivially testable headlessly (test:core) and
 * importable from js/v2/telemetry.js (client, browser) unchanged.
 *
 * api/feedback.js (server, Vercel edge function) does NOT import this file —
 * it mirrors the same constants/regex inline instead, for the same reason its
 * own readBody() is duplicated rather than shared (that file's own header
 * comment: stays a single self-contained edge function, no cross-import).
 * Keep the two definitions in sync by hand if the caps ever change.
 */

export const SAMPLE_DATA_URL_PREFIX = 'data:image/png;base64,';
export const SAMPLE_MAX_BYTES = 40 * 1024;       // per crop (before OR after)
// Deliberately LESS than 2x SAMPLE_MAX_BYTES — a real, independent second
// gate rather than a restatement of the per-crop one. Two crops each sitting
// comfortably under the per-crop cap can still combine into a payload not
// worth sending; this is what actually catches that case.
export const SAMPLE_TOTAL_MAX_BYTES = 70 * 1024; // before + after combined

const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

// Decoded byte length of a `data:image/png;base64,...` string's payload,
// without allocating a Buffer/atob — string arithmetic only. Returns
// Infinity (never throws, never NaN) for anything that isn't a plausible PNG
// data URL, so a caller can always compare it against a cap with `>`.
export function dataUrlBytes(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(SAMPLE_DATA_URL_PREFIX)) return Infinity;
  const b64 = dataUrl.slice(SAMPLE_DATA_URL_PREFIX.length);
  if (b64.length === 0 || b64.length % 4 !== 0 || !BASE64_RE.test(b64)) return Infinity;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

/**
 * Validates a `{before, after}` pair against the shape + byte caps above.
 * Returns the pair unchanged when valid, or `null` when ANYTHING is off —
 * wrong/missing prefix, malformed base64, either crop over SAMPLE_MAX_BYTES,
 * the combined size over SAMPLE_TOTAL_MAX_BYTES, or a partial pair (one
 * present without the other). Callers drop the WHOLE sample on `null`, never
 * send/store half of it — the same "drop it all rather than trust a
 * partial" discipline as every other decline in this feature.
 * @param {{before?: string, after?: string}|null|undefined} sample
 * @returns {{before: string, after: string}|null}
 */
export function validateSample(sample) {
  if (!sample || typeof sample !== 'object') return null;
  const { before, after } = sample;
  if (typeof before !== 'string' || typeof after !== 'string') return null;
  const b = dataUrlBytes(before);
  const a = dataUrlBytes(after);
  if (!Number.isFinite(b) || !Number.isFinite(a)) return null;
  if (b > SAMPLE_MAX_BYTES || a > SAMPLE_MAX_BYTES) return null;
  if (b + a > SAMPLE_TOTAL_MAX_BYTES) return null;
  return { before, after };
}
