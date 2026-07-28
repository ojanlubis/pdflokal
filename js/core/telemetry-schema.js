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
// spec-edit-fidelity-instrumentation.md Increment A/B: which rung of the
// style/family ladder (core/font-fingerprint.js) decided bold/italic.
// NOTE: the spec's own prose lists a 'geometry' member too — this builder
// deliberately did NOT build rung 3 (geometry/stem-width measurement): Step
// 0's empirical dump of org-structure.pdf proved rung 2 (program-name/os2/
// panose) answers the founder's own defect four redundant ways, and shipping
// an outline-scanning heuristic with no defect it would additionally fix and
// no fixture to validate it against would be exactly the coin-flip
// measurement the honesty contract forbids. 'geometry' is omitted from the
// enum per the schema's own law ("anything not emitted by code does not
// enter an enum") — add it back the day a rung 3 actually ships.
const STYLE_SOURCE = ['pdf-name', 'pdf-flags', 'program-name', 'os2', 'panose', 'none'];

// spec-edit-fidelity-instrumentation.md Increment C: shared 5-bucket vocab
// for a stamped-region ÷ pristine-region ratio (core/visual-oracle.js emits
// the raw floats; bucketing happens HERE, same division of labor as every
// other event — a pure module computes, the schema decides what's speakable).
// Cuts (0.6 / 0.8 / 1.3 / 1.6) were chosen empirically against the builder's
// Step 0 validation on org-structure.pdf's "T & PPGA" box: a correct BOLD
// stamp's weight-ratio (0.884 vs the real pristine glyphs) and a forced-THIN
// stamp's (0.689) land in DIFFERENT buckets ('near-parity' vs 'lower') with
// real margin either side of the 0.8 cut, while two near-identical
// same-weight renders (bold vs thin height ratios, 1.254 vs 1.246 — pure
// rasterization/content noise, not a real size defect) land in the SAME
// 'near-parity' bucket rather than splitting across a cut by a hair.
const RATIO_BUCKET = ['much-lower', 'lower', 'near-parity', 'higher', 'much-higher'];

// The declared job the user arrived with — from ?buat=, a landing card, or a
// /gabung-pdf-style page's <body data-intent>. Mirrors INTENT_COPY's keys in
// js/v2/intent-copy.js exactly, plus 'none' for "arrived with nothing
// declared" (the bare homepage). This is the ONE "what did they come to do"
// enum — keep it in lockstep with INTENT_COPY. Content-blind: a job label,
// never a filename. (This signal used to live ONLY in GA4's file_loaded;
// bringing it here is what lets the first-party rail answer intent on its own.)
const INTENT = ['gabung', 'split', 'halaman', 'kompres', 'ttd', 'paraf', 'teks', 'tipex', 'gambar', 'foto', 'none'];

// The Unduh-sheet choices (the REALIZED job — mirror of GA4's download event):
//   format:      pdf, or an image export (png/jpg)
//   size:        asli/kompres for a PDF · asli/sedang/kecil for image dimensions
//   pages_scope: whole doc, or a picked subset (= an extract / split)
const EXPORT_FORMAT = ['pdf', 'png', 'jpg'];
const EXPORT_SIZE = ['asli', 'kompres', 'sedang', 'kecil'];
const PAGES_SCOPE = ['all', 'some'];

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

// raw intent (a real INTENT key, null, or user-controlled ?buat= garbage) → a
// valid enum value. Anything off-list or missing collapses to 'none' — the
// same defensive stance as pagesBucket, and here it MATTERS: ?buat= is
// attacker/typo-controllable, and letting a bad value through would fail the
// WHOLE doc_open event, silently losing its text_layer/device/pages too.
export function intentValue(raw) {
  return INTENT.includes(raw) ? raw : 'none';
}

// spec-edit-fidelity-instrumentation.md Increment B: `insert.glyph_shortfall`
// is the FIRST real user of the 'int' type descriptor (kept "for schema
// completeness" since spec-telemetry.md — this is that follow-up). A raw
// count is exactly the kind of "already bucketed/counted upstream, never a
// raw unbounded magnitude" value 'int' exists for, so this just clamps the
// (already-small, per-edit) count to a sane cap rather than letting a
// pathological huge paste balloon the value unboundedly.
const GLYPH_SHORTFALL_CAP = 20;
export function glyphShortfallBucket(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(GLYPH_SHORTFALL_CAP, Math.round(v));
}

