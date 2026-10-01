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
};
