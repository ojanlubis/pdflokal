# PDFLokal — `app/` (the bench: all code execution)

100% client-side PDF + image tool for Indonesian users. Nothing is ever uploaded. `main` auto-deploys
to pdflokal.id.

## Hard constraints

- **Vanilla JS, native ES modules, no build step, no bundler, no framework** — that constraint is the
  moat. No npm runtime deps.
- **All vendor libs self-hosted in `js/vendor/`, zero CDN.** pdf-lib, PDF.js, Signature Pad,
  pdf-encrypt-lite, Canvas API. See `docs/security.md` for CSP, headers, load order.
- **No server-dependent features, permanently** — no PDF↔Word, no server OCR. In-browser OCR is
  sanctioned. `api/t.js` (telemetry) and `api/feedback.js` are the only server code in the repo.
- **All UI text in Indonesian**, informal "kamu". English tech terms (tap, scroll, install) are fine
  inside step-by-step instructions. **No em-dashes in user-visible text** — use `, `.
- Never add an external API call carrying user data. Privacy is the product.
- Target files up to 50 MB comfortably. Test Chrome, Firefox, Safari, Edge, phone and desktop.

## The tree

- **`index.html` is Editor v2 — the live product.** The landing page IS the editor's empty state.
  Headless core `js/core/` (model, operations, history, import, export, compress, export-images,
  `text-walk.js`, `stamp.js`) · render layer `js/render/` (page-view, viewport, interaction; pages are
  `<img>`, one overlay, one pointer path) · app shell `js/v2/` (app, download-sheet, page-manager,
  signature-modal, format-bar, celebrate). CSS is self-contained inside `index.html`.
- **12 SEO pages** are generated: `seo/pages.json` + `scripts/gen-seo-pages.js`, run via `npm run seo`.
  **Never hand-edit generated output.** Copy changes go through Fauzan.
- **`alat-gambar.html` is the OLD wing** (noindexed) — `js/editor/`, `js/pdf-tools/`, `style.css`, the
  old `init*.js`, `ueState`, `js/changelog.js`. It exists only to keep the image tools alive until
  absorption, and dies at demolition. Detail: `../reference/old-wing-code-reference.md` and the
  banner'd `docs/legacy/`. Do not build new surfaces on it.
- **⚠ Demolition is not free-standing:** `privasi` and `dukung` are on tokens but still borrow
  `style.css`'s header/footer/`.btn`. `css/legacy-bridge.css` maps the old names and **must load after
  `style.css`**.

### The SEO generator's split is load-bearing

`scripts/gen-seo-pages.js` templates the **BODY HALF ONLY** — it splits at `</head>`. Its anchors are
ordinary HTML strings, and the same strings occur as prose inside `index.html`'s `<style>` block.

- **Never write an HTML tag name in angle brackets inside `index.html`'s CSS comments.**
- **Never move a body substitution back onto the whole document.**
- **`seo:check` cannot catch a bug in the generator** — it compares generator output against files the
  same generator wrote. Render a page before believing it.

### Tokens and theming

- `css/tokens.css` is the single home for all 15 pages: **type by STEP** (`--fs-n2…--fs-9`, ratio
  1.2), **spacing by VALUE** (`--sp-24` is 24px), and **`--column: 920px`**, which the dropzone, the
  cards and every section below them share exactly.
- **`color-scheme` must be declared in all three theme states** or Chrome repaints form controls
  behind you — `getComputedStyle` will report the correct token while the screenshot shows grey.
- `css/tokens.css` owns the **system default**; `js/theme.js` owns an **explicit override** and
  expresses "no choice" by **removing** `data-theme`, never by writing `light`.

### UI work? Stop and read first

**Before any UI, design, or copy change: read `docs/design-language.md`** (founder taste, ratified — design language + interaction model) and load the design skills in `.agents/skills/`. Taste is law here.

### Edit Teks Asli

Editing text already printed in a PDF is **cut + stamp**: `text-walk.js` removes the original
show-ops, `stamp.js` picks a font it can *prove* is right (the document's own embedded program → a
bundled metric clone → a generic twin) and pdf-lib lays out the replacement. We do not hand-write
glyph operators (why: `decisions.md`). Two laws from that, both load-bearing:

