# PDFLokal Security & Libraries Reference

Detailed security configuration and library documentation. See [CLAUDE.md](../CLAUDE.md) for project overview.

## Privacy Requirements

- Files must NEVER leave the user's device
- No analytics or tracking without explicit user consent
- No external API calls with user data
- Open source = users can verify privacy claims

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

```
default-src 'self';
script-src 'self' 'unsafe-inline' 'unsafe-eval' https://esm.sh blob:;
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self';
connect-src 'self' https://esm.sh;
frame-ancestors 'none';
base-uri 'self';
form-action 'self';
object-src 'none'
```

**Why 'unsafe-inline' and 'unsafe-eval':**
- `'unsafe-inline'` for scripts: Required for theme flash prevention, JSON-LD schema, Vercel analytics init, pdfjsLib config
- `'unsafe-eval'`: Required by PDF.js and fontkit libraries for dynamic code execution
- `'unsafe-inline'` for styles: Inline styles in HTML and dynamic style manipulation
- Nonces would require server-side rendering or build step (against project philosophy)

**If adding new features that require external resources:**
1. Test on Vercel preview first
2. Check browser console for CSP violations
3. Update CSP in vercel.json if needed

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
| **pdf-encrypt-lite** | 1.0.1 | ~12 KB | PDF password encryption (CDN: esm.sh, requires internet) |

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

**Why pdf-encrypt-lite stays on CDN:** ES module with complex dependency tree; only used for "Protect PDF" (optional); bundling would require build tooling.

## Self-Hosted Fonts (268KB total, Latin charset)

All fonts in `/fonts/` for offline + privacy. Loaded via `@font-face` in `style.css` for UI, fetched as ArrayBuffer for PDF embedding via `getFont()` in `pdf-export.js`.

- **Montserrat** (4 variants) - 77KB
- **Carlito** (4 variants) - 122KB (open-source Calibri alternative)
- **Plus Jakarta Sans** (4 weights) - 49KB (UI only)
- **Standard PDF fonts**: Helvetica, Times-Roman, Courier (built into pdf-lib)

Font mapping: `CSS_FONT_MAP` constant in `js/lib/state.js`. fontkit registered with PDFDocument for custom font support.
