# SPEC (proposal) — Font-fidelity engine: what to paint when the document's own font can't cover the edit

_Drafted 2026-07-20 by Fable (developer seat, worktree `pdflokal-font-fidelity`), on the PM seat's brief.
Status: **RATIFIED same day (build order + honesty grades, in-session structured questions) →
TIERS 1+2 BUILT on this branch, full sweep green — awaiting founder review/merge (nothing on main).**
Built artifacts: `js/core/font-decide.js` (+16 clone woff2 in `fonts/`, wired through export/state/
page-view/index.html/app), `js/core/compose.js` (+`page-surgery.js` composed fallback, commit-toast
decision in `app.js`), fixtures `carlito-subset.ttf` + `nota-subset.pdf` (+ generator), tests
`tests/core/font-decide.test.mjs` + `tests/core/compose.test.mjs` + `tests/ganti-compose.spec.js`
(end-to-end through the real UI: composed commit bakes silently, uncomposable twins + toasts)._
The Rung-C ruling this spec must not break (decisions.md 2026-07-19): own-font-when-provable,
honest-look-alike otherwise, **never a silent guess**. This spec doesn't bend that law — it
extends "provable" further than coverage-check-or-give-up, and makes the honesty notice
*precise* instead of one-size-fits-all._

## 0. Verdict up front

Today the engine knows two answers: **native** (every glyph provably in the embedded font) and
**generic twin** (a bucket guess off pdf.js's collapsed `serif/sans-serif/monospace` — the real
`/BaseFont` name never feeds it). The distance between those two is where fidelity dies, and it
splits into two buildable tiers plus one refusable one:

