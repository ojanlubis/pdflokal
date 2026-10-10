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

import { t as tr } from '../lib/i18n.js';

// Keys map to the intents in app.js applyIntent() / the landing cards' data-intent.
// Each intent is a function so the copy is read at apply time, in the page's
// language, never frozen at import. The words live in js/locales/*.js under
// intent.<intent>.<field>.
export const INTENT_COPY = {
  gabung: () => ({
    dzTitle: tr('intent.gabung.dzTitle'),
    dzHint: tr('intent.gabung.dzHint'),
    pmTitle: tr('intent.gabung.pmTitle'),
    pmHint: tr('intent.gabung.pmHint'),
  }),

  split: () => ({
    dzTitle: tr('intent.split.dzTitle'),
    dzHint: tr('intent.split.dzHint'),
    pmTitle: tr('intent.split.pmTitle'),
    pmHint: tr('intent.split.pmHint'),
    // THE one that mattered: "Ekstrak" never said "pisah" to someone who came to
    // split. Same action, the user's word.
    extract: tr('intent.split.extract'),
  }),

  halaman: () => ({
    dzTitle: tr('intent.halaman.dzTitle'),
    dzHint: tr('intent.halaman.dzHint'),
    pmTitle: tr('intent.halaman.pmTitle'),
    pmHint: tr('intent.halaman.pmHint'),
  }),

  kompres: () => ({
    dzTitle: tr('intent.kompres.dzTitle'),
    dzHint: tr('intent.kompres.dzHint'),
  }),

  ttd: () => ({
    dzTitle: tr('intent.ttd.dzTitle'),
    dzHint: tr('intent.ttd.dzHint'),
  }),

  paraf: () => ({
    dzTitle: tr('intent.paraf.dzTitle'),
    dzHint: tr('intent.paraf.dzHint'),
  }),

  teks: () => ({
    dzTitle: tr('intent.teks.dzTitle'),
    dzHint: tr('intent.teks.dzHint'),
  }),

  tipex: () => ({
    dzTitle: tr('intent.tipex.dzTitle'),
    dzHint: tr('intent.tipex.dzHint'),
  }),

  gambar: () => ({
    dzTitle: tr('intent.gambar.dzTitle'),
    dzHint: tr('intent.gambar.dzHint'),
  }),

  foto: () => ({
    dzTitle: tr('intent.foto.dzTitle'),
    dzHint: tr('intent.foto.dzHint'),
    pmTitle: tr('intent.foto.pmTitle'),
    pmHint: tr('intent.foto.pmHint'),
  }),
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
  // WHY Object.hasOwn: `intent` arrives from ?buat= at app.js top level. A plain
  // lookup answers for inherited keys (`__proto__`, `valueOf`…), and calling one
  // threw out of app.js before boot finished: a shared link killed the editor.
  const build = intent && Object.hasOwn(INTENT_COPY, intent) ? INTENT_COPY[intent] : null;
  if (typeof build !== 'function') return;
  const c = build();

  say('.dz-title', c.dzTitle);
  say('.dz-hint', c.dzHint);
  say('#pm-sheet .pm-head h2', c.pmTitle);
  say('#pm-sheet .pm-hint', c.pmHint);
  say('#pm-bulk button[data-act="extract"]', c.extract);
}
