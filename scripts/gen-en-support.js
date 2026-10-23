/*
 * PDFLokal — scripts/gen-en-support.js  (THE ENGLISH SUPPORT PAGE, /en/support)
 * ============================================================================
 * Renders `en/support.html` from dukung.html + i18n/markup.en.support.json.
 * Called by scripts/gen-seo-pages.js (`npm run seo`), which owns writing it and
 * the `--check` drift test. PURE: string in, string out, so a core test can
 * prove the shouts without running the whole generator.
 *
 * SAME DOCTRINE AS scripts/gen-en-page.js (read its header; this file reuses
 * its tokenizer, `mapMarkup`, so "what counts as a string" is defined once):
 * the map is EXACT STRINGS, Indonesian -> English, whole-string after
 * whitespace collapse. Two shouts, one per direction of drift: a map key that
 * dukung.html no longer contains (orphaned English), and a string in dukung.html
 * with no English (it would ship in Indonesian). Both name the string and throw.
 *
 * THE FOUNDER'S RULING, 2026-10-02: `/en` is the SAME product as `/`, in
 * English. Nothing differs except language, so /dukung has an English twin and
 * the QRIS QR on it is the same image, the same "Download QR". Every string on
 * dukung.html is his; these are plain translations of them, not rewrites.
 *
 * THE WORK LOG IS NOT IN THE MAP. Between <!-- riwayat:start --> and
 * <!-- riwayat:end --> sit ~500 rows written by scripts/gen-riwayat.js from git
 * log. That region is cut out before mapping and spliced back after, with only
 * its Indonesian vocabulary translated through a tiny token map: the month
 * names and the KIND tags (MONTHS and KINDS below). The commit SUBJECTS stay
 * untouched, as gen-riwayat.js's header rules ("NO TRANSLATION of commit
 * subjects": ~500 chances to say something false about work that happened).
 * tests/core/en-support.test.mjs reads gen-riwayat.js and fails when it grows a
 * month or a kind this file does not know.
 *
 * ORDER: `npm run riwayat` (rewrites the log inside dukung.html) THEN
 * `npm run seo` (copies it into en/support.html). Run the other way round and
 * `seo:check` goes red, which is the point: the English log never lags the
 * Indonesian one unnoticed.
 *
 * URL FORM: `/en/support`, no trailing slash, no .html (vercel.json has
 * cleanUrls + trailingSlash:false). Change SUPPORT_EN_PATH here, nowhere else.
 */
import { mapMarkup, pick, EN_PATH, SUPPORT_EN } from './gen-en-page.js';

export const SUPPORT_EN_PATH = SUPPORT_EN; // defined once, in gen-en-page.js, which links to it
export const SUPPORT_EN_FILE = 'en/support.html';
export const SUPPORT_ID_PATH = '/dukung';

const LOG_START = '<!-- riwayat:start -->';
const LOG_END = '<!-- riwayat:end -->';

// The log's Indonesian vocabulary. Months: BULAN in gen-riwayat.js. Kinds: JENIS
// in gen-riwayat.js (every value, including the ones no commit has used yet).
export const MONTHS = {
  Januari: 'January', Februari: 'February', Maret: 'March', April: 'April', Mei: 'May', Juni: 'June',
  Juli: 'July', Agustus: 'August', September: 'September', Oktober: 'October', November: 'November', Desember: 'December',
};
export const KINDS = {
  Fitur: 'Feature', Perbaikan: 'Fix', Kecepatan: 'Speed', Tulisan: 'Copy', Tampilan: 'Look',
  'Rapi-rapi': 'Cleanup', Tes: 'Test', Catatan: 'Notes', Teknis: 'Technical',
};
// The one sentence of copy inside the region (the list's accessible name).
const LOG_LABEL = ['Daftar semua perubahan PDFLokal, dari yang paling baru', 'Every change to PDFLokal, newest first'];

