# Feature test suite — audit, 2026-07-30

**AUDIT ONLY. Nothing here was remediated.** The project sleeps for about a week after this, and a
half-finished repair left sitting through that is worse than a map. This is the map.

**The question**, by analogy with the telemetry suite's Class A ("every declared event must actually
be emitted"): **can each test go red?** The feature suite has never had that check.

**Why it is worth asking, from this project's own record:**
- the suite was GREEN at 287 passing on the day a real user made 24 edits and received no file
- a fix survived its own revert with everything green
- "the threshold has margin" came from 455 self-authored gaps; 21,732 real ones put it at the boundary

---

## The one-line finding

**I made `core/export.js` silently drop every text annotation — `teks` is 38.8% of all real tool use
— and ran the two specs most likely to notice. All 39 passed.**

That is not a hypothetical. It is the 2026-07-28 incident's exact shape (user types, exports, content
missing) reproduced deliberately, against a green suite.

---

## Counts

| | |
|---|---|
| test files | **104** (72 `tests/**/*.spec.js` + 32 `tests/core/*.test.mjs`) |
| test/describe declarations | **677** |
| files with an explicit proof-of-failure marker | **17 (16%)**, nearly all added in the last three days |

⚠️ **The marker count is a weak proxy and should not be quoted as a coverage number.** A second pass
re-reading every hit found ~13 false positives (`cache-control`, `Control+z`, `MutationObserver`,
`mutatePages`) and, more importantly, found that **many marker-less files are substantively rigorous**
— bidirectional pixel sampling, before/after byte diffs, exact-count self-checks — they simply do not
use the vocabulary. Marker absence means "unproven", never "vacuous".

**Sampled mutations, run for real** (the empirical half; agents cannot run tests):

| mutation | caught? |
|---|---|
| `undo()` renamed out of existence | 1 core test failed |
| `removeAnnotation` made a no-op (`splice`→`slice`) | 1 core test failed |
| line-clustering band widened 10x | 6 core tests failed |
| **export drops every `text` annotation** | **0 failures — 39 passed** |

The core suite has real discriminating power on the paths sampled. **The Playwright layer is where
the hole is**, and it is in the most-used feature in the product.

---

## Class 1 — can it go red?

**The pattern: `download.suggestedFilename()` treated as proof the export worked.**
`page.waitForEvent('download')` appears in 12 files. **5 never open the bytes.** Five siblings in the
same repo *do* (`compress-target`, `ganti-teks-export`, `ganti-baris`, `rung-c-native`, `smoke`), so
the discipline is known here and cheap.

| spec | what it proves today | what it would miss |
|---|---|---|
| `tests/mobile/download-sheet.spec.js:33-113` | 5 assertions, all `suggestedFilename()`, **zero `createReadStream`** (verified) | the whole mobile output pipeline emitting 0-byte, truncated or wrong-content files |
| `tests/mobile/editor-v2.spec.js:5` | header claims it exercises "open → edit → **download**"; the word appears **once in the whole file**, in that sentence (verified) | the mobile download button being broken or removed entirely |
| `tests/editor-v2-desktop.spec.js:15-48` | the flagship "full flow … download a valid PDF"; asserts DOM/model state, then only the filename | `buildPdfBytes` dropping every annotation and shipping a blank page |
| `tests/mobile/page-manager.spec.js:221` | extract asserts `halaman-1.pdf` filename only | extracting the *wrong* pages with the right name |
| `tests/mobile/review-fixes.spec.js:16-36` | race-recovery proven by "a .pdf eventually downloaded" | recovery handing back a stale or wrong page subset |
| `tests/mobile/signature.spec.js:92` | fixture is a single opaque red pixel with **no background to remove**; asserts only `data:image/png` | background removal being deleted from the upload path entirely |
| `tests/core-adapters.spec.js:51` | raster checked by dimensions + `dataUrlLen > 1000` | a blank, wrong-page or garbled render at correct dimensions |

## Class 2 — drives the real thing, or asserts on its own output?

The reference mistake was mine: asserting `text-visibility.js`'s own verdict on a file we generated
is not the same as driving the router that consumes it (fixed in `tests/ocr-roundtrip.spec.js`).

Remaining instances: **`stamp.js`'s mixed-font decline aggregation** and **the searchable-scan
detector** are proven green only by tests that construct their input with the same logic under test,
with no real-UI equivalent in the deterministic gate. Both are decision paths that change what lands
in a user's document.

## Class 3 — do the tested paths match what production runs?

Rail, last 14 days: `teks` 38.8% · `halaman` 20.9% · `tipex` 15.9% · `ttd` 13.5% · `gabung` 6.3% ·
`hapus` 4.6%.

Tagged declarations track usage share reasonably well (teks 38.5%, halaman 24.8%, tipex 17.7%).
**Two real findings underneath that comfortable number:**

