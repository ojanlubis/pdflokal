/*
 * PDFLokal — updates.js  (what Ojan changed, for the maker card)
 * ============================================================================
 * The list behind the homepage card (js/v2/maker-card.js): the person behind
 * PDFLokal, and the last three things he fixed or added.
 *
 * FOUNDER RULINGS, 2026-09-23:
 *   - A MODEL WRITES THE ENTRY; FAUZAN APPROVES IT. An entry is shown only when
 *     `approved: true`, and only he flips that. A model adding an entry leaves
 *     it `approved: false` and says so in its report.
 *   - Only changes a USER can feel. Refactors, tests, telemetry: no entry.
 *   - At most three are shown, newest first.
 *   A Claude Code hook reminds every session that commits in app/ to add one.
 *
 * FORMAT: `id` is unique and never reused — it is what a visitor's "already
 * seen" memory stores, so a NEW id is what brings the card back to someone
 * who closed it. `date` is YYYY-MM-DD (WIB). `text` is one or two short lines.
 * Newest at the top.
 *
 * ENGLISH: every entry carries `en`, the same line for /en (the founder's ruling
 * 2026-10-02: /en is the same product, so the card is too). It is a field and not
 * a dictionary key on purpose: entries are append-only data that a hook asks a
 * session to add, and a key per entry would orphan in the dictionaries the day
 * the entry scrolls off the card. tests/core/maker-card.test.mjs fails an entry
 * without one. Plain, short, no em-dash; the tool names the English UI shows
 * (Edit, Download, Sign).
 */
import { getLocale } from './lib/i18n.js';

export const UPDATES = [
  {
    id: '2026-10-06-tinggalkan-tab',
    date: '2026-10-06',
    text: 'Browser sekarang ngingetin kamu kalau mau nutup tab sebelum editan diunduh.',
    en: "Your browser now warns you before closing a tab with edits you haven't downloaded.",
    approved: true, // Fauzan, 2026-10-06
  },
  {
    id: '2026-10-06-copy-paste',
    date: '2026-10-06',
    text: 'Sekarang kamu bisa copy-paste teks, tip-ex, dan tanda tangan pakai Ctrl+C dan Ctrl+V.',
    en: 'You can now copy and paste text, whiteout and signatures with Ctrl+C and Ctrl+V.',
    approved: true, // Fauzan, 2026-10-06
  },
  {
    id: '2026-10-06-ctrl-b-i',
    date: '2026-10-06',
    text: 'Ctrl+B dan Ctrl+I sekarang bikin teks tebal dan miring.',
    en: 'Ctrl+B and Ctrl+I now make text bold and italic.',
    approved: true, // Fauzan, 2026-10-06
  },
  {
    id: '2026-10-02-hapus-tulisan-asli',
    date: '2026-10-02',
    text: 'Sekarang kamu bisa hapus tulisan asli PDF: nyalain Hapus, terus tap barisnya.',
    en: "You can now delete the PDF's own text: turn on Delete, then tap the line.",
    approved: true, // Fauzan, 2026-10-02
  },
  {
    id: '2026-10-02-gabung-cek-awal',
    date: '2026-10-02',
    text: 'Gabung PDF sekarang ngasih tahu dari awal kalau ada file yang nggak bisa digabung.',
    en: "Merge now tells you right away when a file can't be merged.",
    approved: true, // Fauzan, 2026-10-02
  },
  {
    id: '2026-10-02-unduh-coba-ulang',
    date: '2026-10-02',
    text: 'Unduh nggak gagal lagi cuma karena sinyal putus sebentar.',
    en: 'Download no longer fails just because the signal dropped for a moment.',
    approved: true, // Fauzan, 2026-10-02
  },
  {
    id: '2026-10-02-kelola-keyboard',
    date: '2026-10-02',
    text: 'Tombol Putar, Ekstrak, dan Hapus Halaman di Kelola Halaman sekarang bisa pakai keyboard.',
    en: 'In Manage Pages, Rotate, Extract and Delete Pages can now be reached with the keyboard.',
    approved: true, // Fauzan, 2026-10-02
  },
  {
    id: '2026-10-02-bahasa-browser',
    date: '2026-10-02',
    text: 'PDFLokal sekarang otomatis terbuka dalam bahasa browser-mu.',
    en: 'PDFLokal now opens in your browser language.',
    approved: true, // Fauzan, 2026-10-02: approved as is
  },
  {
    id: '2026-10-01-edit-paragraf',
    date: '2026-10-01',
    text: 'Sekarang kamu bisa edit satu paragraf sekaligus.',
    en: 'You can now edit a whole paragraph at once.',
    approved: true,
  },
  {
    id: '2026-10-01-english',
    date: '2026-10-01',
    text: 'PDFLokal sekarang ada versi bahasa Inggris.',
    en: 'PDFLokal now has an English version.',
    approved: true,
  },
  {
    id: '2026-10-01-edit-sama-persis',
    date: '2026-10-01',
    text: 'Teks yang kamu edit sekarang tampil persis sama dengan hasil unduhannya.',
    en: 'The text you edit now looks exactly like it does in the downloaded file.',
    approved: true,
  },
  {
    id: '2026-10-01-edit-isian',
    date: '2026-10-01',
    text: 'Tools Edit sekarang bisa mendeteksi formulir dan list, supaya editnya lebih pas',
    en: 'The Edit tool now detects forms and lists, so edits fit better.',
    approved: true,
  },
  {
    id: '2026-10-01-ukuran-bebas',
    date: '2026-10-01',
    text: 'Ukuran huruf Teks sekarang bisa kamu ketik sendiri, sekecil 1.',
    en: 'You can now type your own Text font size, as small as 1.',
    approved: true,
  },
  {
    id: '2026-09-23-teks-titik',
    date: '2026-09-23',
    text: 'Teks hasil Edit nggak lagi jadi titik-titik saat file diunduh.',
    en: 'Edited text no longer turns into dots when the file is downloaded.',
    approved: true,
  },
  {
    id: '2026-09-22-scan-nyatu',
    date: '2026-09-22',
    text: 'Edit di dokumen hasil scan sekarang ikut warna kertas dan bentuk hurufnya.',
    en: 'Edits on scanned documents now match the paper color and the lettering.',
    approved: true,
  },
  {
    id: '2026-09-21-unduh-hp',
    date: '2026-09-21',
    text: 'Tombol Unduh yang kadang nggak bisa ditekan di HP udah beres.',
    en: 'The Download button that sometimes could not be tapped on phones is fixed.',
    approved: true,
  },
];

// The entry's line in the page's language: English on /en when it has one, else
// the Indonesian (never blank).
export function updateText(u, locale = getLocale()) {
  return locale === 'en' && u.en ? u.en : u.text;
}

// What the card shows: approved only, newest first, at most `max`.
export function shownUpdates(list = UPDATES, max = 3) {
  return list
    .filter((u) => u && u.approved === true && u.id && u.date && u.text)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, max);
}