export const banner = `<!-- GENERATED FILE, DO NOT EDIT BY HAND.
     Source: dukung.html (the page) + i18n/markup.en.support.json (the English).
     The work log inside it is dukung.html's, with its months and kinds translated.
     Regenerate with: npm run riwayat && npm run seo
     Hand edits are destroyed on the next run, and "npm run seo:check" fails CI. -->\n`;

// Cut the work-log rows out. Returns the page with an empty region plus the rows.
export function cutLog(html) {
  const a = html.indexOf(LOG_START);
  const b = html.indexOf(LOG_END);
  if (a < 0 || b < 0 || b < a) throw new Error('gen-en-support: dukung.html has lost its <!-- riwayat:start --> / <!-- riwayat:end --> markers. The work log cannot be carried to /en/support.');
  const from = a + LOG_START.length;
  return { page: html.slice(0, from) + html.slice(b), log: html.slice(from, b) };
}

// Translate the log's Indonesian vocabulary, and nothing else. Unknown month or
// kind throws: a new one in gen-riwayat.js must be given an English word here.
export function translateLog(log) {
  let out = log.replace(/(<time datetime="[^"]*">\d{1,2} )([^<\d]+?)( \d{4}<\/time>)/g, (_m, pre, month, post) => {
    if (!Object.hasOwn(MONTHS, month)) throw new Error(`gen-en-support: the work log has a month this file cannot say in English: ${JSON.stringify(month)}. Add it to MONTHS.`);
    return pre + MONTHS[month] + post;
  });
  out = out.replace(/(<b class="rw-jenis">)([^<]*)(<\/b>)/g, (_m, pre, kind, post) => {
    if (!Object.hasOwn(KINDS, kind)) throw new Error(`gen-en-support: the work log has a kind tag this file cannot say in English: ${JSON.stringify(kind)}. Add it to KINDS.`);
    return pre + KINDS[kind] + post;
  });
  const [from, to] = LOG_LABEL;
  if (!out.includes(`aria-label="${from}"`)) throw new Error('gen-en-support: the work log lost its aria-label; update LOG_LABEL to the new Indonesian sentence.');
  return out.replace(`aria-label="${from}"`, `aria-label="${to}"`);
}

function sub(html, re, replacement, label) {
  if (html.search(re) < 0) throw new Error(`gen-en-support: anchor not found in dukung.html: ${label}. The page changed; fix the pattern here, do not ship /en/support with the Indonesian ${label}.`);
  // A function replacement, so `$` in the new text is literal; captures come in as `...g`.
  return html.replace(re, (...m) => (typeof replacement === 'function' ? replacement(...m) : replacement));
}

// Every string of dukung.html (outside the log) that needs an English line.
export function sourceStrings(template) {
  const keys = new Set();
  mapMarkup(cutLog(template).page, (k) => { keys.add(k); });
  return keys;
}

