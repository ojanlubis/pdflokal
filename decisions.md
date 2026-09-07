# `app/` — bench decisions (code-level WHY)

Founder rulings and product judgment live at the seat: `../decisions.md`. This file holds only
code-level WHY that has no other home — the reasoning behind an implementation shape, so that
`CLAUDE.md` can state the resulting law in one line without arguing for it.

Append-only. Newest at the bottom.

---

## 2026-07-30 — relocated out of `CLAUDE.md` during the prune

`CLAUDE.md` was pruned from 42 kB to a law-only file. Everything relocated below was checked against
`../decisions.md` and the bench memory bank first; only the items with no existing home were written
here. (Already-recorded whys — the push-authority ruling and its history, the 2026-07-28 gate/SEO
half-ship incident, the SEO generator blank-pages incident, the canvas-eviction history, the
`CLAUDE.md`-contradicts-itself audit finding — were deleted rather than copied.)

### Why the Edit engine is cut + stamp, and not hand-written glyph operators

A PDF has no text, only instructions to paint glyphs. So editing text that is already printed means
**cut + stamp**: `js/core/text-walk.js` interprets the content stream to find and remove the original
show-ops, then `js/core/stamp.js` picks a font it can *prove* is right (the document's own embedded
program → a bundled metric clone → a generic twin) and lets **pdf-lib** lay the replacement out.

The alternative was built, shipped, and then deleted: hand-writing the glyph operators ourselves,
**−1118 LOC**. It was not removed because it failed a test — it was removed because its bug class was
**unbounded**. Every document encoding, every subset, every CID mapping was a new way for the output
to be subtly wrong, and there was no finite set of cases to cover. Delegating layout to pdf-lib
bounds the problem to font selection.

Two laws came out of that deletion, and both now live in `CLAUDE.md` as instructions:

1. **Read the artifact, not its label.** A font wrapper claiming `CIDFont+F1` can *be* `Arial-BoldMT`.
   Names in a PDF are hints written by whatever produced the file; the program is the truth.
2. **The export path derives from the document, never inherits from UI state that may not have
   loaded.** State that exists on screen is not state that exists at export time.

### Why `docs/legacy/future-architecture.md`'s numbered plan is no longer tracked in `CLAUDE.md`

Items 1 (reactive state layer, `js/lib/events.js` pub/sub) and 1b (`PageRenderer` class in
`page-rendering.js`) were **completed in March 2026**; a completed plan item read as an open one for
four months. Item 2 (Web Workers for PDF export + compression) is still future work and belongs in
the seat's queue, not in a code-guidance file. The document itself remains at
`docs/legacy/future-architecture.md` for anyone starting a major refactor.

---

## 2026-08-26 — the Ganti commit/doc-font race: reproduced, and three fixes rejected

**The bug is real and is NOT fixed.** Recorded here because it cost most of a session to
characterise, and every obvious fix is worse than the defect.

### What it is

`prepareDocFont` is async and starts when the editor OPENS. `commit()` reads what it decided — the
annotation's font fields, the per-glyph coverage check, and the substitute toast / `font_path` that
follow from it. A commit landing before it resolves bakes the TWIN in permanently: the replacement
comes out in Helvetica against a document in its own font, and the `twin` reported to the rail is an
artifact of the race rather than a fact about the font.

Reproduction, `tests/fixtures/nasty/surat-word.pdf`, tap a line and:

| | committed `fontFamily` | `docFontFamily` |
| --- | --- | --- |
| type + commit immediately | `Helvetica` | absent |
| wait 3s in the editor, then commit | `Carlito` | present |

**The window is ~160-200ms** (measured, three fixtures, on a slow container — narrower on real
hardware). A human cannot type AND commit inside it; Playwright's `keyboard.type` can, every time.
So the 2026-07-19 ruling's framing ("a very fast typist can commit before it lands") still holds, and
the field report that re-opened this was **probably not** this bug — the re-edit hit-region defect
fixed in `6452a9e` is the better explanation for what that user saw.

### Why it is still open — three attempts, all rejected

Baseline for every measurement below: `ganti-teks` + `ganti-teks-fidelity` + `ganti-teks-reedit`,
**20 passed, 3 runs of 3.**

