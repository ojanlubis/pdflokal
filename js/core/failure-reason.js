/*
 * PDFLokal — core/failure-reason.js  (WHY DID IT FAIL, IN ONE BUCKETED WORD)
 * ============================================================================
 * SINGLE SOURCE OF TRUTH for turning a thrown error into the `failure.reason`
 * enum. Used by the import path (js/v2/app.js) and the export path
 * (js/v2/download-sheet.js).
 *
 * ⚠️ CONTENT-BLINDNESS, READ BEFORE EDITING. This function READS err.message.
 * The message NEVER leaves the device — only the returned bucket
 * (encrypted | corrupt | out-of-memory | unsupported | timeout | unknown) is
 * put on the rail. That distinction is the whole design: an error string can
 * quote document text or a file name, so it must be matched here and discarded
 * here. If you ever find yourself passing `err.message` to tel(), stop.
 *
 * WHY MESSAGE MATCHING AT ALL, when `err.name` is so much cleaner: because the
 * two libraries throw in completely different styles, and we need both.
 *
 *   PDF.js  (IMPORT)  throws NAMED classes — PasswordException,
 *                     InvalidPDFException, UnknownErrorException. err.name
 *                     alone is enough, and that is what this used to read.
 *   pdf-lib (EXPORT)  throws PLAIN `new Error(...)` for EVERYTHING. Measured
 *                     2026-07-28 against the vendored build: a truncated file
 *                     and an encrypted file both arrive as `err.name ===
 *                     'Error'`. There is no name to switch on.
 *
 * That asymmetry is why 41 real export failures on 2026-07-28 all reported
 * `unknown`: the export path hard-coded the literal (download-sheet.js), and
 * even wiring the old name-only classifier in would have changed nothing,
 * because every pdf-lib error has the same name. A classifier that cannot
 * distinguish anything is decoration — it just makes the rail look answered.
 *
 * The patterns are pinned by tests/core/failure-reason.test.mjs, which
 * GENERATES REAL pdf-lib errors rather than hardcoding their strings. If a
 * vendored pdf-lib upgrade changes its wording, that test goes RED instead of
 * this silently degrading back to 'unknown' for everything.
 */

// pdf-lib's own words, matched narrowly. Ordered: encryption is checked before
// corruption because an encrypted file ALSO fails to parse, and the more
// specific answer is the useful one.
const PDFLIB_ENCRYPTED = /is encrypted/i;
const PDFLIB_CORRUPT = /failed to parse|invalid object|no pdf header|expected instance of|invalid pdf|trailer/i;
// V8's allocation failures. `Invalid string length` is the hard max-string
// ceiling; `Array buffer allocation failed` is the ArrayBuffer one. Both arrive
// as RangeError, which is ALSO what a stack overflow uses — hence the explicit
// call-stack exclusion below rather than a blanket RangeError rule.
// `Invalid typed array length` is V8 refusing a Uint8Array the heap cannot
// hold — pdf-lib's save() and canvas toBlob() both ask for one; added
// 2026-09-06. Distinct from `Invalid array length` (a plain bad length, kept
// UNKNOWN below on purpose) by the word 'typed'.
const ALLOC = /invalid string length|array buffer allocation failed|out of memory|allocation size overflow|invalid typed array length/i;
const STACK = /call stack/i;

