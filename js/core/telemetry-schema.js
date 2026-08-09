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
 * insert, commit_paint) are listed here for completeness NOW
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

// WHICH KIND of character a standard font refused (failure.class, 2026-08-09).
// core/text-encode.js's own header already names the two populations that
// reach this decline — "an emoji, or CJK" — and the product answer is
// different for each: emoji means "offer a font that has them or accept the
// warn", CJK means an entire script we cannot serve at all. On the rail today
// they are one undifferentiated `reason: 'unsupported'`, so the count cannot
// tell "a few people put a 🙂 in a form" apart from "Chinese users cannot use
// the text tool".
//
// ⚠️ THREE VALUES AND A NEUTRAL, NEVER THE CHARACTER. The rail is string-free
// by design and that is the moat: a character IS document content (someone's
// name, a number, a symbol from their file), and one leaked codepoint is the
// same breach as a leaked string. unsupportedCharClass() below is the ONLY
// door — it takes a character and can return nothing but a member of this
// list, so no call site is in a position to pass text through even by mistake.
const UNSUPPORTED_CLASS = ['emoji', 'cjk', 'other', 'none'];

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

// CJK codepoint ranges — Han, the two kana, Hangul, and the CJK punctuation /
// fullwidth blocks that always travel with them. Deliberately generous at the
// block level rather than precise at the codepoint level: the question this
// answers is "is there a population we cannot serve at all", and a fullwidth
// comma pasted out of a Chinese document is evidence of exactly that.
const CJK_RANGES = [
  [0x1100, 0x11ff], // Hangul Jamo
  [0x2e80, 0x2eff], // CJK Radicals Supplement
  [0x3000, 0x303f], // CJK Symbols and Punctuation (、。「」 …)
  [0x3040, 0x30ff], // Hiragana + Katakana
  [0x3100, 0x312f], // Bopomofo
  [0x3130, 0x318f], // Hangul Compatibility Jamo
  [0x31f0, 0x31ff], // Katakana Phonetic Extensions
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7af], // Hangul Syllables
  [0xd7b0, 0xd7ff], // Hangul Jamo Extended-B
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe30, 0xfe4f], // CJK Compatibility Forms
  [0xff00, 0xffef], // Halfwidth and Fullwidth Forms
  [0x20000, 0x3ffff], // CJK Unified Ideographs Extensions B and beyond
];

// EMOJI / pictograph ranges. Not a Unicode property lookup (no Intl or regex
// property escapes needed, and no table to fall out of date): the blocks below
// are where every pictograph a user can type from a phone keyboard lives.
// U+FE0F (variation selector-16) is included because a keycap or a
// text-default pictograph arrives as BASE + FE0F, and a first-offender that
// happens to be the selector must still read 'emoji'.
const EMOJI_RANGES = [
  [0x2190, 0x21ff], // Arrows (⬅️➡️ bases)
  [0x2300, 0x23ff], // Miscellaneous Technical (⌚⏰⏳)
  [0x25a0, 0x25ff], // Geometric Shapes (▪️🔺 bases)
  [0x2600, 0x27bf], // Misc Symbols + Dingbats (☀️❤️✅✨)
  [0x2b00, 0x2bff], // Misc Symbols and Arrows (⭐⬛)
  [0xfe0f, 0xfe0f], // VARIATION SELECTOR-16 — the emoji-presentation marker
  [0x1f000, 0x1faff], // the emoji planes proper (🙂🎉🇮🇩🧑)
];

const inRanges = (cp, ranges) => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