1. **Await the decision at the top of `commit()`.** 6 specs red. Defers the model write for the
   CANCEL, no-op and inline-retype paths too — they never read the decision — and breaks the
   founder-ruled contracts that Escape takes the cover with it and a no-op commit IS a cancel.
2. **Await only in the branch that creates the annotation.** 5 specs red, and worse than the bug:
   it leaves a window where the document does not yet contain the edit just committed, so a re-edit
   tap in that window misses `hitTestEditedLine`, falls through to a FRESH replace on the pristine
   line, and stacks a second cover. That is the doubling `ganti-doubling.spec.js` exists to prevent
   — document damage traded for a font.
3. **Keep the model write synchronous; settle only the font fields + toast + `font_path` before the
   bake.** The right shape, and still red: 1-2 failures on EVERY run against a clean baseline. The
   re-edit suite dies with pdf.js `Transport destroyed` — delaying the rebake by ~200ms collides
   with the rasterizer's own worker lifecycle, because the tests (and `import.js`'s edited-page
   cache) rasterize on their own schedule. Moving the settle after `syncPage`/`setTool` fixed the
   UI-state half but not this.

The through-line: `commit()` has several independent async consumers — the rebake, the rasterizer
cache, the worker lifecycle, the overlay sync — and the doc-font decision cannot be woven into it by
moving one await around. **A fix needs the rebake and the font settle sequenced deliberately, not
just reordered.** Anyone attempting it should start by making the rebake wait on an explicit
font-settled promise rather than racing it.

### If you pick this up

A test that reproduces it deterministically is easy to write and was proven RED 3/3 before any fix
existed: open `nasty/undangan-cid.pdf`, arm Ganti, `tapLine`, type and press Enter with NO poll in
between (every other test in `ganti-font-preview.spec.js` deliberately polls until the doc font
lands first), then assert the committed annotation carries `docFontFamily`. Guard it against
vacuity by asserting a `pdflokal-doc-` family actually registered in `document.fonts` — otherwise a
fixture whose font never loads makes the test pass for free.

## 2026-09-07 — the boot guard: heal once, narrowly, never offline

Cross-deploy asset skew still kills `js/v2/app.js` at module top level (Sentry JAVASCRIPT-V/J/Y/Z,
9 events, 2026-08-18 → 08-30). The 2026-07-28 network-first fix in `sw.js` closed the common path,
not the class: the offline fallback there is **per-file**, so one module can still come back stale
from cache while its siblings arrive fresh. When that happens there is no editor, no toolbar, and
**no telemetry** — the rail cannot report it, because `js/v2/telemetry.js` is inside the dead graph.

The recovery is an inline `<head>` script in `index.html` (inherited by the 12 generated pages) that
empties every cache, unregisters the service worker, and reloads. Three constraints on it, and each
one was a live choice:

1. **Narrow message match, not "any error."** Healing on every error reloads users through unrelated
   bugs, and a reload loop is strictly worse than a broken editor. It matches the module-load class
   only, in Safari's, Chrome's and Firefox's phrasings — our 9 measured events are all Safari, and a
   Safari-shaped fix would be a guard placed where the bug was seen rather than over the class.
2. **Disarmed at `load`.** Every failure it exists for happens while the deferred module graph is
   executing, which is before `load`. Staying armed afterwards would let an ordinary runtime
   `TypeError` wipe a user's cache mid-edit.
3. **Once per tab session, recorded in `sessionStorage`, and it fails CLOSED.** If storage cannot be
   written (blocked storage, some private modes) it never heals at all — without a record, "once" is
   unenforceable.

**Never while offline.** Emptying the cache offline replaces a dead editor with a browser error page,
and the stale cache is the only copy that user has. The offline check runs *before* the one-shot flag
is written, so a user who comes back online still has their one heal.

**Silent.** It reloads and says nothing. Any words would be client-facing copy, which is Fauzan's.

**The class is NOT closed, and the guard is not the fix — it is the recovery.** A skew can still be
manufactured on every deploy; the guard only makes it survivable, and only for a user who is online
and whose storage works. The real fix is a generation-tagged cache: all `/js/` keyed by deploy SHA,
with the offline fallback only ever serving a complete matched generation, never a mixture. That is
a rewrite of the fetch handler plus a deploy-time SHA the client can read, and it was not attempted
here.
