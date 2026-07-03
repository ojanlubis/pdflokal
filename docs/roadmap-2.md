# Roadmap — Vision → Foundation → Flush

_Updated: 2026-07 — **pivoted** from a pure backlog-flush to a vision-led foundation rebuild. Supersedes [roadmap-1.md](roadmap-1.md) (archived)._

**North star:** [product-definition.md](product-definition.md) — the WinRAR × Excalidraw of PDF for Indonesia; client-side is the moat; the editor is the product; mobile-first follows paid acquisition.

**The spine is now the foundation rebuild** ([foundation-plan.md](foundation-plan.md)), because craft-level mobile UX is impossible on the current architecture (6 index-keyed parallel state maps + mixed DOM/canvas rendering). The old tactical "waves" still exist, but **several are absorbed by the foundation** — we don't fix them twice.

**Standing rules:**
- Behavior-changing foundation phases (1–3) → **founder verifies on a real Android before merge.** Every mobile bug is a leak in a paid funnel.
- Small reversible steps; each proves itself via tests. Founder judges the end-product; process guarantees correctness.
- `backlog.md` stays the SSOT of findings; this roadmap sequences them.

---

## ★ THE SPINE — Editor v2: clean rebuild & swap → [foundation-plan.md](foundation-plan.md)

> **Strategy revised Jul 2 2026** (decisions.md): the old "wire the engine into the live
> editor behind a flag" plan is retired. Audit verdict: only ~800 of the live editor's
> 4,200 LOC are salvageable math; incremental wiring needs throwaway index↔id shims.
> Instead: **build Editor v2 clean on `js/core` + `js/render`, BESIDE the live app
> (`editor-v2.html`, noindex/unlinked), reach parity on merge→edit→download, then swap
> `index.html` to it and delete the old editor.** Founder approved.

- [x] **Phase 0** — headless core (`Doc` model, id-based). · **#81**
- [x] **Phase 0b** — import adapter (bytes→Doc, lazy rasterize). · **#82**
- [x] **Phase 1a + 2** — image-backed render + streaming + settle + telegraph, validated on real Android; **approach LOCKED**. · **#83–86**
- [x] **Engine completion (Jul 2)** — `core/history.js` (ONE unified undo/redo), move/resize ops, `core/export.js` (Doc→pdf-lib, pixel-verified — found 2 live bugs in the old exporter), `render/viewport.js` (streaming extracted from lab), `render/interaction.js` (one pointer path, DOM hit-testing, gesture-level undo).
- [x] **v2 skeleton (Jul 2)** — `editor-v2.html` + `js/v2/app.js`: load/merge → text (tap-to-type) → whiteout (drag) → signature (draw+place) → undo/redo → download. Container scroll. First mobile touch tests green; verified on real Android Chrome (emulator).
- [x] **v2 parity (Jul 2-3)** — format bar, paraf + semua-hal, Kelola Halaman (FLIP reorder), image-as-page, File menu, keyboard verbs, size guards, back button, analytics parity, the Unduh sheet (real compress + image export/ZIP), growth loop. · **#87–#99**
- [x] **THE SWAP (Jul 3, #103)** — founder phone gate passed → `index.html` IS v2 (landing = empty state, SEO head carried, ?buat= intent hook); old wing parked at `alat-gambar.html` (noindex) for the image tools; `/editor-v2.html` 302→/. Brand redesign shipped WITH the swap (#100-#102: red/warm stone/Plus Jakarta Sans, stamp language, physical-document interactions). Launch punch lists cleared Jul 4 (#104-#109, incl. Sentry fee8a76e).
- [ ] **Demolition** — after the post-launch bake (~1wk from Jul 3): cleanup agent deletes `js/editor/`, `js/pdf-tools/`, old init/mobile-ui/keyboard, style.css bulk, old test suites (~8-9K LOC total); CLAUDE.md + README full rewrite. Image tools need their exit decided first (extraction vs absorption — see backlog). ⬅ **NEXT (gated on bake)**
- [ ] **Phase 4** — reactive subscribers, IF state-sync pain remains (tentative).

### Mobile verification (the gap, closed Jul 2 — [android-verification.md](android-verification.md))
- **Tier 1:** Playwright `mobile-chrome` project (Pixel 7 touch emulation) — `npm run test:mobile`, runs in CI.
- **Tier 2:** Android emulator (Pixel 7 AVD, boots ~15s) + real Chrome driven via adb+CDP — `node scripts/android-verify.mjs`.
- **Final gate only:** founder's physical phone.

### ⤷ Absorbed by the foundation — do NOT fix separately
- **Wave 2 (performance / mobile-canvas / pinch-zoom flicker / fast-scroll jump-to-page-1)** → **Phase 1 + 2.** Same root cause (no-eviction memory pressure), same fix (image pages + windowed rendering).
- **Paraf Konfirmasi/delete z-index behind canvas · annotation slides-behind** → **Phase 1** (one overlay, active object always top-most). Structural, not a CSS patch.

---

## Tactical — around the foundation

### ✅ Shipped (July)
- Vision locked + GA4/Vercel/Ads analysis → `product-definition.md`, `foundation-plan.md`, memory.
- Wave 0: whiteout sticky · arrow-nudge · Ctrl+Z-in-sig-modal (**#74**) · Sentry JS-4/7/8 (**#75**) · dead-code + orphaned modal + visual-test fix (**#76**) · sidebar badge shrink + red-outline removed (**#78**).
- "Split PDF" homepage card regression fix (**#77**).
- Wave 1: signature clipboard-paste (**#79**) · drag-file-to-append on sidebar (**#80**).

### ▢ Remaining tactical (slot around the foundation)
- **Wave 1 — Android "Ganti File" picker** doesn't open · **[high]** _(needs phone)_.
- **Touch reorder** (Kelola Halaman + sidebar) · **[low]** — likely rides **Phase 3** interaction unification (one input path); don't hand-build twice.
- **Wave 5 — growth loop** _(independent; slot anytime for momentum)_: micro-celebration on download (hook `downloadBlob()`) · donate/share prompt after it (inline QR + Web Share, frequency-capped, dismissible).
- **Wave 3 — code-health audit** · **[med]** — largely **mooted** by the foundation rebuild; revisit *after* Phase 3 on the cleaner base.
- **Wave 4 — consolidate standalone tools into the UE** · 🎯 aligned with the vision (editor is the product), but a **product effort AFTER** the foundation is solid. Keep the **4.0 format-aware-UE decision** as a future gate (bare image → image-editing context vs per-page actions).

### 🎁 Free win (anytime)
- Register GA4 custom dims (`tool` / `action` / `fileType`) so GA4 stops mis-reporting bots-as-US-desktop (Vercel is currently the only trustworthy source).

---

_Older history in [roadmap-1.md](roadmap-1.md)._