1. **Five spec files whose names promise live-feature coverage drive `/alat-gambar.html` — the dead
   old wing** — via `window.ueState` / `uePmOpenModal` / `ueRemoveAnnotation`, not the v2 code users
   run: `kelola-halaman.spec.js`, `remove-annotation-selection.spec.js`, `signature-paste.spec.js`,
   `split-card.spec.js`, `sidebar-drop-append.spec.js`. Anyone answering "is Kelola Halaman tested?"
   by filename gets the wrong answer. **`signature-paste.spec.js` is the sharpest**: `js/v2/*` has no
   `paste`/ClipboardEvent handling at all, so this may be an unbuilt feature rather than an untested
   one — worth a product decision, not a test fix.
2. **`hapus`'s keyboard path is untested.** `Delete`/`Backspace` on a selected annotation
   (`app.js:1942`) fires the same `tool_use{hapus}` event as the UI button; **no spec in the repo
   presses either key**.

## Class 4 — is every decline exercised?

**Best-covered class: all seven named declines have tests**, and 27 distinct decline reasons were
enumerated across import/export, stamping, surgery, text-blocks and compression. Encrypted (import
*and* export), unsupported character, mixed-font, scan-with-no-text, invisible OCR layer, font-ladder
decline, and compression-finds-nothing all have citations. No gap found.

## Class 5 — empty-set and always-true

⭐ **The sharpest finding in the audit is a defect in a guard I wrote today.**

`tests/core/telemetry-coverage.test.mjs:201-233` — "no failure report hard-codes its reason" — does
`const m = /reason:\s*([^}]*)/.exec(call); if (!m) continue;`. **A `tel('failure', {...})` call site
that omits `reason` entirely produces `m === null`, hits `continue`, and is never asserted against.**
Verified by executing the exact regex: a call with no `reason` key returns NULL.

Worse than a silent skip: `telemetry-schema.js`'s `validateEvent` requires every declared key, so
such an event is **dropped at the edge** — not sent with a wrong value, sent *not at all*. That is
the "telemetry looks fine and is blind" shape the file exists to prevent, with this test green.

Second: `tests/golden/golden.spec.js:47-63` compares `results` built per rendered page and asserts
`expect(issues).toEqual([])`. **With zero pages rendered, `issues` is `[]` and it passes** — a clean
report having compared nothing. Currently not exploitable (fixed 2-page fixture, a corrupt export
would throw first), but it is the one file in the visual-regression suite lacking the non-emptiness
guard this repo treats as mandatory elsewhere.

Everything else checked out: 16 `toEqual([])` sites (15 with real listeners behind them), 6 `.every()`
sites all preceded by a length assertion, 14 negative `.some()` sites all paired with a positive.

---

## Ranked: what to fix first, and why

1. **Open the bytes in the 5 download specs.** Highest value per hour in the audit. The pattern is
   already used by 5 sibling files, so it is a copy, not a design. This is the only item that would
   have caught the mutation at the top of this document.
2. **Fix `if (!m) continue`** in `telemetry-coverage.test.mjs` — treat a missing `reason` as a
   failure, not a skip. Small, and it repairs a guard currently trusted more than it deserves.
3. **Add a vacuity guard to `golden.spec.js`** — assert the compared-page count matches the fixture.
   One line.
4. **Retarget or retire the 5 old-wing specs**, and separately decide whether v2 should have
   signature paste at all. Today they read as coverage and are not.
5. **Test the `Delete`/`Backspace` delete path.** Cheap, and it is a path with real usage behind it.
6. **Give `stamp.js`'s mixed-font decline and the scan detector a real-UI test**, so neither is
   proven only by input we generated.

**Deliberately not ranked here:** the page-1 sampling bias in `wild-sweep.mjs` and the w110 transport
question, both already recorded in the project memory bank as open work.

---

## Boundaries of this audit

- **Mutation sampling is a SAMPLE: four mutations, one of them Playwright.** Three core mutations
  were caught; one Playwright mutation was not. **Do not read "the core suite is sound" into three
  data points** — it means those three paths are guarded.
- **No agent ran any test.** Class 1-5 findings other than my four mutations are from reading, and
  are marked as such by their `verified` flags upstream. "This test would not catch X" is an
  inference from its assertions unless a mutation proved it.
- **Coverage counting is at the `test()` declaration level**, not assertions or branches. A test
  "tagged" for a tool only means its body references that tool.
- **~40 of ~85 marker-less files were read in full**; the rest were grep-sampled for five specific
  idioms. Other vacuity shapes in unread files are not excluded.
- **The 17-vs-19 marker discrepancy is unreconciled** — different match rules. Neither number is
  load-bearing; both are triage signals.
- **Class 3 rests on one rail window** (14 days, six tools). `halaman` fires once per sheet-open
  regardless of how many operations happen inside, so 20.9% caps what that event can say about depth.