- **Read the artifact, not its label.** A font wrapper claiming `CIDFont+F1` can *be* `Arial-BoldMT`.
- **The export path derives from the document, never inherits from UI state that may not have loaded.**

## The QA gate

**`npm run gate` (`scripts/qa-gate.mjs`) is the only sweep you may report from.** Lint → core →
Playwright. It fingerprints every file the dev server can serve, before and after, and exits
**90 = VOID** if the tree moved under the run rather than claiming a pass.

- **Its stage list MIRRORS CI, including `seo:check`.** If CI grows a check, the gate grows it the same
  day — anything CI runs that the gate does not is a way for the gate to lie.
- `npm run gate:self-test` proves the guard can still go red — run it if you touch the fingerprint.
- **A session rooted HERE owns the sweep and runs it in the FOREGROUND.** Never two Playwright
  invocations at once (they fight over the port and produce phantom `ERR_CONNECTION_REFUSED`).
  Subagents run lint + core only, never Playwright — a backgrounded run waits on a notification that
  can only wake the parent.
- **Test port is 5050, wired in three places** — `.claude/launch.json`, `playwright.config.js`'s
  `webServer`, the gate. Repointing one without the others gives a sweep and a human reviewing
  different servers, both green.
- **`npm run review` serves the whole product on `localhost:3000`** — the review server, deliberately
  not the test port. Never run it during a sweep either.
- **Keep large static assets out of the watched tree** (or exclude them from the fingerprint). The
  sampler re-hashes every 4s; gitignored wild PDFs in `tests/` once starved the gate.
- Suites: `tests/mobile/**` (the deep suite) + `tests/editor-v2-desktop.spec.js` target v2 at `/`;
  `tests/core/` runs headless via `npm run test:core`. `tests/fixtures/nasty/` is the corpus of real
  documents that have actually broken things — **add to it whenever a real file finds a bug.**
- **Wild corpus: cite files as `w001`–`w154`, never by filename** — they carry real client names.

## Verification law

**Before believing a green signal, ask what would look identical if broken.** Full corpus:
`when-the-instrument-is-the-bug.md` in the bank — read it before writing any guard.

- **A verifier must not share a parent with the verified.** **Presence is not landing.**
- **An assertion over an empty or `NaN` set passes for free.** Validate the instrument against a
  known-positive before believing any zero. **A pass COUNT is not a verdict.**
- **A guard placed where a bug was seen protects that place, not the class.**
- Assert the **behaviour**, never the vocabulary.
- **Screenshot every new UI surface.** A broken dialog once passed every functional test.

## What is never yours

**⛔ Push · merge to remote · deploy · client-facing copy · money · anything public-facing — Fauzan's
own hand.** Not the PM's either, and **per-turn verbal authorization is retired as a mechanism** — a
relayed "he said yes" is a carry. Push authority lives in a written artifact,
`../specs/spec-low-risk-list.md`, and arms only once the telemetry suite exists and that list has been
ruled item by item. **Until then: do not push, do not ask to push.**

Also the seat's, not yours: deciding what is worth building, ruling on taste, client-facing words. You
own build, test, refactor, the gate end-to-end, `docs/`, this file, and local commits on `main`.

Permanent refusals: never attach GA4 to Ads tag `AW-17538923405` · no fabricated AggregateRating ·
no server-dependent features · never hand-edit generated SEO pages.

## Git

- **There are no branches** (founder instruction 2026-07-27): local `main` and remote `main`, nothing
  else. Preserved-but-unmerged work lives on **tags** (`archive/i18n-groundwork`,
  `archive/edit-ladder-preheal`).
- **Never `git add -A`** — stage explicit paths. Other sessions have uncommitted work in this tree.
  **Never sweep another session's work, in either direction.**
- **Always `git -C <absolute path>`.** Bash cwd is session-dependent.
- Several sessions run on this repo at once: `git worktree add --detach`, never `git checkout` the
  shared tree.
- If you ever audit a branch: squash-merging makes `git branch --merged` report it unmerged forever —
  use a three-dot diff (`git diff origin/main...$b`), never commit counts.

**Rhythm:** failing test → green → `npm run gate` → local commit on `main` → update `../STATE.md` +
`../TODO.md` → **hand the push to Fauzan.** Document after approval: `README.md` → `CLAUDE.md` →
the seat.

