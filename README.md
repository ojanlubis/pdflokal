# PDFLokal

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/ojanlubis/pdflokal)](https://github.com/ojanlubis/pdflokal/stargazers)
[![Client-Side Only](https://img.shields.io/badge/Privacy-100%25%20Client--Side-brightgreen.svg)](https://www.pdflokal.id/privasi.html)
[![Security Headers](https://img.shields.io/badge/Security-Headers%20Enabled-green.svg)](https://www.pdflokal.id/.well-known/security.txt)
[![AI Contributions Welcome](https://img.shields.io/badge/AI-Contributions%20Welcome-blueviolet.svg)](CONTRIBUTING.md)

> **Urus dokumen langsung di browser.** Cepat, gratis, file tidak pernah diupload.

PDFLokal adalah tool PDF gratis untuk pengguna Indonesia. Semua proses berjalan di browser - file tidak pernah meninggalkan perangkat Anda.

**[Buka PDFLokal](https://www.pdflokal.id/)**

## Update Terbaru

**Februari 2026:**
- **Editor UI redesign** — floating toolbar, compact sidebar, bottom bar, mobile-optimized layout
- **Paraf (initials)** — draw and place initials with "Semua Hal." button to apply to all pages
- **Lazy page rendering** — instant thumbnails on load, full rendering via IntersectionObserver
- **Pinch-to-zoom** on mobile
- **Inline text editing** — double-click text annotations to edit in-place
- **SSOT architecture** — centralized helpers for annotations, modals, file types, PDF loading
- **Accessibility** — ARIA roles, focus traps, keyboard navigation for all modals and tools
- **Performance** — PDF.js Web Worker, image registry for undo optimization, page cache eviction

**Januari 2026:**
- Security headers (CSP, X-Frame-Options)
- Halaman privasi lengkap
- Offline mode dengan self-hosted libraries
- Modular ES module architecture
- Self-hosted fonts untuk restricted networks

## Fitur

### PDF Tools
- **Editor PDF** — Unified editor with whiteout, text (5 fonts, bold/italic, color), signatures (upload with background removal, draw, auto-lock, double-click to unlock), paraf/initials, watermark, page numbers, password protection
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

- **100% Client-side** — All processing happens in the browser
- **No uploads** — Files never leave your device
- **Open source** — Code can be inspected by anyone
- **Security headers** — CSP, X-Frame-Options, and more ([details](docs/security.md))

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
- **[pdf-lib](https://pdf-lib.js.org/)** — PDF manipulation (self-hosted)
- **[PDF.js](https://mozilla.github.io/pdf.js/)** — PDF rendering with Web Worker (self-hosted)
- **[Signature Pad](https://github.com/szimek/signature_pad)** — Digital signatures (self-hosted)
- **[fontkit](https://github.com/foliojs/fontkit)** — Custom font embedding (self-hosted)
- **[pdf-encrypt-lite](https://github.com/nicholasohjj/pdf-encrypt-lite)** — PDF password encryption (CDN)
- **Canvas API** — Image processing
- **Self-hosted fonts** — Montserrat, Carlito, Plus Jakarta Sans (268KB)

### Project Structure
```
pdflokal/
├── index.html              # Single-page application
├── style.css               # All styles
├── CLAUDE.md               # Technical reference for AI and developers
├── CONTRIBUTING.md          # Contribution guide
├── js/
│   ├── init.js             # Entry point (imports all modules)
│   ├── lib/
│   │   ├── state.js        # State, constants, annotation factories
│   │   ├── utils.js        # Helpers (toast, download, file type checks)
│   │   └── navigation.js   # Routing, modal helpers, history
│   ├── editor/             # Unified Editor (14 modules)
│   │   ├── index.js        # Barrel exports + window bridges
│   │   ├── canvas-events.js
│   │   ├── file-loading.js
│   │   ├── annotations.js
│   │   ├── signatures.js
│   │   ├── page-manager.js
│   │   ├── page-rendering.js
│   │   ├── pdf-export.js
│   │   └── ...
│   ├── pdf-tools/          # PDF tool modals (7 modules)
│   ├── image-tools.js      # Image processing tools
│   └── vendor/             # Self-hosted libraries (2.6 MB)
├── fonts/                  # Self-hosted fonts
├── docs/                   # Architecture and reference docs
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

## Limitasi

1. **Kompres PDF** — Only compresses images inside PDFs, not PDF structure itself
2. **File besar** — Files >50MB may be slow on some devices
3. **PDF kompleks** — Some encrypted PDFs or PDFs with special fonts may not work
4. **Browser lama** — Requires a modern browser with ES6+ support

### Fitur yang Butuh Server (Coming Soon)
- PDF ke Word / Excel
- Word / Excel ke PDF
- OCR (text recognition)

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
