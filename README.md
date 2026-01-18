# PDFLokal

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/ojanlubis/pdflokal)](https://github.com/ojanlubis/pdflokal/stargazers)
[![Client-Side Only](https://img.shields.io/badge/Privacy-100%25%20Client--Side-brightgreen.svg)](https://www.pdflokal.id/privasi.html)
[![Security Headers](https://img.shields.io/badge/Security-Headers%20Enabled-green.svg)](https://www.pdflokal.id/.well-known/security.txt)

> **Urus dokumen langsung di browser.** Cepat, gratis, file tidak pernah diupload.

PDFLokal adalah tool PDF gratis untuk pengguna Indonesia. Semua proses berjalan di browser - file tidak pernah meninggalkan perangkat Anda.

**[Buka PDFLokal](https://www.pdflokal.id/)**

## Update Terbaru

**Januari 2026:**
- 🔒 **Security headers** - CSP, X-Frame-Options, dan perlindungan keamanan lainnya
- 📜 **Halaman privasi** - Kebijakan privasi lengkap dalam Bahasa Indonesia
- 📴 **Offline mode!** PDFLokal sekarang bisa dipakai tanpa internet (kecuali fitur Proteksi PDF)
- 🔒 Self-hosted libraries - semua library utama tersimpan lokal, tidak perlu CDN
- ✨ Tanda tangan bisa di-unlock dengan double-click untuk diedit
- 🗑️ Tombol hapus signature dengan sekali klik
- 🎨 Changelog notification system yang smooth dan non-intrusive
- 🏗️ Refactoring ke modular JavaScript architecture untuk maintainability
- 🌐 Self-hosted fonts untuk akses di restricted networks
- 📱 Mobile UX improvements (action buttons kini muncul di mobile)

## Fitur

### PDF Tools
- **Editor PDF** - Editor lengkap dengan whiteout, teks (5 font choices, bold/italic, warna), tanda tangan (upload gambar dengan background removal, unlock untuk edit, hapus dengan sekali klik), watermark, nomor halaman, dan proteksi password
- **Gabung PDF** - Gabungkan beberapa PDF menjadi satu dengan drag-drop reordering
- **Pisah PDF** - Ekstrak halaman tertentu sebagai PDF terpisah
- **Kompres PDF** - Kurangi ukuran file (kompres gambar dalam PDF)
- **PDF ke Gambar** - Export halaman sebagai PNG/JPG
- **Proteksi PDF** - Tambahkan password ke PDF

### Image Tools
- **Kompres Gambar** - Kurangi ukuran file dengan kontrol kualitas
- **Ubah Ukuran** - Resize dengan lock aspect ratio
- **Convert Format** - JPG, PNG, WebP
- **Gambar ke PDF** - Gabungkan gambar menjadi PDF
- **Hapus Background** - Hapus latar belakang putih untuk PNG transparan

## Privasi

- **100% Client-side** - Semua proses di browser
- **Tidak ada upload** - File tidak pernah meninggalkan perangkat
- **Open source** - Kode bisa diperiksa siapa saja

## Cara Pakai

1. Buka [pdflokal.id](https://www.pdflokal.id/)
2. Pilih tool yang dibutuhkan atau drag & drop file PDF
3. Proses dan download hasilnya

Tidak perlu install, tidak perlu daftar, tidak perlu bayar.

## Development

### Prerequisites
- Browser modern (Chrome, Firefox, Safari, Edge)
- Web server lokal (opsional, bisa langsung buka file HTML)

### Run Locally
```bash
# Clone repository
git clone https://github.com/ojanlubis/pdflokal
cd pdflokal

# Buka dengan web server (opsional)
npx serve .
# atau
python -m http.server 8000

# Atau langsung buka index.html di browser
```

### Tech Stack
- **Vanilla HTML/CSS/JS** - No build step, no framework, modular IIFE pattern
- **[pdf-lib](https://pdf-lib.js.org/)** - PDF manipulation (self-hosted)
- **[PDF.js](https://mozilla.github.io/pdf.js/)** - PDF rendering & thumbnails (self-hosted)
- **[Signature Pad](https://github.com/szimek/signature_pad)** - Tanda tangan digital (self-hosted)
- **[fontkit](https://github.com/foliojs/fontkit)** - Custom font embedding (self-hosted)
- **[pdf-encrypt-lite](https://github.com/nicholasohjj/pdf-encrypt-lite)** - PDF password encryption (CDN - requires internet)
- **Canvas API** - Image processing
- **Self-hosted fonts** - Montserrat, Carlito, Plus Jakarta Sans
- **Self-hosted libraries** - 5/6 core libraries stored locally (2.6 MB) for offline support

### Project Structure
```
pdflokal/
├── index.html      # Main application
├── dukung.html     # Donation page
├── style.css       # All styles
├── js/             # Modularized JavaScript
│   ├── changelog.js      # Changelog notification system
│   ├── app.js            # Core app logic & state management
│   ├── pdf-tools.js      # PDF tools (text, signature, whiteout modals)
│   ├── unified-editor.js # Unified PDF editor workspace
│   ├── image-tools.js    # Image processing tools
│   └── vendor/           # Self-hosted libraries (2.6 MB)
│       ├── pdf-lib.min.js
│       ├── fontkit.umd.min.js
│       ├── pdf.min.js
│       ├── pdf.worker.min.js
│       └── signature_pad.umd.min.js
├── fonts/          # Self-hosted fonts (268KB total)
│   ├── montserrat-*.woff2
│   ├── carlito-*.woff2
│   └── plusjakartasans-*.woff2
├── images/         # UI assets
└── README.md
```

## Kontribusi

Kontribusi selalu disambut! Beberapa cara untuk berkontribusi:

1. **Laporkan Bug** - Buka issue jika menemukan masalah
2. **Request Fitur** - Sarankan fitur baru via issue
3. **Pull Request** - Perbaiki bug atau tambah fitur
4. **Share** - Ceritakan tentang PDFLokal ke orang lain
5. **Donasi** - Bantu biaya development via [halaman donasi](https://www.pdflokal.id/dukung.html)

### Development Guidelines
- **Gunakan vanilla JS** - Hindari dependencies baru kecuali benar-benar perlu
- **Semua fitur harus client-side** - Tidak boleh butuh server
- **Modular architecture** - Kode diorganisir dalam `js/` folder dengan IIFE pattern:
  - `js/app.js` - Core logic & state management
  - `js/unified-editor.js` - Unified editor workspace
  - `js/pdf-tools.js` - PDF tool modals
  - `js/image-tools.js` - Image processing
  - `js/changelog.js` - Changelog system
- **UI harus responsive** - Test di desktop dan mobile
- **Copy dalam Bahasa Indonesia** - Semua UI text harus bahasa Indonesia
- **Test di berbagai browser** - Chrome, Firefox, Safari, Edge sebelum PR
- **Lihat CLAUDE.md** - Untuk detail teknis arsitektur dan patterns

## Limitasi

Beberapa hal yang perlu diketahui:

1. **Kompres PDF** - Hanya bisa kompres gambar di dalam PDF, bukan struktur PDF itu sendiri
2. **File besar** - File >50MB mungkin lambat atau crash di beberapa device
3. **PDF kompleks** - Beberapa PDF dengan enkripsi atau font khusus mungkin tidak bisa diproses
4. **Browser lama** - Butuh browser modern dengan support ES6+

### Fitur yang Butuh Server (Coming Soon)
- PDF ke Word
- PDF ke Excel
- Word/Excel ke PDF
- OCR (text recognition)

Fitur ini akan ditambahkan ketika ada resources untuk server-side processing.

## Lisensi & Commercial Use

PDFLokal adalah open source dengan lisensi AGPL-3.0 untuk kepentingan:
- Pembelajaran dan edukasi
- Self-hosting untuk penggunaan internal/pribadi
- Kontribusi dan improvement

**Untuk commercial derivatives atau rebranding:**
- Wajib memberikan atribusi jelas ke PDFLokal
- Link ke repo original: github.com/ojanlubis/pdflokal
- Tidak boleh claim sebagai karya original
- Source code modifikasi wajib tetap open source dan dibagikan

**Khusus untuk web service:**
Jika menjalankan versi modifikasi sebagai layanan web publik, wajib menyediakan akses ke source code lengkap sesuai ketentuan AGPL-3.0.

Jika ingin diskusi commercial use, hubungi via GitHub Issues.

Lihat file [LICENSE](LICENSE) untuk detail lengkap.

## Contributors

Terima kasih kepada semua yang telah berkontribusi:

- [@hamdi1611](https://github.com/hamdi1611) - Signature UX improvements (unlock, delete, mobile layout)

Ingin berkontribusi? Lihat [panduan kontribusi](#kontribusi) di atas.

## Credits

- [pdf-lib](https://pdf-lib.js.org/) by Andrew Dillon
- [PDF.js](https://mozilla.github.io/pdf.js/) by Mozilla
- [Signature Pad](https://github.com/szimek/signature_pad) by Szymon Nowak
- Inspired by [iLovePDF](https://www.ilovepdf.com/), [Smallpdf](https://smallpdf.com/), dan [Squoosh](https://squoosh.app/)

---

**Made with love in Indonesia**

Punya pertanyaan? Buka issue atau hubungi via GitHub.
