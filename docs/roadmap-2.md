# Roadmap — Vision → Foundation → Flush

_Updated: 2026-07 — **pivoted** from a pure backlog-flush to a vision-led foundation rebuild. Supersedes [roadmap-1.md](roadmap-1.md) (archived)._

**North star:** [product-definition.md](product-definition.md) — the WinRAR × Excalidraw of PDF for Indonesia; client-side is the moat; the editor is the product; mobile-first follows paid acquisition.

**The spine is now the foundation rebuild** ([foundation-plan.md](foundation-plan.md)), because craft-level mobile UX is impossible on the current architecture (6 index-keyed parallel state maps + mixed DOM/canvas rendering). The old tactical "waves" still exist, but **several are absorbed by the foundation** — we don't fix them twice.

**Standing rules:**
- Behavior-changing foundation phases (1–3) → **founder verifies on a real Android before merge.** Every mobile bug is a leak in a paid funnel.
- Small reversible steps; each proves itself via tests. Founder judges the end-product; process guarantees correctness.
- `backlog.md` stays the SSOT of findings; this roadmap sequences them.

---

## ★ THE SPINE — Foundation rebuild (priority) → [foundation-plan.md](foundation-plan.md)

Target: 3 clean layers — **Core** (headless `js/core/`) / **Render** (image-backed pages + one annotation overlay) / **Interact** (one input path). Built *beside* the live app, swapped in incrementally. No big-bang.

- [x] **Phase 0** — headless core: one `Doc` model, page owns its annotations, everything by id not index. 7 headless tests. · **#81**
- [x] **Phase 0b** — import adapter: `importPdf` (bytes→Doc) + `rasterizePage` + `createPageRasterizer` (per-source doc cache). · **#82**
- [x] **Phase 1a** — image-backed render engine (`js/render/page-view.js`) + phone-openable preview `lab.html`. · **#83**
- [x] **Phase 2 (in the lab)** — streaming/windowed loading (bounded memory), render-on-settle, scroll telegraph (shimmer + position pill). **Validated on real Android. Rendering approach LOCKED** (`memory/render-architecture-2026-07.md`). · **#84 #85 #86**
- [ ] **Phase 0c** — export adapter: `Doc → pdf-lib → bytes`, golden-verified. _(open — completes the headless round-trip)_
- [ ] **Phase 1b / 3** — wire the engine into the **LIVE editor** behind a flag; retire the old canvas pipeline. ⬅ **NEXT (the big, risky step).** Real-Android verify before merge. **Kills mobile flicker + slides-behind + paraf z-index — structurally.**
- [ ] **Phase 4** — reactive subscribers, IF state-sync pain remains (tentative — verify pain first).

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
