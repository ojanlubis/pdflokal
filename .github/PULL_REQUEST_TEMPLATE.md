## What does this PR do?

<!-- Brief description of the change. Link to issue if applicable: Fixes #123 -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactoring (no behavior change)
- [ ] Documentation
- [ ] Other: <!-- describe -->

## Checklist

### Required

- [ ] **100% client-side** — no server calls, no external APIs with user data
- [ ] **UI text in Indonesian** — informal "kamu" tone, not "anda"
- [ ] **No new dependencies** added (or justified why one is needed)
- [ ] Tested with `npx serve` + hard refresh (Ctrl+Shift+R)
- [ ] No console errors in browser DevTools

### If you changed JS modules

- [ ] New exports added to barrel `index.js`
- [ ] `window.*` bridge added (if function is used in HTML `onclick`)
- [ ] Used SSOT helpers where applicable:
  - [ ] `createPageInfo()` for page objects
  - [ ] `create*Annotation()` factories for annotations
  - [ ] `openModal()` / `closeModal()` for modal open/close
  - [ ] `isPDF()` / `isImage()` for file type checks
  - [ ] `loadPdfDocument()` instead of raw `pdfjsLib.getDocument()`
- [ ] New state fields added to `getDefaultUeState()` (if applicable)

### If you changed UI/layout

- [ ] Tested on desktop (>900px)
- [ ] Tested on mobile (<=900px)
- [ ] Modals have `role="dialog" aria-modal="true" aria-label="..."`
- [ ] Interactive elements have keyboard support

### Testing done

<!-- Describe what you tested. Be specific about browsers and devices. -->

## Screenshots / recordings (if UI change)

<!-- Paste before/after screenshots or screen recordings -->

---

<details>
<summary>AI contributor notes</summary>

If you used an AI assistant (Claude, ChatGPT, Copilot, etc.) to help with this PR:

- **AI tool used:** <!-- e.g., Claude Code, GitHub Copilot -->
- **What the AI did:** <!-- e.g., "wrote the implementation", "helped debug", "reviewed code" -->
- **Human review:** <!-- e.g., "I reviewed all changes", "maintainer will review" -->

This is encouraged! We just want transparency.

</details>
