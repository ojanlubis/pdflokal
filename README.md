# PDFLokal

> **Urus dokumen langsung di browser.** Cepat, gratis, file tidak pernah diupload.

PDFLokal adalah tool PDF gratis untuk pengguna Indonesia. Semua proses berjalan di browser - file tidak pernah meninggalkan perangkat Anda.

**[Buka PDFLokal](https://www.pdflokal.id/)**

## Fitur

### PDF Tools
- **Editor PDF** - Editor lengkap dengan whiteout, teks (pilihan font, bold/italic, warna), tanda tangan, watermark, nomor halaman, dan proteksi password
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
- **Vanilla HTML/CSS/JS** - No build step, no framework
- **[pdf-lib](https://pdf-lib.js.org/)** - PDF manipulation
- **[PDF.js](https://mozilla.github.io/pdf.js/)** - PDF rendering & thumbnails
- **[Signature Pad](https://github.com/szimek/signature_pad)** - Tanda tangan digital
- **[pdf-encrypt-lite](https://github.com/nicholasohjj/pdf-encrypt-lite)** - PDF password encryption
- **Canvas API** - Image processing

### Project Structure
```
pdflokal/
├── index.html      # Main application
├── dukung.html     # Donation page
├── style.css       # All styles
├── app.js          # Application logic
├── images/
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
- Gunakan vanilla JS, hindari dependencies baru kecuali benar-benar perlu
- Semua fitur harus client-side (tidak boleh butuh server)
- UI harus responsive dan mudah digunakan
- Copy dalam Bahasa Indonesia
- Test di berbagai browser sebelum PR

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

## Credits

- [pdf-lib](https://pdf-lib.js.org/) by Andrew Dillon
- [PDF.js](https://mozilla.github.io/pdf.js/) by Mozilla
- [Signature Pad](https://github.com/szimek/signature_pad) by Szymon Nowak
- Inspired by [iLovePDF](https://www.ilovepdf.com/), [Smallpdf](https://smallpdf.com/), dan [Squoosh](https://squoosh.app/)

---

**Made with love in Indonesia**

Punya pertanyaan? Buka issue atau hubungi via GitHub.