export function failureReason(err) {
  // 1. PDF.js named exceptions — unambiguous, no message needed.
  switch (err?.name) {
    case 'PasswordException': return 'encrypted';
    case 'InvalidPDFException': return 'corrupt';
    case 'UnknownErrorException': return 'unsupported';
    case 'TimeoutError': return 'timeout';
    case 'QuotaExceededError': return 'out-of-memory';
    case 'AbortError': return 'timeout';
    // The browser's image decoder refusing a file (2026-09-06). createImageBitmap
    // rejects with a DOMException — InvalidStateError in Chromium, EncodingError
    // in Firefox/WebKit — for a format it cannot decode (HEIC on most Androids,
    // a truncated JPEG) or an image too large to decode. Read `unknown` until
    // now, which is where 15 sessions in 14 days sat, half of them phones that
    // arrived with `intent: foto`. NotSupportedError is the same family from
    // other media APIs. A file we cannot decode is UNSUPPORTED, in the same
    // sense as a character we cannot paint.
    case 'InvalidStateError': return 'unsupported';
    case 'EncodingError': return 'unsupported';
    case 'NotSupportedError': return 'unsupported';
    default: break;
  }

  const msg = typeof err?.message === 'string' ? err.message : '';

  // 2. Allocation ceilings, whatever threw them. MESSAGE-DRIVEN ONLY — the
  // first draft of this mapped EVERY RangeError to out-of-memory, and
  // tests/telemetry-content-blind.spec.js caught it: `RangeError` is also what
  // you get for a bad array length, a bad radix, and a dozen unrelated things.
  // Bucketing those as out-of-memory would INVENT a cause, which is the same
  // defect as the hard-coded 'unknown' this module exists to fix — just harder
  // to notice, because a confident wrong answer reads like a real one.
  if (ALLOC.test(msg)) return 'out-of-memory';
  // A blown stack is a code-shape problem (deep recursion on a hostile
  // document), not a memory ceiling — calling it out-of-memory would send us
  // hunting the wrong thing.
  if (err?.name === 'RangeError' && STACK.test(msg)) return 'unsupported';

  // 3. pdf-lib's plain Errors, distinguished only by their words.
  // A character no font we ship can paint (emoji, CJK) in a standard font.
  // core/text-encode.js normalises the invisible LOOKALIKES that caused the
  // 2026-07-28 incident; what is left is genuinely unrenderable, and saying so
  // is how we find out whether it ever actually happens to anyone.
  if (/cannot encode/i.test(msg)) return 'unsupported';
  if (PDFLIB_ENCRYPTED.test(msg)) return 'encrypted';
  if (PDFLIB_CORRUPT.test(msg)) return 'corrupt';

  return 'unknown';
}

// ---- failureCause: WHAT KIND of thing threw, still content-blind ---------------
//
// WHY A SECOND FUNCTION (2026-09-06): `reason` answers "which of our six
// product buckets", and for the majority of real failures the honest answer is
// 'unknown' — 218 events across 65 sessions by 2026-08-31, more than every named
// reason together. That is a blind spot, not a defect list. This adds the two
// facts a developer would read first off a stack trace, each collapsed to an
// enum: the error's constructor NAME, and a HINT derived from which family of
// words its message uses. Both are enums declared in core/telemetry-schema.js
// (failure_cause) and validated there; nothing here can return anything else.
//
// CONTENT-BLIND, same law as failureReason above: the message is matched HERE
// and discarded HERE. A hint pattern is a family of library wording, never a
// capture — no group of the regex is ever returned. If a pattern ever needs a
// captured value, the design is wrong; add an enum member instead.
//
// It rides as its OWN event (failure_cause), not as new props on `failure`:
// validateEvent rejects a missing prop, and the server runs the same module,
// so widening `failure` would drop every failure event from a client on a
// stale cached build until it refreshed. A separate additive event blanks
// nothing.

const CAUSE_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError',
  'InvalidStateError', 'EncodingError', 'NotSupportedError', 'SecurityError',
  'QuotaExceededError', 'AbortError', 'NetworkError', 'DataCloneError',
]);

// First match wins; ordered from the most specific family to the broadest.
const HINTS = [
  ['encode', /cannot encode|winansi/i],
  ['glyph', /glyph|cmap|no font|font.*not (?:found|loaded)|fontkit/i],
  ['alloc', /invalid string length|array buffer allocation|out of memory|allocation size overflow|invalid typed array length|memory/i],
  ['stack', /call stack/i],
  ['encrypted', /is encrypted|password/i],
  ['parse', /failed to parse|invalid object|no pdf header|expected instance of|invalid pdf|trailer|xref|unexpected (?:token|end)/i],
  ['image', /image|bitmap|decode|jpeg|jpg|png|canvas|toblob|drawimage/i],
  ['undefined-prop', /cannot read propert|cannot set propert|undefined is not|null is not|is not a function|is not iterable|is not defined|is not an object/i],
  ['worker', /worker|wasm|webassembly|tesseract|pdf\.js|pdfjs/i],
  ['fetch', /fetch|network|failed to load|load failed|http \d|net::/i],
  ['timeout', /timeout|timed out|aborted/i],
];

export function failureCause(err) {
  const rawName = typeof err?.name === 'string' ? err.name : '';
  let name = 'none';
  if (err !== null && err !== undefined) name = CAUSE_NAMES.has(rawName) ? rawName : 'other';
  const msg = typeof err?.message === 'string' ? err.message : '';
  let hint = 'none';
  for (const [label, re] of HINTS) {
    if (re.test(msg)) { hint = label; break; }
  }
  return { name, hint };
}