| Tier | What | Recommendation |
|---|---|---|
| 1 | **Exact-clone routing** — `/BaseFont` → metric-identical open clone (Arimo/Tinos/Cousine/Carlito/Caladea) | **BUILD.** Bounded, mechanical, covers the Indonesian common case (Word fonts) almost entirely. |
| 2 | **Glyph composition** — paint a missing accented glyph from outlines the subset already has (É = E + é's own acute) | **BUILD (Identity-H first).** Prototype proven end-to-end on a true subset; placement within ~1.5% of em of the font designer's own choice. The only tier that keeps the *document's own font* on the page. |
| 3 | **ML glyph synthesis** | **REFUSE** — explicit ruling in §5, not a silent omission. |

The actual product of this spec is the **decision engine** (§2): one pure function that turns
{real font name, per-glyph coverage, composability, clone availability} into one of four paths —
`native / composed / clone / twin` — and one honesty grade. Both call sites (editor commit,
export surgery) read the same decision, so preview, toast, and baked bytes can never disagree.

**Prototype receipts** (all in this worktree / scratchpad, §9): a true Carlito subset (é present,
É absent, acute reachable ONLY as an un-cmapped glyf component), an edit containing É painted in
the document's own outlines via two show ops and zero font mutation, rendered through our own
vendored pdf.js next to the full-font truth. Overlay diff: glyph bodies identical, accent
placement off by ~0.2pt at 12pt — beneath print perception.

## 1. What exists today (read from the code, not assumed)

- `core/reinsert.js planNativeInsert` — the prover. Declines with typed reasons
  (`missing-glyph`, `unsupported-font`, `unsupported-encoding`, `mixed-fonts`, …). Two font
  shapes supported: Type0/Identity-H (writes raw GIDs — can address ANY glyph in the subset,
  cmapped or not; this is what makes tier 2 possible) and simple-TrueType/WinAnsi (writes bytes —
  can only address encoding-reachable glyphs).
- `core/font-style.js getFontStyleInfo` — already reads the real `/BaseFont` + FontDescriptor,
  today only for bold/italic. **The name is sitting right there; nothing routes on it.**
- `v2/text-runs.js mapRunFont` — the generic-bucket twin picker. Its `fontFamily` input is
  pdf.js's own collapse ('sans-serif'…); its `fontName` input is pdf.js's internal id. It cannot
  do better than a bucket — not a bug, an information starvation.
- `v2/app.js prepareDocFont / loadDocFont` — live preview via FontFace, twin behind it in the CSS
  stack (per-glyph browser fallback = honest preview of export's coverage check). Commit-time
  toast: covered → silent, else "Huruf ini memakai font pengganti yang mirip".
- `core/export.js` — `FONT_NAME_MAP`/`CUSTOM_FONT_URLS`/`embedCustomFont`: the custom-font embed
  machinery tier 1 rides on already exists (Carlito/Montserrat prove the path).

## 2. The decision engine

New pure module **`js/core/font-decide.js`** (vendor-injected like every core module, zero DOM):

```
decideFontPath({
  baseFont,        // from getFontStyleInfo — '' when unreadable
  flavor,          // 'type0-identity-h' | 'truetype-simple' | other (from the font dict shape)
  fontkitFont,     // parsed subset, or null when extraction declined
  subsetBytes,     // raw program bytes (for the glyf composite reader), or null
  text,            // the FINAL replacement text
}) → {
  path: 'native' | 'composed' | 'clone' | 'twin',
  grade,           // the honesty grade — see §6; the toast is a pure function of this
  composePlan,     // per-char plans when path==='composed'
  family,          // resolved annotation fontFamily when path is clone/twin
  reason,          // the decline reason that pushed us DOWN to this path (telemetry)
}
```

Decision ladder, strictly ordered, each step provable or it falls through:

1. **native** — every non-space char covered by the embedded program
   (`hasGlyphForCodePoint`, exactly today's check).
2. **composed** — every uncovered char has a valid composition plan (§4) from outlines the
   subset itself contains. Still the document's own font on the page.
3. **clone** — `normalizeBaseFont(baseFont)` hits the metric-clone table (§3). The substitute's
   widths are identical by construction; layout cannot shift.
4. **twin** — today's `mapRunFont` bucket. Unchanged behavior, now explicitly the floor.

Call sites (two, and only two — the SSOT discipline):
- **Commit path** (`v2/app.js` commit): replaces the inline `covered` check. Decides the toast
  AND stamps `draft.fontFamily` (clone/twin) or the compose plan (carried on the annotation the
  same way `replaceCoverId` already rides).
- **Export path** (`core/page-surgery.js` → reinsert): `planNativeInsert` stays the untouched
  native prover; when it declines `missing-glyph`, the surgery consults the compose planner
  (`core/compose.js`, §4) before falling back to the twin annotation. Same decline-never-guess
  shape: compose either proves its plan or returns a typed reason.

The decision is **deterministic from the same inputs at both sites** — the toast the user saw at
commit and the bytes export writes can never tell different stories. (A very fast typist can
still commit before the font program loads — that race exists today and resolves the same way:
no proof loaded yet → the honest lower path.)

## 3. Tier 1 — exact-clone routing (bounded, high ROI)

**The palette** (all Apache-2.0, the same license family as the Carlito we already ship —
no AGPL/licensing ripple):

| Real font (from `/BaseFont`) | Clone | Metric relationship |
|---|---|---|
| Arial / ArialMT / Arial-BoldMT / Helvetica* | **Arimo** | metric-identical (Croscore) |
| Times New Roman / TimesNewRomanPS*MT / Times* | **Tinos** | metric-identical (Croscore) |
| Courier New / CourierNewPS*MT / Courier* | **Cousine** | metric-identical (Croscore) |
| Calibri* | **Carlito** | metric-identical (already shipped) |
| Cambria* | **Caladea** | metric-identical (crosextra, same project as Carlito) |

`normalizeBaseFont`: strip the subset prefix (`ABCDEF+`), strip style suffixes (reinsert/
font-style already parse bold/italic separately — the clone's weight file comes from the
existing `resolveFontName` variant logic), case-fold, prefix-match the table. Anything else →
twin, unchanged. **Aptos** (Word's default since 2024) has no metric clone anywhere; it falls to
twin honestly — telemetry (§7) will tell us how often it shows up.

**Wiring** (all existing machinery, zero new concepts):
- `core/export.js`: five families added to `FONT_NAME_MAP` + `CUSTOM_FONT_URLS`; fetched only
  when an annotation actually uses them (the `getFont` cache already lazy-loads per name).
- `js/lib/state.js CSS_FONT_MAP`: five entries so preview + committed overlay render the clone.
- `v2/app.js prepareDocFont`: it already calls `getFontStyleInfo`; route
  `draft.fontFamily = cloneFor(baseFont) ?? mapRunFont(...)`. The FontFace doc-font preview still
  loads IN FRONT of the clone in the stack — the clone is the fallback tier, exactly as the twin
  is today.
- Font files: 4 weights × 4 new families ≈ **16 files × ~25–45KB woff2** — but lazy per
  name; a typical session fetches 0–2 files (~30–70KB). Nothing enters the critical path;
  the moat's payload discipline holds. ⚖ *Option to trim: regular+bold only (italic falls back
  to regular + the twin's synthetic oblique) — halves the footprint; my call: ship all four
  weights, they're cheap and italic-correctness is visible.*
- **The user-facing font dropdown does NOT grow.** These are substitution infrastructure, not
  authoring palette — the dropdown staying 5 entries is attention-choreography, not laziness.
  ⚖ *minor: bless or veto clones-in-dropdown.*

**Why this matters more than it looks:** when the font program was never embedded at all (common
for system-font PDFs), `/BaseFont` is ALL the file knows — and today we bucket it to Helvetica.
With routing, an unembedded Arial document gets Arimo — which is not "a look-alike", it is the
same metrics Arial itself guarantees. And for the founder's own Word-doc field case (Calibri),
the fallback annotation becomes pixel-plausible instead of visibly foreign.

## 4. Tier 2 — glyph composition (the prize: the document's own font, kept)

**The claim, proven:** many "missing" glyphs are Latin base+diacritic combinations whose parts
the subset already carries. Word's subsetter includes composite glyphs' *components* — so a
document containing `é` carries the acute outline even though no codepoint reaches it. The
Identity-H writer addresses glyphs by GID, so those orphan outlines are paintable **today**,
with zero font mutation — two show ops instead of one.

**Prototype receipts** (scripts + fixtures in §9, rendered proof attached to the PR):
- True subset (pyftsubset, GSUB/GPOS deliberately dropped — the worst case): 54 glyphs,
  `É` absent, `´`/U+0301 absent from cmap, acute outline present only as é's component (gid 35).
- Composed `KAFÉ ANDRÉA` (two É's) via base-run TJ + one absolutely-positioned mark block per
  accent; rendered through our vendored pdf.js against full-Carlito truth.
- Measured against the font's own design (full Carlito's real É composite): vertical placement
  off by 30/2048 em (~0.18pt at 12pt), horizontal off by 24/2048 em with bbox-centering. The
  full font's É uses a dedicated flattened uppercase accent variant the subset doesn't carry —
  that *shape* nuance is the irreducible cost, and it is invisible at document sizes.

**The algorithm** (new `js/core/compose.js`, sibling of reinsert.js — reinsert untouched):

1. **Gate:** char NFD-decomposes to exactly `base + one combining mark`, mark ∈ the above-marks
   set (acute, grave, circumflex, tilde, diaeresis, macron, caron, breve, ring). Base covered by
   the subset. Anything else → typed decline.
2. **Mark resolution ladder** (first hit wins):
   a. cmap has the combining mark → GID (+ `font.layout()` GPOS anchors when layout tables
      survived — they do in pdf-lib-produced subsets, proven on the Montserrat fixture);
   b. cmap has the spacing clone (´ ` ˆ ˜ ¨ ¯ ˇ ˘ ˚) → GID, bbox placement;
   c. **glyf composite donor parse** — walk cmapped codepoints whose NFD contains this mark,
      parse the donor's composite records (~60 lines of DataView; prototyped), take the
      non-base non-empty component: GID **plus the font designer's own placement offsets**.
3. **Placement:** horizontal = donor offset re-centered on the target base's *outline* center
   (measured 2× closer to truth than advance-centering); vertical = **preserve the donor's
   optical clearance gap** (mark-bottom above base-top — the quantity the designer actually
   chose; transfers exactly across x-height→cap-height bases).
4. **Collision guard:** raised mark outline must clear the base outline, else decline. A font
   whose geometry breaks the model gets a decline, never a smudge.
5. **Emission:** the base run rides the existing TJ path with the base glyph in the composed
   char's slot (advance = base advance, typographically correct for Latin); each mark adds one
   absolutely-positioned `BT…Tm…TJ…ET` block using the same rotated-frame math reinsert already
   does. Total width unchanged → the cut/insert geometry contract holds.
6. **Text-layer honesty:** patch the subset's ToUnicode CMap with `markGID → U+03xx` so
   extraction/copy of the composed text yields NFD (`E` + combining acute) — canonically
   equivalent to É for search and copy-paste. This is REQUIRED for ship (the file must not lie
   to text extraction), and is a bounded pdf-lib low-level edit (append a bfchar).

**v1 scope guards** (each a typed decline reason, mirrored in telemetry):
- Type0/Identity-H only. The simple-TrueType/WinAnsi path can only address encoding-reachable
  glyphs, and real Word subsets don't cmap unused marks (proven by the fixture) — so composition
  on the Word shape would fire almost never and lie in wait for edge cases. Decline
  (`compose-simple-font`); tier 1 catches that shape instead (Word fonts ≈ the clone table).
- Above-marks only (`compose-below-mark`: ç ş ą decline); single mark only
  (`compose-multi-mark`: Vietnamese stacked accents decline); no scaled/transformed components
  (`compose-scaled-component`); glyf only, CFF declines (`compose-cff` — CharString parsing is
  a different project and CFF text fonts are rare in our wild; telemetry will say).
- Collision or unresolvable mark → `compose-mark-missing` / `compose-collision`.

**Preview policy:** the browser cannot compose — in the editor a composed char previews as the
twin (the FontFace per-glyph fallback that already exists), and the export paints better than
the preview showed. Mismatch in the honest direction only. The commit toast must follow the
DECISION (covered-or-composable → the composed grade, not the twin notice) — otherwise the
toast lies downward. A live canvas-drawn preview of composed glyphs (fontkit `glyph.path` →
Path2D) is possible and cheap to bolt on later; deferred, not designed here. ⚖ *acceptable, or
does WYSIWYG-strictness demand the canvas preview in v1?*

**Indonesian reality check** (why this tier earns its bytes): bahasa itself is ASCII, but real
documents aren't — names and honorifics (André, Renée, Aisyah's "'" is ASCII but Nur'aini ʼ
variants aren't composable — decline), loanwords (café, résumé), and the big one: **Arabic
transliteration in religious/academic text** (ā ī ū ṣ ḥ — the macron trio composes; the
dot-belows decline in v1). Every case that declines still lands on tier 1/twin exactly as today.
Telemetry closes the loop on whether below-marks earn a v2.

## 5. Tier 3 — ML glyph synthesis: REFUSED (explicit, reasoned)

Three independent walls, any one of which suffices:
1. **Moat/payload:** any credible style-transfer model is MBs of weights + a WASM runtime — on
   the exact 1-juta-Android + slow-connection users the product optimizes for, against a vendor
   budget that is 2.6MB *total*. The no-build-step law takes on a training/toolchain shadow too.
2. **The honesty law inverts:** a synthesized glyph is a *guess wearing the document's own
   clothes*. Native/composed are provable ("these outlines ARE in the file"); a hallucinated
   outline is the one substitute the user cannot detect — it defeats decline-never-guess from
   the inside. The trust thesis says the notice exists to prevent exactly this.
3. **The residual class is small and measurable:** tier-3's only market is
   {missing-glyph} − {composable} − {clone-covered} — after tiers 1+2, that's mostly exotic
   scripts and symbol fonts, which need real font coverage, not glyph invention.

**Revisit trigger** (falsifiable, not vibes): if telemetry shows `insert{reason:missing-glyph}`
staying a top-2 decline AFTER tiers 1+2 ship, with `compose-*` declines dominating inside it —
that's evidence of a systematic composable-but-declined class, and the first move is widening
tier 2 (below-marks, CFF), still not ML.

## 6. Honesty policy — the notice is a verification grade (⚖ the taste call)

The machine→human boundary law applies: the engine PROVES different things on different paths,
and the user-facing notice should render *what was proven*, not one blanket apology. Calibrate,
don't comfort — in both directions: a metric-identical clone wearing "font pengganti yang mirip"
manufactures doubt (the widths are provably identical); a silent outline-substitution is a false
green. Proposed grades:

| Path | What is provably true | Notice — **RATIFIED 2026-07-20** |
|---|---|---|
| native | the file's own font, own glyphs | **silent** (unchanged) |
| composed | the file's own font, own outlines; placement is ours, bounded ~0.2pt @12pt | **silent** — founder-ratified: there is no substitution to disclose; the pixels are the document's. |
| clone | different outlines, identical metrics — layout provably cannot shift | **notice, TODAY'S COPY** — founder-ratified: "Huruf ini memakai font pengganti yang mirip" stays. One grammar for every substitute tier beats per-tier precision. (My "sharpen" option B was declined — banked to the taste corpus.) |
| twin | different font, approximate look; widths differ | **notice, today's copy** (unchanged) |

**Name-only carve-out (founder-ratified 2026-07-20 evening, after the e-AHU field case):**
when the file provably embeds NO font program (`font-style.js embedded:false` — the standard-14
server-generator shape) AND the exact clone fired, the commit is **silent**: the "original"
being substituted is only a name that every viewer already substitutes — a notice would compare
against nothing real. Scoped tight: an exotic-but-embedded program we merely fail to parse
keeps the notice (a real font exists and our shapes diverge from it). Everything else about the
one-grammar ruling stands — the notice text never varies; only this one case stops counting as
a substitution at all.

Net effect on code: notice fires iff a substitute paints AND (the file had a real font OR no
exact clone matched) — still no new strings in the product. The grade flows to telemetry (§7),
where precision belongs.

## 7. Telemetry (the loop that makes this self-correcting)

Rides the blessed rail (spec-telemetry.md), enums only, no names ever:
- `insert.path` enum extends: `native | composed | clone | twin` (2 new values).
- `insert.reason` gains the compose declines verbatim from code: `compose-simple-font`,
  `compose-below-mark`, `compose-multi-mark`, `compose-mark-missing`, `compose-collision`,
  `compose-scaled-component`, `compose-cff`.
- `ganti_commit.font_path` extends the same way.
- `font_seen` unchanged — flavor mix already tells us the Identity-H vs simple-TT split that
  gates tier-2 reach.
Standing PM read: decline distribution decides tier-2 v2 scope (below-marks? CFF?) and
whether Aptos volume justifies hunting a clone. Every widening is evidence-gated, like the
ladder itself.

## 8. Payload & architecture accounting

- New modules: `core/font-decide.js` (pure decision), `core/compose.js` (planner + glyf
  component reader + ToUnicode patch). `reinsert.js` untouched (same pattern as the Rung C+
  extension: siblings, not surgery on the prover).
- App deltas: commit-path decision call, `prepareDocFont` clone routing, `CSS_FONT_MAP` +
  `FONT_NAME_MAP`/`CUSTOM_FONT_URLS` entries.
- Bytes: +16 lazy woff2 files ≈ 480–640KB on DISK, ~0–70KB per session in practice, 0 on the
  critical path. JS: compose planner ≈ 4–6KB unminified by prototype size. No WASM anywhere.
- Licenses: Arimo/Tinos/Cousine (Apache 2.0, Croscore), Caladea (Apache 2.0, crosextra) — same
  family as shipped Carlito; no AGPL interaction.

## 9. Fixtures, prototype artifacts, test plan

Delivered in this worktree (proposal artifacts, not shipped code):
- `tests/fixtures/nasty/carlito-subset.ttf` — true subset: é composite present, É absent, acute
  un-cmapped, GSUB/GPOS stripped. (Generated via fonttools/pyftsubset — scripts-side tooling
  only, one-time, artifact committed like every gen-fixture output.)
- `scripts/lab-compose-glyph.mjs` — the lab: builds the fixture PDF, plans + paints the
  composed insert, emits before/composed/reference PDFs.
- `docs/font-fidelity-proof.png` — the rendered montage (composed vs full-font truth vs overlay).

Test plan for the build (all headless `tests/core/`):
- compose planner: each decline reason has a case; placement math pinned against the full
  Carlito É/Á component records (the ground truth measured in this spike).
- decision engine: table-driven — {coverage, composability, baseFont} × expected path/grade.
- clone routing: normalizeBaseFont table incl. subset prefixes and style suffixes.
- export round-trip: composed PDF re-opened, text extraction yields NFD (ToUnicode patch).
- golden: composed render PNG-hash per the established cross-platform tolerance discipline.

## 10. Falsifiers

- If wild `font_seen` shows simple-TT dominating AND clone-table misses dominating twin usage,
  tier 2's reach is small and tier 1 needed a bigger table — the engine's ORDER still holds.
- If composed placement produces a single founder-visible artifact on a real document, the
  collision guard was too loose — tighten to decline; the ladder's floor is always honest-twin.
- If clone files measurably hurt the low-RAM path (they shouldn't — lazy, tiny), trim to
  regular+bold per §3's option.

## ⚖ Decision points — status after founder review (2026-07-20, in-session)
1. ~~Bless the ladder + build order~~ — **RATIFIED: build both, tier 1 then tier 2.**
2. ~~Honesty grades~~ — **RATIFIED: composed = silent; clone = today's copy unchanged.**
3. ~~Clones in the user font dropdown~~ — **RATIFIED: YES** (2026-07-20 evening, overriding the
   keep-it-5 recommendation) — labeled with their familiar equivalents ("Arimo (Arial)", …).
   Honest correction recorded: the dropdown enumerates FONT_CSS keys, so the clones had already
   entered it when tier 1 landed — the "stays 5" claim in the first commit was wrong; the ruling
   makes the state deliberate.
4. ~~Tier-3 refusal~~ — **RATIFIED** (part of the blessed ladder: "Tier 3 stays refused").
5. ~~Composed-glyph live preview~~ — **RATIFIED: twin preview ships v1** (2026-07-20 evening);
   the canvas-drawn composed preview stays a bolt-on candidate, evidence-gated.

🤚 One Fauzan-hand item before tier 1 can complete: the four clone families' woff2 files
(Arimo/Tinos/Cousine/Caladea) are not in the repo — they must be fetched from a vetted source
(Google Fonts / google-webfonts-helper) and committed to `fonts/`, same self-hosting discipline
as every existing asset.
