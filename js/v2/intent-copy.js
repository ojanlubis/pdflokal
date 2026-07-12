/*
 * PDFLokal — v2/intent-copy.js  (INTENT-AWARE UI COPY)
 * ============================================================================
 * SINGLE SOURCE OF TRUTH for the editor's wording when we already KNOW what the
 * user came to do.
 *
 * WHY (founder, Jul 12 2026):
 *   Someone landing on /pisah-pdf has already told us, unambiguously, that they
 *   want to split a PDF. Then the editor greeted them with "Seret file ke sini"
 *   and a bulk-bar button labelled "Ekstrak" — and the word "pisah" appeared
 *   NOWHERE. We armed the right tool and then described it in a language the user
 *   hadn't asked in. The intent was known and thrown away.
 *
 *   So: the SEO landing pages don't just pre-arm the tool, they re-word the UI
 *   around the job. /pisah-pdf says "Pilih halaman yang mau dipisah". /gabung-pdf
 *   says "Seret semua PDF yang mau digabung".
 *
 * SCOPE — deliberately small. Only the surfaces a user reads while deciding what
 * to do next:
 *   - the dropzone (the first thing they see, BEFORE a file exists)
 *   - the Kelola Halaman sheet heading + hint (the first thing AFTER)
 *   - the one bulk-bar verb that was actively misleading ("Ekstrak" → "Pisah")
 *
 * WHAT THIS IS NOT: a translation layer, or a per-page theming system. Every
 * override here must earn itself by naming the user's job in the user's word. If
 * you can't say which query the wording answers, don't add it.
 *
 * The default copy (index.html) stays the generic, correct copy for someone who
 * arrived with no declared intent — the homepage. Nothing here is required; every
 * field is optional and falls back to the markup.
 */

// Keys map to the intents in app.js applyIntent() / the landing cards' data-intent.
export const INTENT_COPY = {
  gabung: {
    dzTitle: 'Seret semua PDF yang mau digabung',
    dzHint: 'Boleh banyak file sekaligus — urutannya bisa diatur setelah ini',
    pmTitle: 'Atur Urutan',
    pmHint: 'Tahan lalu geser buat mengurutkan · buang halaman yang nggak perlu',
  },

  split: {
    dzTitle: 'Seret PDF yang mau dipisah',
    dzHint: 'Habis ini kamu tinggal centang halaman yang mau diambil',
    pmTitle: 'Pilih Halaman',
    pmHint: 'Centang halaman yang mau dipisah jadi file PDF baru',
    // THE one that mattered: "Ekstrak" never said "pisah" to someone who came to
    // split. Same action, the user's word.
    extract: 'Pisah',
  },

  halaman: {
    dzTitle: 'Seret PDF yang halamannya mau dirapikan',
    dzHint: 'Buang halaman kosong, urutkan ulang, putar yang miring',
    pmTitle: 'Kelola Halaman',
    pmHint: 'Centang halaman yang mau dibuang · tahan lalu geser buat mengurutkan',
  },

  kompres: {
    dzTitle: 'Seret PDF yang mau dikompres',
    dzHint: 'Ukuran hasilnya kami tunjukkan sebelum kamu unduh',
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
    dzHint: 'Seret di atas bagian yang salah — seperti tip-ex di kertas',
  },

  gambar: {
    dzTitle: 'Seret PDF yang mau diubah jadi gambar',
    dzHint: 'Tiap halaman jadi satu file JPG atau PNG',
  },

  foto: {
    dzTitle: 'Seret foto yang mau dijadikan PDF',
    dzHint: 'Boleh banyak sekaligus — urutannya bisa diatur setelah ini',
    pmTitle: 'Atur Urutan',
    pmHint: 'Tahan lalu geser buat mengurutkan · putar foto yang miring',
  },
};

// Set text ONLY when we have an override and the element exists. A missing element
// is not an error — alat-gambar (the old wing) has none of these, and the homepage
// deliberately keeps its generic copy.
function say(sel, text) {
  if (!text) return;
  const el = document.querySelector(sel);
  if (el) el.textContent = text;
}

// Re-word the editor around a known job. Safe to call more than once (a tool-card
// click re-arms a different intent), and safe to call with an unknown/null intent.
export function applyIntentCopy(intent) {
  const c = INTENT_COPY[intent];
  if (!c) return;

  say('.dz-title', c.dzTitle);
  say('.dz-hint', c.dzHint);
  say('#pm-sheet .pm-head h2', c.pmTitle);
  say('#pm-sheet .pm-hint', c.pmHint);
  say('#pm-bulk button[data-act="extract"]', c.extract);
}
