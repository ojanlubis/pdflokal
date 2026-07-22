/*
 * PDFLokal — core/telemetry-schema.js  (TELEMETRY SSOT — spec-telemetry.md §2/§3)
 * ============================================================================
 * The machine→human boundary law, applied machine→database (spec §2): an LLM
 * (or any code) fills a free field with anything; the boundary may not BE a
 * free field. SCHEMA is the ONE place that decides what a telemetry event IS.
 * Imported VERBATIM by both js/v2/telemetry.js (client) and api/t.js (the
 * endpoint) — client and server can never disagree about what's allowed.
 * NO string-typed prop exists anywhere in this file: every value is an enum,
 * a bool, a pre-bucketed int, or a clamped/rounded duration.
 *
 * Type descriptors (the value each SCHEMA[event][prop] entry may hold):
 *   - Array<string>  → enum: the prop value must be exactly one of these.
 *   - 'bool'         → boolean.
 *   - 'int'          → finite, non-negative INTEGER — for a value that is
 *                       already bucketed/counted upstream, never a raw
 *                       unbounded magnitude. (No v1 event uses this yet; kept
 *                       for schema completeness per spec §2's type list.)
 *   - 'duration'     → finite integer ms, 0 <= v <= 600000, a multiple of 10.
 *                       Callers should always produce this via
 *                       durationBucket() below rather than hand-rolling a
 *                       number — that's what guarantees the invariant holds
 *                       by the time validateEvent() sees it.
 *
 * Adding a new event = one SCHEMA entry (+ a call site once the code path
 * exists). The ladder events (font_seen, ganti_tap, ganti_commit, surgery,
 * insert, block_edit, commit_paint) are listed here for completeness NOW
 * (spec §6 step 5) even though their call sites land later, on the ladder
 * branch, as those code paths stabilize. Their enum values were checked
 * against the actual ladder code on feat/edit-teks-asli where it already
 * exists (reinsert.js's decline reasons, text-walk.js's match/decline paths,
 * text-blocks.js's align classifier) — see the telemetry PR notes for the
 * one enum that's a best-effort naming (surgery.reason) rather than a
 * verbatim existing constant, since the match step itself has no named
 * reason in the code today, only a matched:boolean.
 */

// ---- shared enum/bucket vocab (reused by more than one event) -----------------
const PAGES_BUCKET = ['1', '2-5', '6-20', '21+'];
const DEVICE = ['phone', 'tablet', 'desktop'];

const DURATION_MAX_MS = 600000;
const DURATION_STEP_MS = 10;

// n (a page count) → the spec's bucket string. Defensive on garbage input
// (NaN, negative, undefined) — collapses to the smallest bucket rather than
// producing an off-schema value that validateEvent would then have to reject.
export function pagesBucket(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 1) return '1';
  if (v <= 5) return '2-5';
  if (v <= 20) return '6-20';
  return '21+';
}

// ms (a raw duration) → clamped to [0, 600000] and rounded to the nearest
// 10ms (spec §2). This is the ONLY place a 'duration' value should be
// produced — validateEvent then just has to check the invariant holds.
export function durationBucket(ms) {
  // NaN (incl. anything that doesn't coerce to a number, e.g. undefined)
  // can't be reasoned about as "too big" or "too small" — floor it. A real
  // Infinity (or any other out-of-range number) DOES have a direction, so
  // Math.max/min below clamp it to the correct end instead.
  const num = Number(ms);
  const v = Number.isNaN(num) ? 0 : num;
  const clamped = Math.min(DURATION_MAX_MS, Math.max(0, v));
  return Math.round(clamped / DURATION_STEP_MS) * DURATION_STEP_MS;
}

