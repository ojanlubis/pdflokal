# PDFLokal security — what the config files can't say

`vercel.json` holds the headers and the CSP; `index.html` holds the load order; `js/vendor/` holds the
libraries. This file holds only the why and the traps. See [CLAUDE.md](../CLAUDE.md) for the rest.

## Privacy Requirements

- **Files must NEVER leave the user's device** — the invariant everything else serves. Unchanged.
- No external API calls with user data
- Open source = users can verify privacy claims
- **Analytics are anonymous and content-blind, not consent-gated.** What actually runs: GA4 for **acquisition only** (how people arrive), and
  a first-party typed rail for **behavior**. Neither carries file contents or a persistent user id.
  The one consent-gated exception is the beta Edit image crop, below.

## Server surface

All *file processing* is client-side. `api/` is the only code that runs off-device (each file's
header says what it is); none of it ever receives a PDF. The two that take user-originated data:

- **`api/t.js`** — typed, content-blind telemetry. Every event is validated against
  `js/core/telemetry-schema.js` and **dropped if off-schema**. The schema has no free-string field,
  so it cannot carry document content even by accident. Always answers 204, so it never reveals
  whether a write happened. Writes to **Turso** only (`api/_turso.js`, plain `fetch`, no driver);
  the credentials are `TURSO_EVENTS_*` / `TURSO_FEEDBACK_*` in env, held only by `api/`.
- **`api/feedback.js`** — the beta Edit 👍/👎, plus an **opt-in** image crop of the one edited line.
  Sent only when the user rates 👎, *sees the exact crops*, and taps Kirim. Size-capped client-side,
  re-checked server-side (never trust the client), and constrained again by table CHECK constraints
  (`scripts/turso-feedback-migration.sql`).

Both **fail closed**: if their env vars are absent the endpoint 204s and writes nothing. That
property is load-bearing and also a trap — it silently swallowed a week of preview telemetry in
July 2026 before anyone noticed. Verify the rail by querying for rows, never by a 2xx response.

## Content Security Policy (CSP)

**`vercel.json` holds the policy, and this document does not copy it** — a copy once drifted to show
an `'unsafe-eval'` the live policy never had. What must stay true of the policy is pinned by
`tests/core/csp-policy.test.mjs`. Below: why the non-obvious directives exist.

**Two directives for OCR** (ruled by Fauzan 2026-07-30, seat `decisions.md`):

- **`script-src 'wasm-unsafe-eval'`** — WebAssembly cannot compile without it. It does NOT grant
  `eval()`; that is asserted by a real in-page test, not assumed, because the names are similar
  enough to be mistaken for each other.
- **`worker-src blob:`** — tesseract.js builds its worker from a Blob URL. **`'self'` is retained
  and must stay.** Dropping it would kill the service worker, and therefore offline mode, and
  therefore a shipped and announced feature, with nothing throwing and the page looking fine.

**A third for OCR, found in production** (ruled 2026-08-23):

- **`connect-src data:`** — tesseract's core is an emscripten SINGLE_FILE build: it carries the WASM
  binary inline as base64 and fetches it back as a `data:` URI. Without this, every recognition
  logged two errors, **the library fell back, and OCR worked anyway** — right text, right boxes,
  green suite. A fallback that succeeds is indistinguishable from a path that was never blocked,
  which is how it shipped.
  **Security note:** a `data:` URL is self-contained and addresses nothing, so this opens no channel
  for data to leave the device and does not touch the privacy claim. `img-src` has carried `data:`
  since long before this, for the same reason.

**Two hosts for the one-month Mixpanel session-replay study** (seat `decisions.md` 2026-09-10).
**BOTH COME OUT WHEN THE STUDY ENDS, 2026-10-10.**

- **`script-src https://cdn.mxpnl.com`** — the Mixpanel loader snippet in `index.html`'s head
  fetches `mixpanel-2-latest.min.js` from there, and the SDK lazily fetches its rrweb-based
  recorder bundle from the same host. This is the FIRST CDN script in this product that is not
  Google's. It does not weaken the "all vendor libs self-hosted, zero CDN" rule, which is about
  the libraries that touch the user's document (pdf-lib, PDF.js, tesseract) — but it is the
  closest anything has come, and it is temporary for that reason.
- **`connect-src https://api-js.mixpanel.com https://api.mixpanel.com`** — where events and replay
  payloads go. Both are listed because the SDK's default host has moved between versions and a
  pinned-to-latest bundle may change it under us; a wrong single host fails SILENTLY under CSP.
  ⚠️ **This is the only directive in this policy that lets user-derived data leave the device**,
  which is why what may ride it is nailed down in `index.html`'s own comment and enforced by
  `tests/mixpanel-replay-privacy.spec.js`: no filename, no typed text, no document pixels.
  The recording carries pdflokal's own static chrome in plain text (`record_unmask_text_selector`,
  an allowlist over deny-by-default masking); the same spec checks that no allowlist entry is an
  ancestor of a node carrying a filename, typed text or a document-derived number.

⚠️ **AND THE INSTRUMENT LESSON, which outlives this directive.** The violation happened inside the
TESSERACT WORKER, and **Playwright's `page.on('console')` does not carry worker messages** — nor does
a document-level `securitypolicyviolation` listener. Both reported zero on a page Chromium was
logging two errors on, and a first version of the guard was written, passed, and deleted for passing
that way. The working instrument is a CDP session: `Log.enable` + `Log.entryAdded`, where the entries
arrive tagged `source: 'worker'` (`tests/csp-live-policy.spec.js`). **Every worker this product runs
— Tesseract, pdf.js, the service worker — is invisible to the page console. Any "no errors" claim
about worker code needs the CDP instrument, not that one.**

**Why 'unsafe-inline':**
- for scripts: the inline theme-flash guard, JSON-LD, and the analytics loaders in `index.html`'s head
- for styles: Inline styles in HTML and dynamic style manipulation
- Nonces would require server-side rendering or build step (against project philosophy)

**Why Google domains:** GA4 (and the Ads tag) for acquisition. See `js/lib/analytics.js`.

**If adding new features that require external resources:**
1. Test on Vercel preview first
2. Check browser console for CSP violations — **and if the feature uses a worker, check CDP's Log
   domain too, because the page console cannot see worker violations** (above)
3. Update CSP in vercel.json if needed. `tests/core/csp-policy.test.mjs` pins what must stay true of
   it (no full `'unsafe-eval'`, `worker-src` keeps `'self'` for offline).

`security.txt` is served at `/.well-known/security.txt` via a rewrite in `vercel.json`.