// A single CHARACTER → one of UNSUPPORTED_CLASS. THE ONLY DOOR between a
// refused character and the rail (see UNSUPPORTED_CLASS's own warning above):
// it takes text and returns an enum, so the character itself structurally
// cannot travel. Anything falsy, or any input that is not a single-codepoint
// string, collapses to 'none' — the same defensive stance as pagesBucket, and
// it matters here for the same reason: an off-schema value would fail the
// WHOLE failure event and lose its stage and reason too.
//
// Order matters: emoji is checked FIRST because the pictograph blocks and the
// CJK blocks do not overlap, but the intent does — 🈯 (U+1F22F) is an
// ideograph drawn as a pictograph, and it arrives from an emoji keyboard, not
// from someone writing Chinese.
export function unsupportedCharClass(ch) {
  if (typeof ch !== 'string' || ch.length === 0) return 'none';
  const cp = ch.codePointAt(0);
  if (!Number.isInteger(cp)) return 'none';
  if (inRanges(cp, EMOJI_RANGES)) return 'emoji';
  if (inRanges(cp, CJK_RANGES)) return 'cjk';
  return 'other';
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
  // display_mode (2026-07-28): was the app launched from the HOME SCREEN or a
  // browser tab? GA4 structurally cannot answer this — `pwa_installed` counts
  // install EVENTS, and iOS Safari never fires `appinstalled` at all, so every
  // "Add to Home Screen" on an iPhone is invisible there. Asking the running
  // session what it IS, on every doc_open, measures the installed BASE by usage
  // instead of guessing it from a lossy install counter. Two values only:
  // anything not standalone is a browser tab.
  // text_layer (corrected 2026-07-28): VISIBLE text, not "any text object". A
  // searchable scan carries a full INVISIBLE text layer, so the old test
  // counted phone-scanner PDFs as born-digital — the wrong side of the exact
  // ratio this event exists to measure, and the population the OCR decision
  // rests on. Readings before 2026-07-28 overstate born-digital by that share.
  doc_open: {
    text_layer: 'bool',
    pages: PAGES_BUCKET,
    device: DEVICE,
    intent: INTENT,
    display_mode: ['standalone', 'browser'],
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
  // scan_offer (2026-07-28): someone tapped Edit on a page with NO TEXT LAYER —
  // a scan or photo. That was a dead end: a toast, and nothing else. ~6% of
  // daily users were walking into it (29 events/7 users on the 27th, 51/6 on the
  // 28th) and rising, because Edit is new.
  //
  // Tip-Ex and Teks already work on a scan — they cover and write over. What was
  // missing was the affordance, not the capability. This event measures whether
  // the offer lands.
  //
  // ⚠️ `accepted` fires when the tool is actually ARMED, never on the button
  // click — a click measures the button, and we need the behaviour (seat ruling).
  //
  // ⚠️ AND IT FIRES ONLY FROM THIS OFFER. Arming Tip-Ex on a scan WITHOUT having
  // hit the wall is normal use — whiting out a signature line, filling a scanned
  // form — and counting it here would import a population that never wanted OCR,
  // making the workaround look better than it is. The "can they get the job done
  // without OCR" number is a rail QUERY over the sequence (ganti_no_text_layer
  // -> tool_use), which per-event timestamps now make answerable. Events record
  // what happened; joins answer why. Overloading one enum value with two
  // meanings is how `matched:true` came to mean two things.
  scan_offer: {
    action: ['shown', 'accepted', 'dismissed'],
    tool: ['tipex', 'teks', 'none'],
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
  // 'residual' (added 2026-07-28) is the honest middle the enum was missing:
  // every target matched AND painted content we declined is still standing
  // inside a span we were asked to clear. It is deliberately NOT folded into
  // 'untrustworthy-run' — that names a different decline (badBts), and burying
  // a new signal inside an existing bucket is exactly how weight_ratio 1.28999
  // got quantized into 'near-parity' the same morning. A bucket that can't
  // express the finding is how the finding gets lost.
  surgery: {
    matched: 'bool',
    reason: ['clean', 'residual', 'no-match', 'untrustworthy-run'],
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
  // ---------------------------------------------------------------------
  // `block_edit` was DELETED here on 2026-07-28. Read this before re-adding it.
  //
  // It was declared, fixtured, and documented in spec-telemetry.md §70 as
  // "Rung D's evidence, live from day one of the merge" — and emitted by
  // NOTHING, for the entire life of the schema. So we believed we were
  // gathering evidence for the paragraph-reflow decision and were gathering
  // zero, with the validator green and every test passing. A declared-but-dead
  // event is worse than a missing one: it makes this file CLAIM evidence we do
  // not have about a decision that is still open. It also violated this
  // schema's own stated law — "anything not emitted by code does not enter an
  // enum" — which was written down and enforced by nothing until
  // tests/core/telemetry-liveness.test.mjs.
  //
  // THE QUESTION IT EXISTED TO ANSWER SURVIVES ITS DELETION: *is there real
  // demand for paragraph reflow (Rung D)?* Deleting an instrument without
  // keeping its question is how a parked decision quietly becomes
  // unanswerable. The answer does NOT need a new event — a user editing
  // several ADJACENT lines in one session is reflow demand expressed through
  // the line primitive, and `ganti_tap`/`ganti_commit` already carry enough to
  // see it. That is a rail QUERY, not a schema entry (seat ruling, filed as a
  // follow-up query in the telemetry spec).
  //
  // Rung D is wired to nothing today, so this event may have been unfireable by
  // construction. If Rung D ships, re-add it WITH its call site in the same
  // change — never ahead of it.
  // ---------------------------------------------------------------------
  commit_paint: {
    duration: 'duration',
    pages: PAGES_BUCKET,
    device: DEVICE,
  },
  // failure — the rail's oldest named blind spot, closed 2026-07-28 with its
  // own first case. Until now an export or commit that FAILED was invisible
  // here: only Sentry saw it, and only if someone happened to look. The rail
  // could say the feature was unloved or ugly, never that it was BROKEN — so
  // "the telemetry catches everything" could not be true, and it is a hard
  // precondition of the auto-push policy.
  //
  // We learned about the first instance (a 444-page AES-encrypted government
  // table that opens fine and cannot be written back) only because a founder
  // forwarded the file. With this event we know whether that is one user or a
  // hundred.
  //
  // `stage` names WHERE it died, `reason` WHY — deliberately wider than this
  // one case, because an enum is hard to widen once dashboards read it.
  // 'unknown' is mandatory and is the honest default: a failure we could not
  // classify must still be COUNTED, or the rail goes quiet exactly when
  // something new breaks. Content-blind like everything else here — no file
  // names, no document text, no error strings (a thrown message can quote the
  // document).
  // 'runtime' added 2026-07-28: an uncaught error or unhandled rejection, which
  // is not any of the pipeline stages. It exists because Editor v2 had NO
  // global error capture at all except Sentry — so a runtime error on the live
  // product reached the first-party rail nowhere, which is a direct hole in
  // "the telemetry catches everything". Forcing such an error into one of the
  // pipeline stages to avoid adding a value would have put a wrong value on the
  // rail to save an enum entry.
  //
  // ---- two props added 2026-08-09, both ADDITIVE ----
  //
  // ⚠️ NEITHER CHANGES AN EXISTING FIELD'S MEANING. `stage` and `reason` carry
  // exactly the values they carried yesterday, so every dashboard and every
  // view in scripts/telemetry-migration.sql keeps reading what it always read.
  // Redefining a live field is the founder's own hand; adding beside it is not.
  // (validateEvent has no optional props by design — see its "missing a
  // required prop" check — so both props are supplied at ALL FIVE call sites,
  // with a neutral value where the axis does not apply. That is the cost of
  // the no-optionals law and it is the right cost: a prop that is sometimes
  // absent is a prop no query can trust.)
  //
  // `class` — WHICH KIND of character a standard font refused, for the
  // `commit`/`unsupported` decline only ('none' everywhere else). Derived from
  // the FIRST offending codepoint via unsupportedCharClass() above, which is
  // the only door and can return nothing but the enum. NEVER the character,
  // never the string. Why it earns a field: "someone put an emoji in a form"
  // and "an entire script we cannot serve" are the same event today, and they
  // are not the same product problem.
  //
  // `blocked` — DID THIS ACTUALLY STOP THE USER, or is it a forewarning on
  // something that SUCCEEDED? Two of our five call sites report a failure for
  // a thing that worked fine:
  //   - the protected-PDF notice at import (js/v2/app.js) fires for a file
  //     that OPENED and is fully editable; only the eventual PDF export will
  //     refuse it. blocked: false.
  //   - the unencodable-character warning at commit (js/v2/app.js) fires for
  //     text we then COMMIT anyway — WARN, never DROP (founder ruling
  //     2026-07-29). blocked: false.
  // and three report a genuine dead end: the file that could not be opened at
  // all, the export that produced no bytes, and an uncaught runtime error.
  // blocked: true.
  //
  // Before this prop the ONLY way to tell a protected-PDF NOTICE from a
  // protected-PDF DECLINE on the rail was whether a `doc_open` happened to
  // arrive alongside it — a per-session join that is unreliable by
  // construction (same session, same stage, same reason, and a doc_open can be
  // dropped or arrive in a different batch). So "how many people can't open
  // their files" was being answered with a number that included people whose
  // files opened perfectly. Counting a success as a failure makes the rail
  // pessimistic in exactly the place the push policy trusts it most.
  failure: {
    stage: ['import', 'commit', 'export', 'compress', 'render', 'runtime'],
    reason: ['encrypted', 'corrupt', 'out-of-memory', 'unsupported', 'timeout', 'unknown'],
    class: UNSUPPORTED_CLASS,
    blocked: 'bool',
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
