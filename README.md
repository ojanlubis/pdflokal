# PDFLokal

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/ojanlubis/pdflokal)](https://github.com/ojanlubis/pdflokal/stargazers)
[![Client-Side Only](https://img.shields.io/badge/Privacy-100%25%20Client--Side-brightgreen.svg)](https://www.pdflokal.id/privasi.html)
[![Security Headers](https://img.shields.io/badge/Security-Headers%20Enabled-green.svg)](https://www.pdflokal.id/.well-known/security.txt)
[![AI Contributions Welcome](https://img.shields.io/badge/AI-Contributions%20Welcome-blueviolet.svg)](CONTRIBUTING.md)

> **Urus dokumen langsung di browser.** Cepat, gratis, file tidak pernah diupload.

PDFLokal adalah tool PDF gratis untuk pengguna Indonesia. Semua proses berjalan di browser - file tidak pernah meninggalkan perangkatmu.

**[Buka PDFLokal](https://www.pdflokal.id/)**

## Update Terbaru

**Juli 2026:**
- **Edit teks asli (beta)** — tap a printed line in a PDF and rewrite it. The original glyphs are cut from the content stream and the replacement is stamped back in the document's own embedded font when it can be proven to cover the text, otherwise a metric-identical clone (Carlito/Arimo/Tinos/Cousine/Caladea). No white box, no mismatched font, and nothing is uploaded
- **Editor is the landing page** — `index.html` IS the editor's empty state; drop a file and you're already working
- **Installable PWA** — works offline from a cold launch
- **12 SEO pages** for the specific jobs people actually search for
- **First-party telemetry** — a typed, content-blind event rail (no file data, ever) so the product can see what breaks in the wild
- **Contextual text format bar** — pick font, bold/italic, size, and color while typing
- **Mobile editor polish** — fixed toolbar overlap and Ganti File render bugs

**Mei 2026:**
- **Paraf (initials)** — dedicated draw-and-place tool with "Semua Hal." to stamp every page at once
- **UX pass** — Escape closes overlays, inline text on first click, signature draw-by-default

**Maret 2026:**
- **Zero CDN dependencies** — every library self-hosted, works fully offline
- **Reactive state layer** — pub/sub event emitter + `PageRenderer` render pipeline
- **Quality tooling** — ESLint flat config + CI, SonarCloud analysis
- **Mobile rendering fixes** — removed canvas eviction (persistent render, no white-flash flicker)

**Februari 2026:**
- **Editor UI redesign** — floating toolbar, compact sidebar, bottom bar, mobile-optimized layout
- **Lazy page rendering** — instant thumbnails on load, full rendering via IntersectionObserver
- **Pinch-to-zoom** on mobile
- **Inline text editing** — double-click text annotations to edit in-place
- **SSOT architecture** — centralized helpers for annotations, modals, file types, PDF loading
- **Accessibility** — ARIA roles, focus traps, keyboard navigation for all modals and tools
- **Performance** — PDF.js Web Worker, image registry for undo optimization

**Januari 2026:**
- Security headers (CSP, X-Frame-Options)
- Halaman privasi lengkap
- Offline mode dengan self-hosted libraries
- Modular ES module architecture
- Self-hosted fonts untuk restricted networks

## Fitur

### PDF Tools
- **Editor PDF** — Unified editor with whiteout, text (9 fonts, bold/italic, color), signatures (upload with background removal, draw, place → Konfirmasi to lock, double-click to unlock), paraf/initials, watermark, page numbers, password protection
- **Edit teks asli** (beta) — edit the text already printed in the PDF, in place, in the document's own font
- **Kelola Halaman** — reorder, rotate, delete, and split pages
- **Tema gelap / terang** — Theme toggle stored per-device
- **Gabung PDF** — Merge multiple PDFs and images with drag-drop reordering
- **Split PDF** — Extract selected pages as a separate PDF
- **Kompres PDF** — Reduce file size by compressing embedded images
- **PDF ke Gambar** — Export pages as PNG/JPG with batch download
- **Proteksi PDF** — Add password protection

### Image Tools
- **Kompres Gambar** — Reduce file size with quality control
- **Ubah Ukuran** — Resize with locked aspect ratio
- **Convert Format** — JPG, PNG, WebP
- **Gambar ke PDF** — Combine images into a single PDF
- **Hapus Background** — Remove white backgrounds for transparent PNG

## Privasi

- **100% Client-side** — All file processing happens in the browser
- **No uploads** — Files never leave your device
- **Open source** — Code can be inspected by anyone
- **Security headers** — CSP, X-Frame-Options, and more ([details](docs/security.md))

The one exception, stated plainly: PDFLokal sends **anonymous, typed usage events** (which tool was
used, how long an export took, what device class) to its own endpoint — never file contents, and the
schema physically has no field that could carry them. The beta Edit feature can also send a small
image crop of a single edited line, but **only** if you rate it 👎, see the exact crop, and tap Kirim.
Full detail in [privasi.html](privasi.html).

## Cara Pakai

1. Buka [pdflokal.id](https://www.pdflokal.id/)
2. Pilih tool yang dibutuhkan atau drag & drop file PDF
3. Proses dan download hasilnya

Tidak perlu install, tidak perlu daftar, tidak perlu bayar.

## Development

### Run Locally
```bash
git clone https://github.com/ojanlubis/pdflokal
cd pdflokal
npx serve .
# Open http://localhost:3000
# Always hard refresh (Ctrl+Shift+R) after changes — npx serve caches aggressively
```

### Tech Stack
- **Vanilla JS** — Native ES modules, no build step, no framework
- **Zero CDN** — every library below is self-hosted; the app runs fully offline
- **[pdf-lib](https://pdf-lib.js.org/)** — PDF manipulation (self-hosted)
- **[PDF.js](https://mozilla.github.io/pdf.js/)** — PDF rendering with Web Worker (self-hosted)
- **[Signature Pad](https://github.com/szimek/signature_pad)** — Digital signatures (self-hosted)
- **[fontkit](https://github.com/foliojs/fontkit)** — Reads a PDF's own embedded font program (glyph coverage, weight, PANOSE) and embeds fonts into exports (self-hosted)
- **[pdf-encrypt-lite](https://github.com/nicholasohjj/pdf-encrypt-lite)** — PDF password encryption (self-hosted)
- **Canvas API** — Image processing
- **Self-hosted fonts** — UI font Plus Jakarta Sans + annotation fonts Montserrat, Carlito, and the metric-compatible Croscore set (Arimo/Tinos/Cousine/Caladea — stand-ins for Arial/Times/Courier/Cambria when a document's own font can't be reused)

### Project Structure
```
pdflokal/
├── index.html              # Editor v2 — the landing page IS the editor's empty state
├── alat-gambar.html        # the OLD wing (image tools only), noindexed, awaiting demolition
├── CLAUDE.md               # Technical reference for AI and developers
├── CONTRIBUTING.md         # Contribution guide
├── js/
│   ├── core/               # headless engine — no DOM, unit-tested via `npm run test:core`
│   │   ├── model.js  operations.js  history.js  import.js  export.js
│   │   ├── text-walk.js    # content-stream interpreter: find + cut the original glyphs
│   │   ├── stamp.js        # the write path: resolve a font, let pdf-lib lay the text out
│   │   ├── doc-fonts.js  font-style.js  font-fingerprint.js  font-decide.js
│   │   ├── page-surgery.js # cut + stamp, per page
│   │   └── visual-oracle.js  telemetry-schema.js
│   ├── render/             # page-view, viewport, interaction (pages are <img>, one overlay)
│   ├── v2/                 # app shell — app.js, download-sheet, page-manager, telemetry
│   ├── lib/                # state, utils, navigation (shared with the old wing)
│   ├── editor/  pdf-tools/ # the OLD wing's modules — die at demolition
│   └── vendor/             # self-hosted libraries (2.6 MB), zero CDN
├── api/                    # the only server code: content-blind telemetry + feedback
├── tests/                  # Playwright specs + core/ unit tests + fixtures/nasty/
├── seo/                    # pages.json — the SEO generator's source of truth
├── fonts/                  # self-hosted fonts
├── docs/                   # current docs (legacy/ holds the old wing's, clearly marked)
└── images/                 # UI assets
```

**For detailed architecture, conventions, and SSOT patterns, see [`CLAUDE.md`](CLAUDE.md).**

## Kontribusi

Contributions are welcome from humans and AI assistants! See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

Quick summary:
1. **Report bugs** — use the [bug report template](https://github.com/ojanlubis/pdflokal/issues/new?template=bug_report.yml)
2. **Request features** — use the [feature request template](https://github.com/ojanlubis/pdflokal/issues/new?template=feature_request.yml)
3. **Submit PRs** — fork, branch, follow [CONTRIBUTING.md](CONTRIBUTING.md), submit

### For AI Contributors

Point your AI assistant to `CLAUDE.md` — it contains everything needed to understand the codebase: architecture, patterns, helpers, gotchas, and conventions. The issue templates are structured (YAML forms) for easy parsing.

## Field Notes

Some of the real bugs in this repo's history are written up as field notes: the commit, the investigation, and the lesson behind it. If you want the story behind a fix, not just the diff:

- [When AI-Built Software Breaks](https://mesindev.com/notes) — field notes on cleaning up AI-generated code, drawn from this repo's git history
- [The tool that passed every test and was quietly broken](https://mesindev.com/notes/ai-code-passed-every-test) — the Ganti File blank-render bug: the guess ([bb7470e](https://github.com/ojanlubis/pdflokal/commit/bb7470e)) logged, then confirmed weeks later ([80a5016](https://github.com/ojanlubis/pdflokal/commit/80a5016))

## Limitasi

1. **Kompres PDF** — Only compresses images inside PDFs, not PDF structure itself
2. **File besar** — Files >50MB may be slow on some devices
3. **PDF kompleks** — Some encrypted PDFs or PDFs with special fonts may not work
4. **Browser lama** — Requires a modern browser with ES6+ support

### Yang tidak akan kami buat (dan kenapa)

- **PDF ↔ Word / Excel** — needs a server to do properly, and a server breaks the one promise this
  project is built on: your file never leaves your device. Declined permanently, not "coming soon."
- **OCR di server** — same reason, same answer.

**OCR in the browser is a different thing and it is planned** — running locally (WASM/WebGPU),
nothing uploaded. Roughly half of all documents opened here are scans with no text layer, so this
is the other half of the product, not a footnote.

## Lisensi & Commercial Use

PDFLokal is open source under [AGPL-3.0](LICENSE).

**Allowed:**
- Learning and education
- Self-hosting for internal/personal use
- Contributing improvements back

**Commercial derivatives or rebranding:**
- Must attribute PDFLokal clearly
- Link to original repo: github.com/ojanlubis/pdflokal
- Modified source code must remain open source (AGPL-3.0 requirement)
- Web services running modified versions must provide source code access

Questions about commercial use? Open a GitHub issue.

## Contributors

Terima kasih kepada semua yang telah berkontribusi:

- [@hamdi1611](https://github.com/hamdi1611) — Signature UX improvements

## Credits

- [pdf-lib](https://pdf-lib.js.org/) by Andrew Dillon
- [PDF.js](https://mozilla.github.io/pdf.js/) by Mozilla
- [Signature Pad](https://github.com/szimek/signature_pad) by Szymon Nowak
- Inspired by [iLovePDF](https://www.ilovepdf.com/), [Smallpdf](https://smallpdf.com/), and [Squoosh](https://squoosh.app/)

---

**Made with love in Indonesia**
