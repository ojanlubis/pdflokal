# Roadmap 1

_Started: 2026-06-09 — Updated: 2026-06-09 (GA4 MCP wired)_

## In flight

- [~] Real-flow test pattern — filechooser-event pattern landed for the Ganti File flow (`tests/ganti-file.spec.js`). Roll the same pattern out to the remaining picker/dropzone flows as they get touched.

## This week

- [x] Ganti File fix — real-flow filechooser test (FAILED red → fix → green) → `clearPdfDocCache()` in `ueReset()` (not `ueReplaceFiles` — SSOT, covers every reset caller) → lint+smoke+visual green. **Still owes: real-Android-Chrome phone check before calling it fully shipped.**

## Next 1-2 weeks (pick by energy)

- [ ] Pinch-zoom flicker — CSS scale during gesture
- [ ] Scroll-jump-to-page-1 — investigate before fixing
- [ ] Paraf z-index
- [ ] Password field console warning — wrap in `<form>`

## Then the fork

After backlog cleared + Sentry quiet, choose:

- **A.** Start Phase 1 (image-on-import foundation rebuild)
- **B.** Pause and observe for a month

Decide on signal, not schedule.

---

## Done

- 2026-07-01 — Ganti File crit fixed — `clearPdfDocCache()` in `ueReset()` + real-flow filechooser regression test
- 2026-07-01 — Merged PRs #69, #70, #71 → clean main; Sentry checked (no regressions, 8/9 JS issues stale 24-29d)
- 2026-06-09 — Visual regression suite (PR #70)
- 2026-06-09 — AI exploratory pass on prod → Ganti File bug reproduced with evidence (backlog updated)
- 2026-06-09 — Branch cleanup (6 stale branches deleted)
- 2026-06-09 — Memory: feedback-loops-as-principle added
- 2026-06-09 — GA4 MCP rail wired (official Google `analytics-mcp` + service account, project-scoped)
