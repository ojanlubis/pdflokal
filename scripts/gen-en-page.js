/*
 * PDFLokal — scripts/gen-en-page.js  (THE ENGLISH EDITOR, /en)
 * ============================================================================
 * Renders `en/index.html` from index.html + i18n/markup.en.json. Called by
 * scripts/gen-seo-pages.js (`npm run seo`), which owns writing it and the
 * `--check` drift test. This file is PURE: string in, string out, so a core
 * test can prove the shouts below without running the whole generator.
 *
 * THE MAP IS EXACT STRINGS, Indonesian source -> English, and nothing else.
 * Every text node, aria-label, title, alt, placeholder and head <meta>
 * description in index.html is one entry. Whole-string match after collapsing
 * whitespace, never a substring: "Gambar" (the sig-modal tab) must not
 * rewrite the middle of "Jenis gambar".
 *
 * TWO SHOUTS, one per direction of drift (the sub() pattern, both ways):
 *   - a key in the map that index.html no longer contains: the source copy was
 *     edited or deleted and its English is now orphaned. Throw.
 *   - a string in index.html that the map does not carry: new Indonesian copy
 *     would ship on /en as Indonesian. Throw.
 * Both name the string. Neither is a warning, because a warning is a file
 * nobody opens.
 *
 * WHAT /en CARRIES: EVERYTHING. The founder's ruling, 2026-10-02: "anggaplah itu
 * cuma perbedaan bahasa tapi semua tetap sama" — `/en` is the SAME product as `/`
 * in English, so the Template row, the maker card, the QRIS button and its QR all
 * stay and are translated like any other string. The one rewrite is a link: every
 * `/dukung` points at its English twin `/en/support` (scripts/gen-en-support.js),
 * `/dukung#development` included, and the generator throws if a `/dukung` href
 * would reach the page. (Until 2026-10-02 these blocks were cut from /en and the
 * generator threw if /dukung survived; that was the opposite ruling.)
 *
 * ONE URL, ONE LANGUAGE. <html lang="en"> is what js/lib/i18n.js reads. The
 * hreflang set is the SAME three links as `/` (reciprocal by being identical);
 * canonical is self. No redirect anywhere.
 *
 * URL FORM: `/en`, no trailing slash. vercel.json has trailingSlash:false, so
 * `/en/` answers 308 -> `/en` (measured on prod: /privasi/ and /images/ both
 * 308). A canonical, hreflang or sitemap entry that names a URL that redirects
 * is a defect, so every one of them uses EN_PATH. Change it here, nowhere else.
 */

export const EN_PATH = '/en';
export const EN_FILE = 'en/index.html';

// Whole-document tokenizer: comments, <script>/<style> bodies, tags (quote-aware),
// text. Scripts and styles are opaque here; JSON-LD is handled on its own.
const TOKEN = /<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<(?:[^>"']|"[^"]*"|'[^']*')+>|[^<]+/g;
const ATTR = /(\s)([a-zA-Z:-]+)="([^"]*)"/g;
const TEXT_ATTRS = new Set(['aria-label', 'title', 'alt', 'placeholder']);
const META_NAMES = new Set(['description', 'keywords', 'twitter:title', 'twitter:description', 'og:title', 'og:description']);
const HAS_LETTER = /\p{L}/u;

// Collapse whitespace the way a browser would, so a paragraph wrapped across
// source lines is still one key.
export const norm = (s) => s.replace(/\s+/g, ' ').trim();

// Does this tag carry a translatable `content` (a head <meta>)?
function metaContentIsCopy(tag) {
  if (!/^<meta\b/i.test(tag)) return false;
  const id = /\s(?:name|property)="([^"]*)"/.exec(tag);
  return Boolean(id && META_NAMES.has(id[1]));
}

