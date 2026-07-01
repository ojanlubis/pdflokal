# Roadmap 2 — Backlog Flush

_Started: 2026-07-01 — Supersedes [roadmap-1.md](roadmap-1.md) (archived, June history)._

The goal of this roadmap is to **drain the whole Open backlog to zero**, in waves.
Every open `backlog.md` item has a home here — nothing is orphaned.

**Execution order (decided with user, Jul 1): `0 → 1 → 5 → 2/3 → 4`.**
Quick wins + mobile bugs first (fast, visible), then the small growth loop for
momentum, then the measure-first audits, then the big UE consolidation last —
risk rises gradually.

**Two standing rules:**
- **Measure-first** for Waves 2 & 3 — bring numbers before choosing a fix.
- **Gate:** Wave 4's big piece is blocked on the 4.0 format-aware-UE decision.
- Every fix keeps the discipline: reproduce-before → fix → verify-after → regression sweep.

---

## Wave 0 — Quick wins & Sentry cleanup  ⬅ NOW
_Low-risk, self-contained; drains ~10 items. Batchable across 1–2 sittings._

- [x] REVERT whiteout auto-switch-to-Pilih (#60) — whiteout stays sticky; tests flipped · **[high]** _(PR A)_
- [x] Arrow-key nudge for a selected annotation (1px / Shift=10px), one undo per burst · **[high]** _(PR A)_
- [x] Ctrl+Z inside the signature/paraf modal rewinds the pen stroke, not a doc annotation · **[high]** _(PR A)_
- [ ] Sentry true-fixes JS-4 / JS-7 / JS-8 — one atomic re-key pass (selection follows page/annotation mutations; audit off-SSOT page creation) · **[med×3]**
- [ ] Paraf Konfirmasi/delete buttons z-index behind canvas on mobile · **[low]**
- [ ] Sidebar page-number badge too large / covers thumbnail · **[med]**
- [ ] Red-outline around active page — decide keep/soften/remove (desktop-only already) · **[low]**
- [ ] Retire the orphaned `text-input-modal` (dead since the format bar) · **[low]**
- [ ] Fix visual test so it actually captures the modal (screenshot the element, not the masked page) · **[low]**

## Wave 1 — Mobile reliability & content-add
_Real-user friction. Some items need a real Android device to verify._

- [ ] "Ganti File" doesn't open the picker on Android Chrome — visually-hidden input + reorder the onclick · **[high]** _(needs phone)_
- [ ] Signature upload tab accepts Ctrl/Cmd+V (paste image from clipboard) · **[med]**
- [ ] Drag a file onto the sidebar → APPEND pages (not reorder / not replace) · **[med]**
- [ ] Touch reorder in Kelola Halaman (HTML5 DnD doesn't fire on touch) — pointer-drag OR move buttons; reuse for the sidebar · **[low]**

## Wave 5 — Growth loop
_Small, high-emotion. Delight + sustainability. (Runs early for momentum.)_

- [ ] Micro-celebration on every successful download — hook the `downloadBlob()` chokepoint; respect `prefers-reduced-motion` · **[low]**
- [ ] Donate-or-share prompt right after the celebration — inline QR (no page nav) + Web Share; frequency-capped, dismissible, "jangan tampilkan lagi" · **[med]**

## Wave 2 — Performance & mobile-canvas  ⚑ measure-first
_ONE root cause (no-eviction memory pressure). The audit + windowed rendering
**subsume** the two mobile-render bugs below — same layer, one fix._

- [ ] Performance audit on a real 50+ page doc on a phone — live-canvas count×bytes, scroll/pinch memory, render vs cache-restore timings. Read `memory/mobile-rendering.md` first · **[high]**
- [ ] → Viewport-windowed "3-nearest" rendering (swap distant pages to a decoded cached bitmap, no async blank gap)
- [ ] …closes: Pinch-zoom flicker · **[high]**
- [ ] …closes: Mobile fast-scroll jump-to-page-1 · **[high]**

## Wave 3 — Code-health audit → fix sprint  ⚑ measure-first
_Do before the big consolidation so it lands on cleaner ground._

- [ ] Measure + report: complexity, semantic drift, SSOT integrity, parallel-array liabilities, dead code (cross-check SonarCloud). Read cited code before reporting (audit false-positive rate). Then a scoped fix sprint · **[med]**

## Wave 4 — Consolidate into the Unified Editor  🎯 north star · 🔒 gated
_Biggest bet. Endgame: homepage is "drop anything → UE," every operation is an
in-editor action. Each sub-step is independently shippable._

- [ ] **4.0 DECISION with user** (blocks 4.4): does a bare image open an *image-editing context* in the UE (crop/resize/convert/remove-bg/compress, download as image OR add as page), or do image ops become per-page/export actions? UE goes format-aware either way.
- [ ] 4.1 Protect + Compress + **mixed-page-size normalization** → Download-dialog options (smallest; Protect already half-there)
- [ ] 4.2 PDF-to-Image → UE "Download as image(s)" action
- [ ] 4.3 Image→PDF → merge into the add-image path
- [ ] 4.4 Image editing (resize / convert / remove-bg / compress) → format-aware UE _(the big one)_
- [ ] 4.5 Strip homepage tool cards + delete dead standalone modules (barrels / window bridges / changelog)

---

## Cross-cutting / ongoing
- Roll out the real-flow filechooser test pattern to remaining picker/dropzone flows as they're touched.
- Keep `backlog.md` as the SSOT of findings; this roadmap sequences them.

## Done (Jul 1)
- Kelola Halaman modal redesign (#73)
- Text format bar + click-away commit fix (#72)
- Mobile toolbar overlap fix · Ganti File stale-cache crit fix
- Changelog refreshed (text formatting + Paraf)
- Merged #69/#70/#71 → clean main; Sentry checked
- _(older history in [roadmap-1.md](roadmap-1.md))_