export function renderEnSupport(template, map, { origin }) {
  const url = `${origin}${SUPPORT_EN_PATH}`;
  const { page, log } = cutLog(template);
  let html = page;
  if (/<script type="application\/ld\+json">/.test(html)) {
    throw new Error('gen-en-support: dukung.html now carries JSON-LD, which this generator does not translate. Teach it before shipping /en/support.');
  }

  // ---- the English -------------------------------------------------------------
  const used = new Set();
  const missing = [];
  // A key may carry a context ("Dukung PDFLokal @ href=\"/dukung\"": the footer
  // link says "Support Me", the page's own heading says "Support PDFLokal"). The
  // same mechanism gen-en-page.js uses; see pick() there.
  html = mapMarkup(html, (key, _kind, ctx) => {
    const k = pick(map, key, ctx);
    if (k === null) { missing.push(key); return undefined; }
    used.add(k);
    return map[k];
  });
  const orphaned = Object.keys(map).filter((k) => !used.has(k));
  if (orphaned.length) {
    throw new Error(`gen-en-support: i18n/markup.en.support.json has ${orphaned.length} source string(s) that dukung.html no longer contains:\n${orphaned.map((k) => `  - ${JSON.stringify(k)}`).join('\n')}\nThe Indonesian copy changed or went away. Update or delete the entry; never leave English describing text that is gone.`);
  }
  if (missing.length) {
    const uniq = [...new Set(missing)];
    throw new Error(`gen-en-support: ${uniq.length} string(s) in dukung.html have no English in i18n/markup.en.support.json:\n${uniq.map((k) => `  - ${JSON.stringify(k)}`).join('\n')}\nWithout an entry /en/support would ship them in Indonesian. Add each (use the same string for a brand or code-like word).`);
  }

  // ---- head: language, identity, hreflang --------------------------------------
  html = sub(html, /<html lang="id">/, '<html lang="en">', '<html lang>');
  html = sub(html, /<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${url}">`, 'canonical');
  html = sub(html, /<meta property="og:locale" content="id_ID">/, '<meta property="og:locale" content="en_US">', 'og:locale');
  // hreflang is NOT rewritten: the same id/en/x-default set on both pages is what
  // makes the pair reciprocal. Prove it is there rather than assume.
  if ((html.match(/<link rel="alternate" hreflang="/g) || []).length !== 3) {
    throw new Error('gen-en-support: dukung.html must carry exactly three hreflang links (id, en, x-default); /en/support reuses them verbatim.');
  }

  // ---- body: links go to English twins where they exist -------------------------
  html = sub(html, /<a class="ld-mark" href="\/"/, `<a class="ld-mark" href="${EN_PATH}"`, 'wordmark link');
  html = sub(html, /(<p class="dk-balik">\s*)<a href="\/">/, (_m, lead) => `${lead}<a href="${EN_PATH}">`, 'the way-back link');
  const selfLinks = html.split('href="/dukung"').length - 1;
  if (selfLinks < 3) throw new Error(`gen-en-support: expected the page's own /dukung link in the header, the drawer and the footer, found ${selfLinks}.`);
  html = html.split('href="/dukung"').join(`href="${SUPPORT_EN_PATH}"`);
  // /privasi has no English twin (the page is not translated): kept as is.

  // Both menus (desktop dropdown, mobile drawer) carry the same two options.
  html = swapAll(html,
    '<span class="ld-lang-opt is-active" aria-current="true" lang="id">Indonesia</span>',
    `<a class="ld-lang-opt" href="${SUPPORT_ID_PATH}" hreflang="id" lang="id">Bahasa Indonesia</a>`, 'the Indonesian language option');
  html = swapAll(html,
    `<a class="ld-lang-opt" href="${SUPPORT_EN_PATH}" hreflang="en" lang="en">English</a>`,
    '<span class="ld-lang-opt is-active" aria-current="true" lang="en">English</span>', 'the English language option');

  // ---- the work log goes back in, its months and kinds in English ---------------
  const marker = html.indexOf(LOG_START);
  if (marker < 0) throw new Error('gen-en-support: the log marker vanished while rendering.');
  const spliceAt = marker + LOG_START.length;
  html = html.slice(0, spliceAt) + translateLog(log) + html.slice(spliceAt);

  // Nothing Indonesian-only may survive the link rewrites.
  const live = html.replace(/<!--[\s\S]*?-->/g, '');
  if (/href="\/dukung"/.test(live.replace(new RegExp(`<a class="ld-lang-opt" href="${SUPPORT_ID_PATH}" hreflang="id" lang="id">Bahasa Indonesia</a>`, 'g'), ''))) {
    throw new Error('gen-en-support: a /dukung link survived on /en/support (only the language option may point there).');
  }
  return banner + html;
}

function swapAll(html, from, to, label) {
  const n = html.split(from).length - 1;
  if (n !== 2) throw new Error(`gen-en-support: expected ${label} twice in dukung.html (desktop menu + mobile drawer), found ${n}.`);
  return html.split(from).join(to);
}
