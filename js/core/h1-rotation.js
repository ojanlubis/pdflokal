/*
 * PDFLokal — core/h1-rotation.js  (THE HOMEPAGE HEADLINE THAT DRIFTS)
 * ============================================================================
 * His idea, 2026-10-06 (seat: reference/h1-rotation-2026-10-06.md): a returning
 * visitor sees a random headline from a LEVEL, and the more distinct days they
 * come back the stranger the level. It starts as someone handling PDFs and drifts
 * to their whole life, and never names a tool. Day 1, a crawler, a first visit
 * and anyone without a visitor_id always see the static "Buat ngurus PDF." in the
 * markup, so SEO never sees any of this.
 *
 * PURE, no DOM, no storage: the thresholds, the lines and the pick. The wiring
 * (counting WIB days, writing the h1) is js/v2/h1-rotation.js.
 *
 * THE INDONESIAN LINES ARE HIS WORDS, character for character (spelling,
 * "capek2nya...", no full stop where he wrote none). Changing one is his call, not
 * a session's. The English ones are the seat's draft until he approves them.
 * Both /  and /en rotate; the SEO tool pages never do (their headline is their keyword).
 *
 * LEVEL 5 (day 30+) is random within its seven lines like the others: no arc, no
 * empty headline. Its last three Indonesian lines are his own words (no full stop,
 * "Tuhan" capitalised, as he wrote them); the English level 5 is the seat's draft.
 */

// Per language, index = level. The /en table is the seat's DRAFT (2026-10-06,
// written from the same arc, not word for word), pending his approval. Level 0 of
// each language is the headline already in that page's markup.
export const LEVELS = {
  id: [
    ['Buat ngurus PDF.'],
    [
      'Buat nganuin PDF.',
      'Buat beresin dokumen.',
      'Anuin PDFmu di sini.',
      'PDF lagi, PDF lagi.',
      'Dokumen lagi ya?',
    ],
    [
      'Tenang. Jangan panik.',
      'Deadline-nya jam berapa?',
      'Berkasnya udah lengkap?',
      'Nunggu tanda tangan siapa?',
      'Atasanmu nggak perlu tahu.',
    ],
    [
      'Jangan lupa senyum.',
      'Udah makan belum?',
      'Minum air putih dulu.',
      'Tidurmu cukup?',
      'Kapan terakhir libur?',
    ],
    [
      'Kamu lagi ngejar apa sih?',
      'Hidup lagi capek2nya...',
      'In this economy...',
      'Dewasa bukan soal umur',
      'Ketabahan adalah kekuatan',
    ],
    [
      'Bebanmu tak melebihi kekuatanmu.',
      'Terhimpit, tapi tak hancur.',
      'Bersama kesulitan ada kemudahan.',
      'Dari tanah, kembali ke tanah.',
      'Semoga Tuhan menjaga kita',
      'Semoga doa kita terkabul',
      'Semoga kebahagiaan menyertai kita',
    ],
  ],
  en: [
    ['For all your PDF Needs'],
    [
      'For doing stuff to PDFs.',
      'For sorting out documents.',
      'PDF again? PDF again.',
      'More documents, huh?',
      'Back with another file?',
    ],
    [
      "Relax. Don't panic.",
      "When's the deadline?",
      'Got all the paperwork?',
      'Still waiting on whose signature?',
      "Your boss doesn't need to know.",
    ],
    [
      "Don't forget to smile.",
      'Have you eaten?',
      'Drink some water first.',
      'Sleeping enough?',
      'When was your last day off?',
    ],
    [
      'What are you chasing, really?',
      "Life's been heavy lately...",
      'In this economy...',
      "Growing up isn't about age",
      'Patience is a kind of strength',
    ],
    [
      'No burden beyond what you can bear.',
      'Pressed, but not crushed.',
      'With hardship comes ease.',
      'From dust, back to dust.',
      'May God watch over us',
      'May our prayers be answered',
      'May happiness be with us',
    ],
  ],
};

// The headline in each page's markup: what level 0 leaves alone.
export const DEFAULT_H1 = { id: LEVELS.id[0][0], en: LEVELS.en[0][0] };

// Visit day (1 = the first day this browser ever loaded a page) -> level.
//   1 -> 0 · 2-3 -> 1 · 4-7 -> 2 · 8-14 -> 3 · 15-29 -> 4 · 30+ -> 5
// Anything that is not a whole number >= 1 is level 0: unknown means static.
export function levelFor(visitDays) {
  const n = Math.floor(Number(visitDays));
  if (!Number.isFinite(n) || n < 2) return 0;
  if (n <= 3) return 1;
  if (n <= 7) return 2;
  if (n <= 14) return 3;
  if (n <= 29) return 4;
  return 5;
}

// The WIB (Asia/Jakarta, UTC+7, no DST) calendar day of a timestamp, as YYYY-MM-DD.
// WIB because the day is his day: the visitor count and the rail's "today" are WIB
// too (api/visitors.js), and a user's local zone would move the boundary under them.
export function wibDay(nowMs) {
  return new Date(nowMs + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// Pick the headline for this visit, in `lang` ('id' or 'en'; anything else is 'id').
// null = level 0, leave the static headline. Random within the level and never the
// one shown last, whenever the level has more than one line to choose from. `rand`
// is injectable (0 <= rand() < 1).
export function pickH1({ visitDays, last = null, rand = Math.random, lang = 'id' } = {}) {
  const level = levelFor(visitDays);
  if (level === 0) return null;
  const pool = LEVELS[lang === 'en' ? 'en' : 'id'][level];
  const choices = pool.length > 1 ? pool.filter((l) => l !== last) : pool;
  const r = rand();
  const i = Number.isFinite(r) ? Math.min(choices.length - 1, Math.max(0, Math.floor(r * choices.length))) : 0;
  return choices[i];
}
