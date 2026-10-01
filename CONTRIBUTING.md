# Contributing to PDFLokal

PDFLokal welcomes contributions from humans and AI assistants alike. This guide helps you (or your AI) get started quickly.

## Quick Start

```bash
git clone https://github.com/ojanlubis/pdflokal
cd pdflokal
npx serve .
# Open http://localhost:3000, always hard refresh (Ctrl+Shift+R) after changes
```

## For AI Assistants

**Read `CLAUDE.md` first.** It's the authoritative technical reference — architecture, conventions, helpers, gotchas, everything. This file (`CONTRIBUTING.md`) covers process; `CLAUDE.md` covers code.

Key points for AI contributors:
- **Vanilla JS, native ES modules, no build step, no frameworks**
- **All UI text in Indonesian** (informal "kamu" tone)
- **100% client-side** — files never leave the user's device
- Test with `npx serve` + Ctrl+Shift+R (aggressive caching)

## Project Constraints

These are non-negotiable:

| Rule | Why |
|------|-----|
| 100% client-side | Privacy promise to users. Files never leave their device. |
| No npm/build step | Zero barrier to contribute. Clone and open. |
| Indonesian UI text | Target audience is Indonesian users. "kamu" not "anda". |
| Vanilla JS (ES6+) | No frameworks. Native ES modules. |
| No new dependencies | Unless absolutely necessary and approved by maintainer. |

## How to Contribute

### Reporting Bugs

Use the [bug report template](https://github.com/ojanlubis/pdflokal/issues/new?template=bug_report.yml). Include:
- Which tool/feature
- Steps to reproduce
- Browser and device
- Console errors (F12 > Console)

### Suggesting Features

Use the [feature request template](https://github.com/ojanlubis/pdflokal/issues/new?template=feature_request.yml). Features must be client-side. Server-dependent features (PDF-to-Word, server-side OCR) are out of scope. In-browser OCR is in scope and already live.

### Pull Requests

1. **Fork** the repository
2. **Create a branch** from `main` (`git checkout -b fix/description`)
3. **Make changes** following the guidelines below
4. **Test** on desktop and mobile browsers
5. **Submit PR** using the PR template

### What Makes a Good PR

- **Small and focused** — one fix or feature per PR
- **Tested** — describe what you tested in the PR
- **Follows conventions** — read `CLAUDE.md` for patterns
- **No scope creep** — don't refactor unrelated code

## Testing

```bash
npm ci
npm run lint && npm run test:core   # fast, headless
npm run gate                        # the full sweep CI runs: lint, seo:check, core, Playwright
```

## AI-Assisted Contributions

We actively welcome AI-assisted contributions. If you're using Claude, ChatGPT, Copilot, or any AI tool:

- **Point your AI to `CLAUDE.md`** — it contains everything needed to understand the codebase
- **Mention AI usage in your PR** — we have a section in the PR template for this
- **Human review is still expected** — either by you or the maintainer
- **The AI can read issues directly** — our templates are structured for easy parsing

## Code Style

- **Semicolons** (existing codebase convention)
- **Single quotes** for strings in JS
- **2-space indentation**
- **No TypeScript** — vanilla JS only
- **Comments** — only where logic isn't self-evident. No JSDoc for obvious functions.
- **Indonesian for UI text**, English for code/comments/commit messages

## Commit Messages

Follow [conventional commits](https://www.conventionalcommits.org/):

```
feat: add crop tool to editor
fix: whiteout not rendering on page 2
refactor: extract modal helpers to navigation.js
docs: update CLAUDE.md with new patterns
```

## License

By contributing, you agree that your contributions will be licensed under the [AGPL-3.0 License](LICENSE).

## Questions?

Open an issue or check existing ones. We're friendly!
