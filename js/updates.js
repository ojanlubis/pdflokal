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
 */
export const UPDATES = [
  {
    id: '2026-09-23-teks-titik',
    date: '2026-09-23',
    text: 'Teks hasil Edit nggak lagi jadi titik-titik saat file diunduh.',
    approved: true,
  },
  {
    id: '2026-09-22-scan-nyatu',
    date: '2026-09-22',
    text: 'Edit di dokumen hasil scan sekarang ikut warna kertas dan bentuk hurufnya.',
    approved: true,
  },
  {
    id: '2026-09-21-unduh-hp',
    date: '2026-09-21',
    text: 'Tombol Unduh yang kadang nggak bisa ditekan di HP udah beres.',
    approved: true,
  },
];

// What the card shows: approved only, newest first, at most `max`.
export function shownUpdates(list = UPDATES, max = 3) {
  return list
    .filter((u) => u && u.approved === true && u.id && u.date && u.text)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, max);
}
