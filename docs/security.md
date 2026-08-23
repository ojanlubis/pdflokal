# PDFLokal Security & Libraries Reference

Detailed security configuration and library documentation. See [CLAUDE.md](../CLAUDE.md) for project overview.

## Privacy Requirements

- **Files must NEVER leave the user's device** — the invariant everything else serves. Unchanged.
- No external API calls with user data
- Open source = users can verify privacy claims
- **Analytics are anonymous and content-blind, not consent-gated** _(corrected 2026-07-27 — this
  line previously read "no analytics or tracking without explicit user consent," which the product
  has not matched since GA4 shipped; a requirements doc that states a rule the code doesn't follow
  is worse than no doc)._ What actually runs: GA4 for **acquisition only** (how people arrive), and
  a first-party typed rail for **behavior**. Neither carries file contents or a persistent user id.
  The one consent-gated exception is the beta Edit image crop, below.

## Server surface (added 2026-07 — keep this honest)

All *file processing* is client-side, but the app is no longer purely static. Two serverless
endpoints are the only code that runs off-device, and neither ever receives a PDF:

- **`api/t.js`** — typed, content-blind telemetry. Every event is validated against
  `js/core/telemetry-schema.js` and **dropped if off-schema**. The schema has no free-string field,
  so it cannot carry document content even by accident. Always answers 204, so it never reveals
  whether a write happened. Writes to **Neon** (Postgres, `DATABASE_URL` held only in env) since
  2026-08-23 — previously Supabase. The database has **no HTTP front door at all**: no PostgREST, no
  Data API, no anon role. The only credential is the connection string, and only these two functions
  hold it.
- **`api/feedback.js`** — the beta Edit 👍/👎, plus an **opt-in** image crop of the one edited line.
  Sent only when the user rates 👎, *sees the exact crops*, and taps Kirim. Size-capped client-side,
  re-checked server-side (never trust the client), and constrained again by DB check constraints.

Both **fail closed**: if their env vars are absent the endpoint 204s and writes nothing. That
property is load-bearing and also a trap — it silently swallowed a week of preview telemetry in
July 2026 before anyone noticed. Verify the rail by querying for rows, never by a 2xx response.

## Security Headers (vercel.json)

| Header | Value | Purpose |
|--------|-------|---------|
| X-Content-Type-Options | nosniff | Prevent MIME-type sniffing |
| X-Frame-Options | DENY | Prevent clickjacking |
| X-XSS-Protection | 1; mode=block | XSS filter (legacy browsers) |
| Referrer-Policy | strict-origin-when-cross-origin | Limit referrer info |
| Permissions-Policy | camera=(), microphone=(), geolocation=(), payment=() | Disable unused APIs |
| Content-Security-Policy | (see below) | Control resource loading |

## Content Security Policy (CSP)

⚠️ **This block is a COPY of the live policy in `vercel.json`, and it has drifted before.** Until
2026-07-30 it showed `'unsafe-eval'`, which the live policy has never had. A security document that
overstates what is permitted is the dangerous direction: it tells you a capability works when the
browser will refuse it. `tests/core/csp-doc-parity.test.mjs` fails if this copy and `vercel.json`
disagree, so that drift cannot come back silently.

**`vercel.json` is the source of truth. This is documentation of it.**