// Walk every translatable string in the markup. `fn(key, kind)` may return a
// replacement string (raw, as it will appear in the HTML) or undefined.
// Returns the rewritten html.
export function mapMarkup(html, fn) {
  let lastTag = '';
  return html.replace(TOKEN, (tok, scriptOrStyle) => {
    if (tok.startsWith('<!--') || scriptOrStyle) return tok;
    if (tok[0] !== '<') {
      const key = norm(tok);
      if (!key || !HAS_LETTER.test(key)) return tok;
      const out = fn(key, 'text', lastTag);
      if (out === undefined) return tok;
      return tok.slice(0, tok.length - tok.trimStart().length) + out + tok.slice(tok.trimEnd().length);
    }
    lastTag = tok;
    const meta = metaContentIsCopy(tok);
    return tok.replace(ATTR, (whole, sp, name, value) => {
      if (!TEXT_ATTRS.has(name) && !(meta && name === 'content')) return whole;
      const key = norm(value);
      if (!key || !HAS_LETTER.test(key)) return whole;
      const out = fn(key, 'attr', tok);
      if (out === undefined) return whole;
      if (out.includes('"')) throw new Error(`gen-en-page: the English for "${key}" contains a double quote and would break its attribute.`);
      return `${sp}${name}="${out}"`;
    });
  });
}

// ONE WORD, TWO MEANINGS. "Gambar" is the sheet's "Image" and the signature
// tab's "Draw"; "Ulangi" is Redo and the canvas's "Start over". A flat map
// cannot say both, so an entry may carry a context: `"Gambar @ data-tab=\"draw\""`
// applies only where the enclosing opening tag contains that text. The plain
// key is the default. Used sparingly; the header comment of the map is JSON, so
// it is documented here.
export const CTX = ' @ ';
function pick(map, key, ctx) {
  for (const k of Object.keys(map)) {
    if (k.startsWith(key + CTX) && ctx.includes(k.slice(key.length + CTX.length))) return k;
  }
  return Object.hasOwn(map, key) ? key : null;
}

// JSON-LD strings that are copy. Everything else (urls, @type, price, ...) is
// data and stays.
function ldCopyPaths(node, out = [], parent = null, key = null) {
  if (Array.isArray(node)) { node.forEach((v, i) => ldCopyPaths(v, out, node, i)); return out; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) ldCopyPaths(v, out, node, k);
    return out;
  }
  if (typeof node !== 'string') return out;
  const copy = key === 'description' || key === 'text'
    || (typeof key === 'number') // featureList items
    || (key === 'name' && parent?.['@type'] === 'Question');
  if (copy && HAS_LETTER.test(node)) out.push({ parent, key, value: node });
  return out;
}

const LD = /(<script type="application\/ld\+json">)([\s\S]*?)(<\/script>)/g;

// Every string of index.html that needs an English line: markup + JSON-LD copy.
export function sourceStrings(template) {
  const html = relinkSupport(template);
  const keys = new Set();
  mapMarkup(html, (k) => { keys.add(k); });
  for (const m of html.matchAll(LD)) {
    for (const { value } of ldCopyPaths(JSON.parse(m[2]))) keys.add(norm(value));
  }
  return keys;
}

function sub(html, re, replacement, label) {
  if (html.search(re) < 0) throw new Error(`gen-en-page: anchor not found in index.html: ${label}. The template changed; fix the pattern here, do not ship /en with the Indonesian ${label}.`);
  return html.replace(re, () => replacement);
}

export const banner = `<!-- GENERATED FILE, DO NOT EDIT BY HAND.
     Source: index.html (the shell) + i18n/markup.en.json (the English).
     Regenerate with: npm run seo
     Hand edits are destroyed on the next run, and "npm run seo:check" fails CI. -->\n`;

