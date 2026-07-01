# PDFLokal — Foundation Plan (v1)

> **What this is:** the concrete, phased plan to reorganize the code so it can serve the vision. Reads with [product-definition.md](product-definition.md) (the *why/what*), `memory/architectural-direction-2026-06-09.md` (the original direction), and the July-2026 architecture map (below, §1). This is the *how*.
>
> **The rule (from June 9):** incremental, shippable, **one structural change per phase**; each phase's scope is revisited *before* it begins; behavior-changing phases get a **verify-on-real-device-before-merge** gate. No big-bang rewrite.

---

## 1. The diagnosis (from reading the actual code, July 2026)

The spaghetti has one taproot: **there is no single document model, and rendering mixes DOM with canvas.**

- **Six parallel "truths," all keyed by array index**, kept in sync by `mutatePages()` (partial) plus manual work the caller must remember:
  `ueState.pages[]` · `annotations{}` · `pageScales{}` · `pageCaches{}` · `pageCanvases[]` · `sourceFiles[]`. Any one drifting = wrong render or crash. (`mutatePages` doesn't even own `pageCanvases` — the caller re-splices it by hand.)
- **`selectedAnnotation = {pageIndex, index}`** — two indices that must both stay valid through every mutation. This is the "stale selection / slides behind" family, by construction.
- **Mixed rendering:** annotations are drawn *onto the page canvas*, but their UI (the signature confirm/delete buttons) are **separate DOM elements** positioned from canvas coords. A newer page's canvas creates its own stacking context and paints over the button → **the "confirm button / annotation hides behind another page" bug** the founder hit. It's structural, not a CSS typo.
- **`pdf-export.js` reads `ueState.devicePixelRatio` and lazily-computed `pageScales`** → it is *not* headless; it can't run without the live render having happened.

Everything we keep patching lives in these four facts.

## 2. Target architecture — three layers

```
┌── CORE (js/core/, headless, no DOM) ──────────────────────────┐
│  One Doc model. A Page OWNS its annotations. Everything is     │
│  referenced by object/id — never by array index.              │
│  operations.js = the single mutation path.                    │
│  import (PDF.js → raster + meta) · export (model → pdf-lib)    │
│  = adapters at the edges. Core logic runs in Node.            │
└───────────────┬───────────────────────────────────────────────┘
                │ read + subscribe
┌───────────────▼──── RENDER (js/render/) ──────────────────────┐
│  Page background = rasterized <img> (survives mobile GPU       │
│  purge; zoom = CSS scale, atomic). Annotations = ONE overlay   │
│  layer above the <img>. The active object is ALWAYS top-most.  │
│  Viewport-relative: 3 nearest mounted (mobile) / N (desktop);  │
│  far pages = light placeholders. Evict = cheap; reload = fast. │
└───────────────┬───────────────────────────────────────────────┘
                │ input → operations
┌───────────────▼──── INTERACT (js/interact/) ──────────────────┐
│  ONE input path (pointer events; mouse + touch unified) →      │
│  hit-test the model → dispatch a core operation. Tools = verbs.│
│  Same path on mobile and desktop.                             │
└───────────────────────────────────────────────────────────────┘
```

## 3. The invariants (acceptance criteria — from product-definition §9)

1. One document model = one source of truth.
2. Page = picture; annotations = one overlay above it; active object = top-most.
3. Objects referenced, never indexed.
4. One interaction model → one input path (mobile + desktop).
5. Every mutation goes through one operation path.
6. The core is headless — model + operations + import + export run with no DOM.

**Litmus test for "done":** the core can load bytes, apply operations, and emit a correct PDF **in Node, with no browser.**

## 4. Current → target map

| Today (smeared) | Tomorrow (one home) |
|---|---|
| `ueState.pages[]` + `sourceFiles[]` | `Doc { sources[], pages[] }` in `core/model.js` |
| `annotations{pageIndex:[...]}` | `page.annotations[]` — on the page object |
| `selectedAnnotation {pageIndex,index}` | `doc.selection { pageId, annotationId }` — by id |
| `pageScales{}` `pageCaches{}` `pageCanvases[]` | render-layer concerns, keyed by `page.id`, not global index |
| `mutatePages()` re-keying dance | *deleted* — object refs don't need re-keying |
| annotations on page canvas + DOM buttons | one annotation overlay; UI in the same layer, top-most |
| `pdf-export.js` reads `ueState` | `core/export.js` takes a `Doc`, returns bytes |

## 5. Phasing

**Phase 0 — The headless core. ← we start here.**
Build `js/core/model.js` + `js/core/operations.js`: the `Doc` model (pages own annotations, everything by id/ref) and the single mutation path, proven with `node --test` (instant, no DOM). **Zero risk — not wired into the live app yet.** Then the import/export adapters (`core/import.js`, `core/export.js`), browser-tested against the golden suite (vendored PDF.js/pdf-lib are browser builds). Deliverable: *the "backend" exists and passes tests, and can round-trip a PDF headlessly.*

**Phase 1 — Image-background rendering + single annotation overlay.**
Rasterize each page on import; render pages as `<img>`; move annotations to one overlay layer with the active object always top-most. **Kills the mobile flicker/purge class AND the slides-behind bug.** Ship + **verify on a real Android device** before merge.

**Phase 2 — Viewport 3-nearest mounting.** Drive-style loading; far pages = placeholders; fast-scroll shows a brief, *expected* loading state.

**Phase 3 — Migrate the live editor onto the Core; retire the parallel state** (`pageCanvases`/`pageCaches`/`pageScales`/`annotations{}` collapse into `page.id`-keyed render state + `page.annotations`).

**Phase 4 — Reactive subscribers, IF state-sync pain still hurts after 0–3.** Tentative (June 9): don't build machinery preemptively; verify the pain first.

Each phase is revisited before it begins. Old and new coexist until each phase ships.

## 6. Verification / feedback loop (per phase)

- **Core:** `node --test tests/core/` — instant, headless. The mutation invariants (reorder/delete keeps annotations + selection correct with **zero re-keying**) are the proof the spaghetti class is gone.
- **Rendering:** Playwright visual suite + **a real-Android pass** (the mobile bugs need a device — DevTools won't repro stacking-context purges).
- **Export fidelity:** the golden PDF suite (`tests/golden/`) guards glyph/rotation/coords.
- **Discipline:** before/after regression on the touched flow + adjacent flows.

## 7. Guardrails / non-goals

- No big-bang rewrite. No server jobs. No new heavy deps.
- Don't build the reactive layer (Phase 4) preemptively.
- Behavior-changing phases (1–3) do **not** merge on green CI alone — the founder verifies the mobile merge→edit→download path on a real phone first. (Every mobile bug is a leak in a paid funnel.)

## 8. Status (July 2026)

The rendering approach is **settled and validated on a real Android** (see `memory/render-architecture-2026-07.md`). All of the below is built **beside** the live app — isolated, zero regression risk. The live editor still runs the old canvas pipeline.

- [x] **Phase 0** — headless core (`js/core/model.js` + `operations.js`), 7 headless tests (`npm run test:core`). · #81
- [x] **Phase 0b** — import adapter (`js/core/import.js`): `importPdf` + `rasterizePage` + `createPageRasterizer` (per-source doc cache). · #82
- [x] **Phase 1a** — image-backed render engine (`js/render/page-view.js`) + a phone-openable preview **`lab.html`** (`pdflokal.id/lab.html`, noindex/unlinked). · #83
- [x] **Phase 2 (in the lab)** — streaming/windowed loading (instant open, ~2-screen load / ~4-screen release → bounded memory), render-on-settle (skip rasterizing during a fast fling), scroll telegraph (skeleton shimmer + position pill). · #84 #85 #86
- [ ] **Phase 0c** — export adapter (`Doc → pdf-lib → bytes`), golden-verified. _(open)_
- [ ] **Phase 1b / 3** — wire the engine into the **LIVE editor** behind a flag; retire the old pipeline. Real-Android verify before merge. ⬅ **NEXT (the big, risky step)**
- [ ] **Phase 4** — reactive subscribers, only if state-sync pain remains.

**The four locked render decisions** (don't relitigate): pages are images · streaming (bounded memory) · render-on-settle (slow the render, not the user) · telegraph the loading state.