// ---- SCHEMA -------------------------------------------------------------------
export const SCHEMA = {
  // ---- live today (js/v2/app.js, js/v2/download-sheet.js) ----
  doc_open: {
    text_layer: 'bool',
    pages: PAGES_BUCKET,
    device: DEVICE,
  },
  // tool: the v2 toolbar's own verbs (Pilih/Teks/Tip-Ex/TTD/Hapus/Halaman) —
  // 'ganti' (Rung B's smart-replace tool) is listed now for schema
  // completeness even though it doesn't exist as a toolbar entry until the
  // ladder merges (same forward-looking stance as the ladder events below).
  // action: the specific thing that happened — deliberately finer than
  // "which tool" so e.g. "pressed Halaman" (discoverability — nothing told
  // us this before, see app.js's armIntent() note) is distinguishable from
  // a committed edit.
  tool_use: {
    tool: ['select', 'teks', 'tipex', 'ganti', 'ttd', 'hapus', 'halaman'],
    action: ['select', 'whiteout', 'text', 'text_inline', 'signature', 'paraf', 'delete', 'pages_open'],
  },
  export: {
    // surgery_used/fallback are always false/'none' from call sites on this
    // branch (Rung B/C don't exist here yet) — the props still ship now so
    // the ladder branch only has to start SENDING true values, never add a
    // new prop (spec §6 step 5: "the ladder props land later").
    surgery_used: 'bool',
    fallback: ['none', 'cover', 'twin'],
    duration: 'duration',
  },

  // ---- ladder (Rung A–D) — schema-complete now, call sites land on the ladder branch ----

  // flavor mirrors spec §2's FLAVOR list exactly (never the font's own name).
  font_seen: {
    flavor: ['type0-identity-h', 'truetype-simple', 'type1', 'standard14', 'other'],
    extract: ['ok', 'declined', 'failed'],
  },
  ganti_tap: {
    hit: 'bool',
  },
  ganti_commit: {
    outcome: ['commit', 'cancel', 'noop'],
    font_path: ['doc-font', 'twin'],
  },
  // matched/reason describe ONLY the Rung B match/cut step (text-walk.js's
  // planRunRemoval): a target is either matched cleanly, has NO geometric
  // candidate at all ('no-match'), or sits in a text object the walk marked
  // untrustworthy and declined out of caution ('untrustworthy-run' — the
  // literal word the code uses at the decline site).
  surgery: {
    matched: 'bool',
    reason: ['clean', 'no-match', 'untrustworthy-run'],
  },
  // path/reason describe the Rung C STAMP step (core/stamp.js, rebuilt
  // 2026-07-22 per spec-edit-rebuild-composite.md — Path B, founder-ruled):
  // 'native' now means the replacement was STAMPED (pdf-lib's own
  // drawText+embedFont) in the document's OWN embedded font program —
  // previously it meant a hand-rolled content-stream snippet reusing the
  // doc's font RESOURCE; the pixels-are-the-document's guarantee is the
  // same, the mechanism that produces them changed. 'clone' is new: the
  // doc's own font declined but font-decide.js's /BaseFont routing found a
  // bundled Croscore/crosextra metric-twin that covers the text, stamped
  // instead — metrically exact, not pixel-identical (spec §6). 'twin' is
  // unchanged: both rungs declined, export fell back to the metric-twin
  // ANNOTATION. reason enumerates stamp.js's own named decline reasons
  // verbatim (reused from reinsert.js's vocabulary wherever the shape is the
  // same — decline-never-guess extends to never inventing a new enum value
  // when an old one already means this), plus 'clean' for a resolved stamp.
  // 'clone-unavailable' is the one genuinely NEW reason: no clone route for
  // this /BaseFont, or the clone rung's own fetch/embed/headless guard
  // declined.
  insert: {
    path: ['native', 'clone', 'twin'],
    // Pruned 2026-07-22 (spec-edit-rebuild-composite.md increment 2):
    // 'font-parse-failed' and 'font-name-unwritable' were reinsert.js-only
    // decline reasons (its hand-rolled snippet builder) — verified dead by
    // grepping js/ for both strings post-deletion; core/stamp.js's ladder
    // never emits either (a parse throw collapses to 'unsupported-font', and
    // pdf-lib's own embedFont needs no PDF-name escaping at all).
    reason: [
      'clean', 'unsupported-font', 'mixed-fonts', 'multiline', 'empty',
      'missing-glyph', 'clone-unavailable',
    ],
  },
  // reason/align values are given verbatim in spec-telemetry.md §3's own
  // table (reason) and text-blocks.js's classifyAlign() (align).
  block_edit: {
    editable: 'bool',
    reason: ['single-line', 'align-unknown', 'mixed-fonts', 'list'],
    align: ['left', 'right', 'center', 'justify', 'unknown'],
  },
  commit_paint: {
    duration: 'duration',
    pages: PAGES_BUCKET,
    device: DEVICE,
  },
};

function validateProp(descriptor, value) {
  if (Array.isArray(descriptor)) return typeof value === 'string' && descriptor.includes(value);
  if (descriptor === 'bool') return typeof value === 'boolean';
  if (descriptor === 'int') return Number.isInteger(value) && value >= 0;
  if (descriptor === 'duration') {
    return Number.isInteger(value) && value >= 0 && value <= DURATION_MAX_MS && value % DURATION_STEP_MS === 0;
  }
  // An unrecognised descriptor is a bug IN this file, not a caller mistake —
  // fail closed rather than silently accept anything.
  return false;
}

// Pure, no I/O. {ok:true, clean} | {ok:false}. Strict on every axis the spec
// calls out: unknown event, unknown prop, missing required prop, enum value
// outside the list, and wrong type all fail the WHOLE event (never a partial
// pass) — a bad call site should be loud, not silently half-recorded.
export function validateEvent(name, props) {
  const shape = SCHEMA[name];
  if (!shape) return { ok: false };

  const src = props && typeof props === 'object' && !Array.isArray(props) ? props : {};
  const declaredKeys = Object.keys(shape);

  for (const key of Object.keys(src)) {
    if (!(key in shape)) return { ok: false }; // unknown prop
  }

  const clean = {};
  for (const key of declaredKeys) {
    if (!(key in src)) return { ok: false }; // missing a required prop
    if (!validateProp(shape[key], src[key])) return { ok: false }; // wrong type / bad enum
    clean[key] = src[key];
  }
  return { ok: true, clean };
}
