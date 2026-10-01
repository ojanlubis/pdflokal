/*
 * PDFLokal — locales/id.js  (Bahasa Indonesia, the SOURCE language)
 * ============================================================================
 * The master dictionary, and the fallback every other locale resolves through
 * (js/lib/i18n.js). Copy changes here first; en.js follows.
 *
 * SHAPE: nested objects, dotted keys ('toast.armText'). A value is a string
 * with {slots} for the variable parts, an array of strings (step lists), or a
 * plural object { one, other } picked by vars.count. Indonesian has no plural
 * forms, so here a plural key is still a plain string.
 *
 * TONE: informal "kamu". No em-dashes (CLAUDE.md). English tech terms are fine
 * in step-by-step instructions.
 *
 * Every string below equals the literal that was in the code before it moved
 * here; tests/core/fixtures/i18n-id-baseline.json pins that. Every key here
 * must be read by a t() call (tests/core/i18n.test.mjs).
 */
export default {
  number: {
    decimal: ',',
  },

  // Page slot label (alt text) and the page-count progress line
  page: { short: 'Hal {n}' },
  loading: { count: '{n} dari {total} file' },

  // Signature / paraf bar above the page
  sigBar: {
    initialsSelected: 'Paraf terpilih',
    signatureSelected: 'Tanda tangan terpilih',
    armed: 'Pilih tempat untuk menempatkan',
  },

  // The home screen's "see all tools" toggle
  landing: {
    hideTools: 'Sembunyikan',
    showTools: 'Lihat semua alat',
  },

  // Editor toasts (js/v2/app.js)
  toast: {
    armText: 'Pilih tempat untuk menulis',
    armWhiteout: 'Seret di halaman untuk menutup teks',
    armSignature: 'Pilih tempat untuk menempatkan tanda tangan',
    armInitials: 'Pilih tempat untuk menempatkan paraf',
    armEdit: 'Edit teks asli, fitur beta. Tap tulisan yang mau kamu ubah',
    armEditShort: 'Tap tulisan yang mau diubah',
    missedText: 'Nggak kena tulisan, tap tepat di teksnya ya',
    noReadableText: 'Nggak ada tulisan yang kebaca',
    scanFailed: 'Gagal scan, coba lagi ya',
    scanNotEditable: 'Halaman ini hasil scan/foto, teksnya belum bisa diedit',
    pickObject: 'Pilih objek yang mau dihapus',
    preparing: 'Sebentar, lagi disiapkan',
    fontSubstituteResult: 'Sebagian teks memakai font pengganti yang mirip di file hasil',
    fontSubstituteChar: 'Huruf ini memakai font pengganti yang mirip',
    extractDone: 'Selesai! {count} halaman diekstrak jadi PDF baru',
    extractFailed: 'Waduh, gagal mengekstrak. Coba sekali lagi ya',
    signatureReplaced: 'Tanda tangan diganti',
    signatureCopied: 'Oke, ditaruh di {count} halaman lainnya juga',
    stillLoading: 'Sebentar ya, file sebelumnya masih dimuat',
    pickFile: 'Pilih file PDF atau gambar ya',
    tooBig: '"{name}" terlalu besar (maks 100MB)',
    lockedReadOnly: 'PDF ini terkunci, bisa dibaca, tapi nggak bisa disimpan ulang',
    openLocked: 'File itu dikunci sandi, jadi nggak bisa dibuka di sini',
    openFailedOne: 'File itu nggak bisa dibuka, mungkin kosong atau rusak',
    openFailedAll: 'Nggak ada file yang bisa dibuka, mungkin kosong atau rusak',
    openFailed: 'Gagal membuka file',
    skipped: '{count} file dilewati, kosong atau rusak',
    merged: 'Dijepit jadi satu, sekarang {count} halaman',
    addMoreFiles: 'Tambah file lainnya lewat menu File di kiri atas',
  },

  // Unduh sheet (js/v2/download-sheet.js)
  sheet: {
    fail: {
      retry: 'Waduh, gagal membuat file. Coba sekali lagi ya',
      encrypted: 'PDF ini terkunci, jadi nggak bisa disimpan ulang',
      corrupt: 'File PDF ini rusak, jadi nggak bisa dibuat ulang',
      unsupported: 'Ada huruf yang nggak bisa disimpan. Cek teks yang kamu tulis ya',
      unknown: 'Waduh, gagal membuat file',
    },
    signedNote: 'Dokumen ini punya meterai atau tanda tangan digital. Kalau disimpan dari sini, segelnya rusak dan dokumen bisa gagal diverifikasi. File aslimu nggak berubah.',
    auto: 'Otomatis',
    compressFailed: 'Kompres gagal, saya pakai ukuran asli ya',
    meta: '{name}.pdf · {count} hal',
    pagesAll: '{count} halaman',
    pagesPicked: '{count} dipilih',
    stamp: { optimal: 'Sudah optimal' },
    progress: {
      search: 'Mencari ukuran yang pas… (percobaan {pass})',
      images: 'Menyiapkan gambar {done}/{total}…',
      zip: 'Membungkus jadi ZIP…',
    },
    // The Ukuran row: a label and a small line under it
    size: {
      original: 'Asli',
      medium: 'Sedang',
      small: 'Kecil',
      compress: 'Compress',
      smaller: 'file lebih kecil',
      calculating: 'menghitung…',
      optimal: 'file sudah optimal',
      saved: 'hemat {pct}%',
    },
    // The big button and the line under it
    cta: {
      pdf: 'Unduh PDF',
      pages: '({count} hal.)',
      imageOne: 'Unduh 1 Gambar',
      imageZip: 'Unduh {count} Gambar · ZIP',
    },
    sub: {
      missed: 'paling kecil yang bisa: {size}, belum masuk {cap}. Coba buang halaman yang nggak perlu.',
      fits: '{size}, muat di bawah {cap}',
      saved: 'hemat {pct}% dari {size}',
      alreadySmallest: 'udah paling kecil, nggak bisa dikompres lagi tanpa merusak',
      originalSize: 'ukuran asli',
    },
    toast: { zipDone: 'Selesai! {count} gambar dibungkus jadi satu ZIP' },
  },

  // Dropzone + Kelola Halaman wording by the user's job (js/v2/intent-copy.js)
  intent: {
    gabung: {
      dzTitle: 'Seret semua PDF yang mau digabung',
      dzHint: 'Boleh banyak file sekaligus, urutannya bisa diatur setelah ini',
      pmTitle: 'Atur Urutan',
      pmHint: 'Tahan lalu geser buat mengurutkan · buang halaman yang nggak perlu',
    },
    split: {
      dzTitle: 'Seret PDF yang mau dipisah',
      dzHint: 'Habis ini kamu tinggal centang halaman yang mau diambil',
      pmTitle: 'Pilih Halaman',
      pmHint: 'Centang halaman yang mau dipisah jadi file PDF baru',
      extract: 'Pisah',
    },
    halaman: {
      dzTitle: 'Seret PDF yang halamannya mau dirapikan',
      dzHint: 'Buang halaman kosong, urutkan ulang, putar yang miring',
      pmTitle: 'Kelola Halaman',
      pmHint: 'Centang halaman yang mau dibuang',
    },
    kompres: {
      dzTitle: 'Seret PDF yang mau dikompres',
      dzHint: 'Ukuran hasilnya saya tunjukkan sebelum kamu unduh',
    },
    ttd: {
      dzTitle: 'Seret PDF yang mau ditandatangani',
      dzHint: 'Habis ini kamu bisa gambar tanda tangan, atau pakai fotonya',
    },
    paraf: {
      dzTitle: 'Seret PDF yang mau diparaf',
      dzHint: 'Paraf bisa disalin ke semua halaman sekaligus',
    },
    teks: {
      dzTitle: 'Seret PDF yang mau ditambahi teks',
      dzHint: 'Ketuk di mana pun di halaman untuk mulai menulis',
    },
    tipex: {
      dzTitle: 'Seret PDF yang tulisannya mau ditutup',
      dzHint: 'Seret di atas bagian yang salah, seperti tip-ex di kertas',
    },
    gambar: {
      dzTitle: 'Seret PDF yang mau diubah jadi gambar',
      dzHint: 'Tiap halaman jadi satu file JPG atau PNG',
    },
    foto: {
      dzTitle: 'Seret foto yang mau dijadikan PDF',
      dzHint: 'Boleh banyak sekaligus, urutannya bisa diatur setelah ini',
      pmTitle: 'Atur Urutan',
      pmHint: 'Tahan lalu geser buat mengurutkan · putar foto yang miring',
    },
  },

  // Install chip + card (js/v2/install-prompt.js)
  install: {
    // {where} = device word (device.*), {screen} = where the icon lands (screen.*).
    // Slots, never spliced fragments: word order differs by language.
    chip: 'Install PDFLokal di {where}',
    cardTitle: 'Install PDFLokal di {where}',
    cardSub: 'Biar besok nggak usah nyari lagi, langsung ada di {screen}, tetap jalan walau lagi offline.',
    device: { mobile: 'hapemu', desktop: 'komputermu' },
    screen: { mobile: 'layar HP', desktop: 'desktop' },
    // hl= of the official browser help pages we link to
    guideLang: 'id',
    ios: {
      title: 'Caranya di iPhone/iPad:',
      steps: [
        'Tap ikon Share (kotak dengan panah ke atas) di bawah.',
        'Scroll ke bawah, tap “Add to Home Screen”.',
        'Tap “Add” di kanan atas.',
      ],
    },
    androidFirefox: {
      title: 'Caranya di Firefox:',
      steps: [
        'Tap menu titik-tiga di kanan atas.',
        'Pilih “Install”.',
      ],
    },
    androidSamsung: {
      title: 'Caranya di Samsung Internet:',
      steps: [
        'Tap menu di bawah.',
        'Pilih “Add page to” → “Home screen”.',
      ],
    },
    androidChrome: {
      title: 'Caranya di Chrome:',
      steps: [
        'Tap menu titik-tiga di kanan address bar.',
        'Pilih “Add to Home screen”.',
        'Tap “Install”.',
      ],
    },
    desktopChromium: {
      title: 'Caranya di Chrome/Edge:',
      steps: [
        'Klik ikon Install (layar kecil dengan panah) di ujung kanan address bar, kalau ada.',
        'Atau: menu titik-tiga → “Cast, save, and share” → “Install page as app…”.',
        'Klik “Install”.',
      ],
    },
    desktopSafari: {
      title: 'Caranya di Safari (Mac):',
      steps: [
        'Dari menu “File”, pilih “Add to Dock”.',
        'Klik “Add”.',
      ],
    },
    fallback: {
      title: 'Biar gampang dibuka lagi:',
      steps: [
        'Tekan Ctrl+D (atau ⌘D) buat bookmark halaman ini.',
        'Atau buka pdflokal.id lewat Chrome/Edge buat install jadi app.',
      ],
    },
  },

  // The 👍/👎 pill after the first edit (js/v2/edit-feedback.js)
  editFeedback: {
    ask: 'Gimana hasil editnya?',
    up: 'Bagus',
    down: 'Kurang pas',
    thanks: 'Makasih, masukanmu ngebantu saya 🙏',
    noteQuestion: 'Apa yang kurang pas?',
    notePlaceholder: 'isi feedback biar kita bisa improve',
    noteLabel: 'Ceritakan apa yang kurang pas',
    askTitle: 'Boleh saya minta dua potongan ini?',
    askSub: 'Sebelum dan sesudahnya, biar saya bisa analisis fiturnya kurang di mana. Nggak ada isi file lain.',
    cropBefore: 'Asli',
    cropAfter: 'Hasil',
    skip: 'Nggak usah',
    send: 'Kirim',
  },
};
