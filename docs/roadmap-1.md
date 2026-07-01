# Roadmap 1

_Started: 2026-06-09 — Updated: 2026-06-09 (GA4 MCP wired)_

## In flight

- [ ] Real-flow test pattern — replace `setInputFiles(hidden-input)` with Playwright filechooser-event pattern for picker / dropzone flows. Gates the next behavior-changing PRs.
- [ ] PR #69 — onclick sweep — merge when ready
- [ ] PR #70 — visual regression suite + backlog — run `npm run test:visual` locally then merge

## This week

- [ ] Ganti File fix — real-flow test FIRST → `clearPdfDocCache()` in `ueReplaceFiles()` → test green → phone check → ship

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

- 2026-06-09 — Visual regression suite (PR #70)
- 2026-06-09 — AI exploratory pass on prod → Ganti File bug reproduced with evidence (backlog updated)
- 2026-06-09 — Branch cleanup (6 stale branches deleted)
- 2026-06-09 — Memory: feedback-loops-as-principle added
- 2026-06-09 — GA4 MCP rail wired (official Google `analytics-mcp` + service account, project-scoped)