// A stamped÷pristine ratio (core/visual-oracle.js's weightRatio/heightRatio)
// -> RATIO_BUCKET. Defensive on garbage (NaN, negative, Infinity from a
// divide-by-near-zero) — collapses to the extreme bucket its direction
// implies rather than producing an off-schema value validateEvent would then
// have to reject; a non-finite ratio still carries directional signal
// (Infinity means the stamped region has ink where pristine had ~none).
export function ratioBucket(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return n === Infinity ? 'much-higher' : 'much-lower';
  if (n < 0.6) return 'much-lower';
  if (n < 0.8) return 'lower';
  if (n < 1.3) return 'near-parity';
  if (n < 1.6) return 'higher';
  return 'much-higher';
}

// A stamped÷pristine RAW INK-PIXEL-COUNT ratio (core/visual-oracle.js's
// compareRegions().inkRatio) -> its OWN 5-bucket vocabulary. Added 2026-07-28
// after a real production miss: a REPLACE that failed to cut the original
// text (founder-consented crops, "Pondok Sapi," duplicated instead of
// replaced by ", Cibeber") measured weightRatio 1.28998 — 0.010015 under
// ratioBucket's own 1.3 cut, so it bucketed 'near-parity' and the oracle
// reported a clean bill of health on a defect that had added an entire extra
// phrase to the page. heightRatio read exactly 1.0 (same baseline, same font
// size — duplicated text on one line changes WIDTH, never height; see
// visual-oracle.js's header for why that is a permanent blind spot, not a
// bug to fix). weightRatio itself was diluted: the line ends in a dashed
// leader that pins the ink's own bbox to the SAME ~524px width in both
// crops, so the whole extra phrase moved density only 29% even though raw
// inkCount jumped 669 -> 863 (also +29%, not a coincidence — see below).
//
// inkRatio exists as its own field (not a retune of weightRatio) because the
// two can diverge in VALUE, not just in bucket boundaries: weightRatio is
// ink ÷ ITS OWN bbox, so a real ink increase can hide near 1.0 whenever the
// bbox grows in step with it (a duplicated phrase that also widens its own
// bounding box, no furniture pinning it down) — density stays flat while the
// page gains real, wrong ink. inkRatio has no bbox term to fool: it is
// stamped inkCount ÷ pristine inkCount, full stop. (In THIS specific
// incident the two floats come out numerically IDENTICAL — 863/669 either
// way — because the leader pins both crops' bboxes to the same area, which
// makes weightRatio degenerate into inkRatio algebraically; what actually
// catches this defect is the TIGHTER cut points below, not a different
// number. The general case, where the two renders' bboxes differ, is why
// inkRatio still earns its own field rather than being folded into
// weightRatio's math.)
//
// A REPLACE cannot legitimately end up with substantially MORE ink than it
// started with: the box a replacement stamps into (replaceBox) is sized to
// the ORIGINAL text, so a genuinely longer replacement either overflows that
// box (caught separately by the `overflow` bool) or gets shrunk to fit. A
// large ink INCREASE with no overflow is close to proof the cut half of the
// edit silently failed and the original glyphs are still underneath the new
// ones.
//
// Deliberately NOT reusing ratioBucket()'s cuts (0.6/0.8/1.3/1.6) — that
// band was tuned for STROKE WEIGHT (thin-vs-bold), a metric where ordinary
// rasterization/AA noise between two CORRECT renders can legitimately move
// the ratio 20-30% either side of 1.0 (this file's own ACCEPTANCE test: a
// correct BOLD stamp reads 0.884, not 1.0). inkRatio has no such noise floor
// to protect — it's a plain pixel count — and the one real incident this
// bucket exists for sits at 1.28998. Reusing ratioBucket's 1.3 cut here
// would ship the EXACT bug this fix is for. Cuts: 0.7 / 0.9 / 1.1 / 1.3 — a
// tighter ±10% 'near-parity' band (width 0.2) vs ratioBucket's [0.8,1.3)
// (width 0.5), so 1.28998 lands in 'higher': one bucket short of
// 'much-higher', but never mistakeable for a clean bill of health again.
//
// The RETURNED STRINGS deliberately reuse RATIO_BUCKET's five labels (same
// vocabulary reads the same way on a dashboard regardless of which prop it's
// on) — only the CUTS differ. That is a distinct decision from reusing
// ratioBucket() ITSELF, which this function does not do.
export function inkRatioBucket(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return n === Infinity ? 'much-higher' : 'much-lower';
  if (n < 0.7) return 'much-lower';
  if (n < 0.9) return 'lower';
  if (n < 1.1) return 'near-parity';
  if (n < 1.3) return 'higher';
  return 'much-higher';
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
    intent: INTENT,
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
    tool: ['select', 'teks', 'tipex', 'ganti', 'ttd', 'hapus', 'halaman', 'gabung'],
    action: ['select', 'whiteout', 'text', 'text_inline', 'signature', 'paraf', 'delete', 'pages_open', 'merge'],
  },
  export: {
    // surgery_used/fallback are always false/'none' from call sites on this
    // branch (Rung B/C don't exist here yet) — the props still ship now so
    // the ladder branch only has to start SENDING true values, never add a
    // new prop (spec §6 step 5: "the ladder props land later").
    surgery_used: 'bool',
    fallback: ['none', 'cover', 'twin'],
    duration: 'duration',
    // The user's Unduh-sheet choices — the mirror of GA4's download event, the
    // signal the rail used to throw away. This is what lets a plain download,
    // a Kompres, a PDF→Gambar, and a page-extract be told apart. All three
    // enums come straight from download-sheet.js's own state.
    format: EXPORT_FORMAT,
    size: EXPORT_SIZE,
    pages_scope: PAGES_SCOPE,
  },

  // ---- ladder (Rung A–D) — schema-complete now, call sites land on the ladder branch ----

  // flavor mirrors spec §2's FLAVOR list exactly (never the font's own name).
  // embedded/subtype/name_informative/bold/style_source (Increment B, rides
  // with Increment A's ladder): the FONT FACTS behind why a Ganti replace did
  // or didn't get the doc's own font/weight — every field content-blind
  // (enums/bools), read off core/font-fingerprint.js's resolveFontFingerprint
  // + core/font-style.js's getFontStyleInfo, never the font's own NAME.
  font_seen: {
    flavor: ['type0-identity-h', 'truetype-simple', 'type1', 'standard14', 'other'],
    extract: ['ok', 'declined', 'failed'],
    embedded: 'bool',
    subtype: ['type0', 'truetype', 'type1', 'standard14', 'other'],
    name_informative: 'bool',
    bold: 'bool',
    style_source: STYLE_SOURCE,
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
    // style_source/glyph_shortfall (Increment B, core/stamp.js's
    // resolveStampFont): style_source names which ladder rung decided the
    // bold/italic the clone rung's weight-file pick used (echoed through,
    // never re-decided in stamp.js); glyph_shortfall is rung 1's OWN
    // diagnostic — how many chars the doc's own embedded subset lacked —
    // reported regardless of which rung ultimately supplied the font (0 when
    // rung 1 succeeded, or never got the chance to check at all).
    style_source: STYLE_SOURCE,
    glyph_shortfall: 'int',
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
  // spec-edit-fidelity-instrumentation.md Increment C: the visual oracle —
  // core/visual-oracle.js's compareRegions() on the edited line's own region,
  // pristine (the rebake's PREVIOUS raster) vs stamped (the raster it just
  // produced). A separate event from commit_paint (not new fields riding on
  // it): commit_paint fires unconditionally for every touched-edit commit,
  // rebake success or not, but the oracle needs a REAL prior raster AND a
  // successful new one to crop from — folding it into commit_paint would mean
  // either firing it with fabricated defaults on a decline, or leaving
  // commit_paint's own required props sometimes absent (the schema's own law
  // forbids optional props — see validateEvent's "missing a required prop"
  // check). A dedicated event fires only when there's a real comparison to
  // report, exactly the "declines rather than guesses" discipline every other
  // ladder event already follows.
  visual_oracle: {
    weight_ratio: RATIO_BUCKET,
    height_ratio: RATIO_BUCKET,
    overflow: 'bool',
    // ink_ratio (added 2026-07-28, the "Pondok Sapi"/"Cibeber" incident):
    // core/visual-oracle.js's compareRegions().inkRatio, bucketed by
    // inkRatioBucket() above — NOT ratioBucket(). Shares RATIO_BUCKET's five
    // string VALUES (same label vocabulary reads the same on a dashboard
    // regardless of which prop it's on) but a completely different, tighter
    // set of cut points — see inkRatioBucket's own header comment for the
    // incident numbers and why ratioBucket's cuts would have hidden this
    // exact defect again.
    ink_ratio: RATIO_BUCKET,
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