// /dukung has an English twin. Every link to it on /en goes there, the work-log
// anchor included (`/dukung#development` -> `/en/support#development`). Shared by
// the renderer and by sourceStrings(). Shouts if there is nothing to rewrite (the
// template lost its support links: fix the pattern, do not ship /en unlinked) and
// if any /dukung href is still live afterwards.
export const SUPPORT_EN = '/en/support';
export function relinkSupport(template) {
  const html = template.replace(/href="\/dukung(?=["#?])/g, `href="${SUPPORT_EN}`);
  if (html === template) throw new Error('gen-en-page: no /dukung link found in index.html to point at /en/support. The template changed; fix the pattern here, do not ship /en without its support links.');
  if (/href="\/dukung/.test(mapMarkupNoComments(html))) throw new Error('gen-en-page: a /dukung href reached /en. Every support link on /en must be /en/support.');
  return html;
}

export function renderEnPage(template, map, { origin }) {
  const url = `${origin}${EN_PATH}`;
  let html = relinkSupport(template);

  // ---- the English -------------------------------------------------------------
  const used = new Set();
  const missing = [];
  html = mapMarkup(html, (key, _kind, ctx) => {
    const k = pick(map, key, ctx);
    if (k === null) { missing.push(key); return undefined; }
    used.add(k);
    return map[k];
  });
  html = html.replace(LD, (whole, open, json, close) => {
    const doc = JSON.parse(json);
    for (const p of ldCopyPaths(doc)) {
      const key = norm(p.value);
      if (!Object.hasOwn(map, key)) { missing.push(key); continue; }
      used.add(key);
      p.parent[p.key] = map[key];
    }
    if (doc['@type'] === 'WebApplication') {
      doc.url = `${url}`;
      doc.inLanguage = 'en-US';
    }
    return `${open}\n${JSON.stringify(doc, null, 2)}\n${close}`;
  });
  const orphaned = Object.keys(map).filter((k) => !used.has(k));
  if (orphaned.length) {
    throw new Error(`gen-en-page: i18n/markup.en.json has ${orphaned.length} source string(s) that index.html no longer contains:\n${orphaned.map((k) => `  - ${JSON.stringify(k)}`).join('\n')}\nThe Indonesian copy changed or went away. Update or delete the entry; never leave English describing text that is gone.`);
  }
  if (missing.length) {
    const uniq = [...new Set(missing)];
    throw new Error(`gen-en-page: ${uniq.length} string(s) in index.html have no English in i18n/markup.en.json:\n${uniq.map((k) => `  - ${JSON.stringify(k)}`).join('\n')}\nWithout an entry /en would ship them in Indonesian. Add each (use the same string for a brand or code-like word).`);
  }

  // ---- head: language, identity, hreflang --------------------------------------
  html = sub(html, /<html lang="id">/, '<html lang="en">', '<html lang>');
  html = sub(html, /<link rel="canonical" href="[^"]*">/, `<link rel="canonical" href="${url}">`, 'canonical');
  html = sub(html, /<meta property="og:url" content="[^"]*">/, `<meta property="og:url" content="${url}">`, 'og:url');
  html = sub(html, /<meta property="og:locale" content="id_ID">/, '<meta property="og:locale" content="en_US">', 'og:locale');
  // hreflang is NOT rewritten: /en carries the same id/en/x-default set as `/`,
  // which is what makes the pair reciprocal. Prove it is there rather than assume.
  if ((html.match(/<link rel="alternate" hreflang="/g) || []).length !== 3) {
    throw new Error('gen-en-page: index.html must carry exactly three hreflang links (id, en, x-default); /en reuses them verbatim.');
  }

  // ---- body: the language switch and the way home ------------------------------
  html = sub(html, /<a class="ld-mark" href="\/"/, `<a class="ld-mark" href="${EN_PATH}"`, 'wordmark link');
  // Both menus (desktop dropdown, mobile drawer) carry the same two options.
  html = swapAll(html,
    '<span class="ld-lang-opt is-active" aria-current="true" lang="id">Indonesia</span>',
    '<a class="ld-lang-opt" href="/" hreflang="id" lang="id">Bahasa Indonesia</a>', 'the Indonesian language option');
  html = swapAll(html,
    `<a class="ld-lang-opt" href="${EN_PATH}" hreflang="en" lang="en">English</a>`,
    '<span class="ld-lang-opt is-active" aria-current="true" lang="en">English</span>', 'the English language option');

  return banner + html;
}

function swapAll(html, from, to, label) {
  const n = html.split(from).length - 1;
  if (n !== 2) throw new Error(`gen-en-page: expected ${label} twice in index.html (desktop menu + mobile drawer), found ${n}.`);
  return html.split(from).join(to);
}

// Markup with comments and script/style bodies blanked, for "is this link really
// in the page" checks (the template's comments mention /dukung freely).
function mapMarkupNoComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/g, '');
}