**2026-07-30 — two directives added for OCR** (ruled by Fauzan, security assessment by the PM,
recorded in the seat's `decisions.md`):

- **`script-src 'wasm-unsafe-eval'`** — WebAssembly cannot compile without it. It does NOT grant
  `eval()`; that is asserted by a real in-page test, not assumed, because the names are similar
  enough to be mistaken for each other.
- **`worker-src blob:`** — tesseract.js builds its worker from a Blob URL. **`'self'` is retained
  and must stay.** Dropping it would kill the service worker, and therefore offline mode, and
  therefore a shipped and announced feature, with nothing throwing and the page looking fine.

**2026-08-23 — a third directive, found in PRODUCTION after rung S2 shipped** (ruled by Fauzan the
same day, same shape as the two above):

- **`connect-src data:`** — tesseract's core is an emscripten SINGLE_FILE build: it carries the WASM
  binary inline as base64 and fetches it back as a `data:` URI. Without this, every recognition
  logged two errors, **the library fell back, and OCR worked anyway** — right text, right boxes,
  green suite. A fallback that succeeds is indistinguishable from a path that was never blocked,
  which is how it shipped.
  **Security note:** a `data:` URL is self-contained and addresses nothing, so this opens no channel
  for data to leave the device and does not touch the privacy claim. `img-src` has carried `data:`
  since long before this, for the same reason.

⚠️ **AND THE INSTRUMENT LESSON, which outlives this directive.** The violation happened inside the
TESSERACT WORKER, and **Playwright's `page.on('console')` does not carry worker messages** — nor does
a document-level `securitypolicyviolation` listener. Both reported zero on a page Chromium was
logging two errors on, and a first version of the guard was written, passed, and deleted for passing
that way. The working instrument is a CDP session: `Log.enable` + `Log.entryAdded`, where the entries
arrive tagged `source: 'worker'` (`tests/csp-live-policy.spec.js`). **Every worker this product runs
— Tesseract, pdf.js, the service worker — is invisible to the page console. Any "no errors" claim
about worker code needs the CDP instrument, not that one.**

```
default-src 'self';
script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline' https://www.googletagmanager.com https://googleads.g.doubleclick.net blob:;
worker-src 'self' blob:;
manifest-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https://www.google.com https://www.google.co.id https://www.googleadservices.com https://googleads.g.doubleclick.net;
font-src 'self';
connect-src 'self' data: https://www.google-analytics.com https://analytics.google.com https://www.googletagmanager.com https://www.google.com;
frame-ancestors 'none';
base-uri 'self';
form-action 'self';
object-src 'none';
```

**Why 'unsafe-inline' and 'unsafe-eval':**
- `'unsafe-inline'` for scripts: Required for theme flash prevention, JSON-LD schema, Vercel analytics init, pdfjsLib config
- `'unsafe-eval'`: Required by PDF.js and fontkit libraries for dynamic code execution
- `'unsafe-inline'` for styles: Inline styles in HTML and dynamic style manipulation
- Nonces would require server-side rendering or build step (against project philosophy)

**Why Google domains:** Vercel Web Analytics + Google Analytics (GA4) for anonymous usage tracking. No personal data collected — only tool names, action types, and per-session IDs. See `js/lib/analytics.js`.

**If adding new features that require external resources:**
1. Test on Vercel preview first
2. Check browser console for CSP violations — **and if the feature uses a worker, check CDP's Log
   domain too, because the page console cannot see worker violations** (see the 2026-08-23 note above)
3. Update CSP in vercel.json if needed. `tests/core/csp-doc-parity.test.mjs` fails if this document
   and `vercel.json` disagree, so the two cannot drift silently.

## Security Files

| File | URL | Purpose |
|------|-----|---------|
| security.txt | /.well-known/security.txt | Security contact for vulnerability reports |
| humans.txt | /humans.txt | Team and contributor credits |
| privasi.html | /privasi.html | Privacy policy in Indonesian |

The `security.txt` file is served at `/.well-known/security.txt` via a rewrite rule in `vercel.json`.

## Self-Hosted Libraries (2.6 MB total)

Core libraries are self-hosted in `/js/vendor/` for offline support, firewall compatibility, and no CDN dependencies.

| Library | Version | Size | Purpose |
|---------|---------|------|---------|
| **pdf-lib** | 1.17.1 | 513 KB | PDF manipulation (merge, split, edit, etc.) |
| **fontkit** | 1.1.1 | 741 KB | Custom font embedding for pdf-lib |
| **PDF.js** | 3.11.174 | 313 KB | PDF rendering and thumbnails |
| **PDF.js Worker** | 3.11.174 | 1.1 MB | PDF processing (loaded before pdf.min.js for offline fake worker) |
| **Signature Pad** | 4.1.7 | 12 KB | Digital signature capture |
| **pdf-encrypt-lite** | 1.0.1 | ~12 KB | PDF password encryption (self-hosted, patched to use `window.PDFLib`) |
| **fflate** | 0.8.3 | 33 KB | ZIP bundling for pages→images export (Editor v2 Unduh sheet) |

**Library Loading Order** (in index.html):
```html
<script src="js/vendor/pdf-lib.min.js"></script>
<script src="js/vendor/fontkit.umd.min.js"></script>
<script src="js/vendor/pdf.worker.min.js"></script>  <!-- BEFORE pdf.min.js! -->
<script src="js/vendor/pdf.min.js"></script>
<script>pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/vendor/pdf.worker.min.js';</script>
<script src="js/vendor/signature_pad.umd.min.js"></script>
```

**Note:** `workerSrc` points to the self-hosted worker file for real Web Worker support. PDF.js falls back to a fake (main-thread) worker if the file is unavailable offline.

**pdf-encrypt-lite is self-hosted** as of Mar 2026: patched to use `window.PDFLib` instead of ESM imports. Imported as ES module from `./js/vendor/pdf-encrypt-lite.min.js` via inline `<script type="module">` in index.html.

## Self-Hosted Fonts (268KB total, Latin charset)

All fonts in `/fonts/` for offline + privacy. Loaded via `@font-face` in `style.css` for UI, fetched as ArrayBuffer for PDF embedding via `getFont()` in `pdf-export.js`.

- **Montserrat** (4 variants) - 77KB
- **Carlito** (4 variants) - 122KB (open-source Calibri alternative)
- **Plus Jakarta Sans** (4 weights) - 49KB (UI only)
- **Standard PDF fonts**: Helvetica, Times-Roman, Courier (built into pdf-lib)

Font mapping: `CSS_FONT_MAP` constant in `js/lib/state.js`. fontkit registered with PDFDocument for custom font support.
