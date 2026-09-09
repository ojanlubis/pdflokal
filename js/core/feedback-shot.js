/*
 * PDFLokal — core/feedback-shot.js  (the PASTED screenshot on general feedback)
 * ============================================================================
 * Pure validation for the one image a user may attach to the general feedback
 * form by PASTING it. No DOM, no canvas, no vendor — the browser half (decode,
 * downscale, encode) lives in js/v2/feedback-form.js, same core/adapter split
 * as everywhere else here.
 *
 * ⚠️ WHY THIS IS NOT core/feedback-sample.js, and it must not be merged into it.
 * That module validates the edit-beta's BEFORE/AFTER crop pair: a matched pair,
 * PNG only, 40KB each, produced by our own code from a line the user edited.
 * This is one JPEG the user chose, of whatever they chose, at a size we
 * re-encode. Two different objects with two different invariants. Merging them
 * would mean one validator whose rules are the union of both — which is another
 * way of saying neither is enforced. feedback-form.js's own header already
 * refuses to share a state machine with edit-feedback.js for the same reason.
 *
 * ⚠️ AND WHY IT IS THE USER'S CHOICE, EVERY TIME. The product's claim is that a
 * document never leaves the device. A pasted screenshot is the one exception,
 * and it is only defensible because the user performs it deliberately: there is
 * no upload button, no "attach the current page" convenience, and nothing here
 * ever reaches into the editor for pixels. If a future change makes an image
 * arrive without an explicit paste, this file's reason for existing is gone.
 *
 * JPEG, not PNG: a screenshot is a photograph of a screen, and PNG of one is
 * several megabytes. The crop pair upstream is PNG because it is small, flat,
 * and its pixels are compared.
 */

export const SHOT_DATA_URL_PREFIX = 'data:image/jpeg;base64,';

// The long edge we re-encode to. A screenshot is read, not inspected — 1000px
// is enough to see which control is wrong and cheap enough to store.
export const SHOT_MAX_DIM = 1000;

// Decoded ceiling for the stored image. Deliberately generous next to the crop
// pair's 40KB (a full screen carries far more than one edited line) and still
// bounded, because these rows sit in the same Neon free tier the rail does.
export const SHOT_MAX_BYTES = 200 * 1024;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// Decoded byte length of a `data:image/jpeg;base64,...` payload, without
// allocating it. Returns Infinity for anything malformed, so every caller's
// size comparison fails closed rather than passing on a NaN.
export function shotBytes(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(SHOT_DATA_URL_PREFIX)) return Infinity;
  const b64 = dataUrl.slice(SHOT_DATA_URL_PREFIX.length);
  if (b64.length === 0 || b64.length % 4 !== 0 || !BASE64_RE.test(b64)) return Infinity;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

/**
 * The single gate a screenshot passes before it can be sent or stored.
 * Returns the data URL unchanged, or null — never a repaired value. A caller
 * that gets null drops the image and sends the rating and note alone, exactly
 * as a feedback with no screenshot has always behaved.
 *
 * @param {string|null|undefined} dataUrl
 * @returns {string|null}
 */
export function validateShot(dataUrl) {
  const bytes = shotBytes(dataUrl);
  if (!(bytes > 0) || bytes > SHOT_MAX_BYTES) return null;
  return dataUrl;
}