## Where things live

- **The seat** (`..`, the PM) — `../STATE.md` (current state) → `../TODO.md` (the single queue) →
  `../decisions.md` (rulings + why) · `../reference/` (`product-definition.md` = the North Star) ·
  `../specs/` (build specs). The interface between the two seats is the disk, not a channel.
- **`decisions.md` here** — code-level WHY that has no other home. Founder rulings go to the seat's.
- **The bench memory bank:
  `~/.claude/projects/-Users-ojanlubis-machine-fkd-pdflokal-app/memory/`** — 50 topic files
  (`pdfjs-worker.md`, `pdf-lib-bitstability.md`, `when-the-instrument-is-the-bug.md`,
  `mobile-rendering.md`, `ga4-shared-tag-carrier.md`…). It is **not in this repo and you will not find
  it by searching.** Read `MEMORY.md` there before any deep work in `js/core/`, any guard, any test,
  or anything touching fonts, rendering or measurement.
- **Before writing any durable fact, check whether it is already on disk** — if it is, update it
  there. Do not create a second copy; two copies of one rule drift, and the wrong one gets read.
- `docs/security.md` (CSP, headers, libraries) · `docs/strengths.md` (why vanilla, why no framework) ·
  `docs/legacy/` = old wing, banner'd, not current.

## `.mcp.json` is project-scoped, and that is load-bearing

`playwright`, `sentry` and `analytics-mcp` (GA4 — service account
`pdflokal-ga4-reader@pdflokal-mcp`, property `properties/528550405`) load **only for sessions rooted in
this directory.** They do not load at the seat, and they do not load for subagents — a subagent
inherits the *parent's* cwd, so a seat-spawned agent lands at the seat. Every brief must `cd`
explicitly. Load the `google-measurement` skill before touching GA4, Ads or GTM.

## Repo conventions

> Every session starts with total amnesia. Maintainability here means: **can a future session with
> zero memory work on this file safely?** Three questions before you modify anything — can I
> understand it in one read · if I change one behaviour, how much unrelated code must I understand ·
> can I break something unrelated by touching it?

- **One rule, one home.** Search before creating; mark with `// SINGLE SOURCE OF TRUTH`. Never
  reimplement inline what a helper already does.
- **WHY comments, not WHAT.** Non-obvious functions get a `// WHY:` saying what breaks if changed and
  who decided. Nobody can ask you later.
- **Operation functions own mutation + sync.** Never mutate model state directly from UI code; use the
  helper that bundles the mutation with its required render/sync calls.
- **Files are self-contained.** Importing for functionality is fine; importing for *understanding* is
  the problem. If you must read three other files to understand one function, refactor.
- **Parallel arrays are a liability.** Two lists that must stay index-aligned will drift the first
  time one is spliced without the other. Prefer structures that travel together — a field on the
  object over a second array beside it. (The old wing's `ueState.pages` / `pageCanvases` pair is the
  cautionary instance; v2's model already avoids it, and should keep avoiding it.)

## Gotchas (v2)

- `npx serve` caches aggressively — hard-reload (Cmd/Ctrl+Shift+R) after changes.
- `npx serve` cleanUrls 301 **strips query strings** (tests use extensionless URLs).
- The global `dialog` CSS rule **is** the overlay — new dialogs must use a `.sheet` child.
- `history` is shadowed in `app.js` by the undo history — use `window.history`.
- No grid rebuilds mid-drag in page-manager (render parks on `dragActive`).
- `showToast()` / `showFullscreenLoading()` build DOM, never `innerHTML` — filenames are
  user-controlled. Do not revert.
- Never re-add canvas eviction (see `mobile-rendering.md` in the bank).
- Don't modify without good reason: `vercel.json`, vendor libs, privacy promises, Indonesian UI.

---

**PDFLokal exists to give Indonesian users a private, free, easy PDF tool. Every change serves that.**

*Cited as doctrine: [Delivery & the write/read asymmetry](../../../engine/wiki/machine/delivery-pull-surfaces.md) · [Gate design](../../../engine/wiki/machine/gate-design.md) · [Taste governance](../../../engine/wiki/machine/taste-governance.md). This document is one of the instances that earned it.*
