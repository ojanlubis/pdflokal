/*
 * THE ENGLISH EDITOR (/en) SAYS ONLY WHAT IT SHOULD, IN ONE LANGUAGE, ONCE.
 * ============================================================================
 * `en/index.html` is generated from index.html + i18n/markup.en.json by
 * scripts/gen-en-page.js. Four properties, each stated as the failure it
 * prevents:
 *
 *   1. THE GENERATOR SHOUTS. A source string that left index.html, a string
 *      that has no English, and a removal anchor that vanished all throw. A
 *      silent no-op here ships Indonesian on /en, or ships the QRIS button the
 *      founder keeps off it, and nothing else in the gate would notice.
 *   2. HREFLANG BELONGS TO `/` AND `/en` ONLY. index.html is the template of
 *      the 12 tool pages, so a copied set would declare `/` and `/en` as THEIR
 *      alternates (the FAQPage defect class). Each page's set is checked.
 *   3. /en REMOVES WHAT IT PROMISED TO: QRIS, /dukung, the Template row, the
 *      maker card. And it is self-canonical, lang="en", og:locale en_US.
 *   4. THE MAP CARRIES NO INDONESIAN and no em-dash (house rule).
 *
 * ⚠️ NON-VACUOUS: the hreflang reader is first pointed at `/`, which really has
 * three links; a reader that finds none there would pass all 12 pages for free.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderEnPage, sourceStrings, EN_PATH, EN_FILE } from '../../scripts/gen-en-page.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const TEMPLATE = read('index.html');
const MAP = JSON.parse(read('i18n/markup.en.json'));
const ORIGIN = 'https://www.pdflokal.id';
const SLUGS = JSON.parse(read('seo/pages.json')).pages.map((p) => p.slug);
const render = (tpl = TEMPLATE, map = MAP) => renderEnPage(tpl, map, { origin: ORIGIN });

const headOf = (html) => html.slice(0, html.indexOf('</head>')).replace(/<!--[\s\S]*?-->/g, '');
const hreflangs = (file) => Object.fromEntries(
  [...headOf(read(file)).matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map((m) => [m[1], m[2]]),
);
const markupOnly = (html) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/g, '');
const visibleLinks = (html) => [...markupOnly(html)
  .matchAll(/<a\b[^>]*\shref="([^"]*)"/g)].map((m) => m[1]);

// ---- 1. the generator shouts --------------------------------------------------

test('1a. CONTROL: the real template and the real map render', () => {
  assert.doesNotThrow(() => render());
});

test('1b. a source string that left index.html throws, naming it', () => {
  const edited = TEMPLATE.replace('Seret file ke sini, atau', 'Tarik file ke sini, atau');
  assert.notEqual(edited, TEMPLATE, 'the fixture edit did not land');
  assert.throws(() => render(edited), (e) => /no longer contains/.test(e.message) && e.message.includes('Seret file ke sini, atau'));
});

test('1c. a new Indonesian string with no English throws, naming it', () => {
  const edited = TEMPLATE.replace('<b>Gabung PDF</b>', '<b>Gabung PDF</b><span>Teks baru tanpa terjemahan</span>');
  assert.notEqual(edited, TEMPLATE);
  assert.throws(() => render(edited), (e) => /no English/.test(e.message) && e.message.includes('Teks baru tanpa terjemahan'));
});

test('1d. a map entry for text that does not exist throws', () => {
  assert.throws(() => render(TEMPLATE, { ...MAP, 'Kalimat yang tidak ada': 'A sentence that is not there' }), /no longer contains/);
});

test('1e. every removal anchor shouts when its block is gone', () => {
  const cuts = {
    'the Template row': /<section class="tl-band"[\s\S]*?<\/section>/,
    'the maker card': /<aside id="maker-card"[\s\S]*?<\/aside>/,
    'the QRIS donate button': /<button id="sc-donate">[\s\S]*?<\/button>/,
  };
  for (const [label, re] of Object.entries(cuts)) {
    const without = TEMPLATE.replace(re, '');
    assert.notEqual(without, TEMPLATE, `${label}: fixture edit did not land`);
    assert.throws(() => render(without), (e) => e.message.includes(label), `removing ${label} from the template did not throw`);
  }
});

test('1f. a template without the hreflang trio throws instead of shipping /en unpaired', () => {
  const without = TEMPLATE.replace(/[ \t]*<link rel="alternate" hreflang="[^"]*" href="[^"]*">\n/g, '');
  assert.notEqual(without, TEMPLATE);
  assert.throws(() => render(without), /three hreflang/);
});

test('1g. every string the template needs is in the map (the coverage gate behind the Playwright stoplist)', () => {
  const keys = sourceStrings(TEMPLATE);
  assert.ok(keys.size > 150, `only ${keys.size} source strings found, the extractor is blind`);
  const bare = [...keys].filter((k) => !Object.hasOwn(MAP, k) && !Object.keys(MAP).some((m) => m.startsWith(`${k} @ `)));
  assert.deepEqual(bare, [], `index.html strings with no English:\n  ${bare.join('\n  ')}`);
});

// ---- 2. hreflang --------------------------------------------------------------

test('2a. `/` and `/en` carry the same reciprocal set: id, en, x-default', () => {
  const want = { id: `${ORIGIN}/`, en: `${ORIGIN}${EN_PATH}`, 'x-default': `${ORIGIN}${EN_PATH}` };
  assert.deepEqual(hreflangs('index.html'), want, '`/` lost or changed its hreflang set (also proves the reader sees one)');
  assert.deepEqual(hreflangs(EN_FILE), want, '/en must carry the same set, or the pair is not reciprocal');
});

test('2b. none of the 12 generated pages carries hreflang (no twin, no set)', () => {
  assert.equal(SLUGS.length, 12);
  const bad = SLUGS.filter((s) => Object.keys(hreflangs(`${s}.html`)).length > 0);
  assert.deepEqual(bad, [], `these pages inherited the homepage's hreflang set: ${bad.join(', ')}`);
  const raw = SLUGS.filter((s) => /hreflang=/.test(headOf(read(`${s}.html`))));
  assert.deepEqual(raw, [], `hreflang text in the head of: ${raw.join(', ')}`);
});

test('2c. the sitemap lists /en once, in the same form as the hreflang and canonical', () => {
  const locs = [...read('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.equal(locs.filter((l) => l === `${ORIGIN}${EN_PATH}`).length, 1, `sitemap should list ${ORIGIN}${EN_PATH} exactly once`);
  assert.ok(!locs.some((l) => l.endsWith('/en/')), 'a trailing-slash /en/ in the sitemap would be a redirect (vercel.json trailingSlash:false)');
});

// ---- 3. what /en is -----------------------------------------------------------

test('3a. /en is lang="en", self-canonical, og:locale en_US', () => {
  const html = read(EN_FILE);
  assert.match(html, /<html lang="en">/);
  assert.match(html, new RegExp(`<link rel="canonical" href="${ORIGIN}${EN_PATH}">`));
  assert.match(html, new RegExp(`<meta property="og:url" content="${ORIGIN}${EN_PATH}">`));
  assert.match(html, /<meta property="og:locale" content="en_US">/);
  assert.doesNotMatch(html, /og:locale" content="id_ID"/);
  assert.match(html, /^<!-- GENERATED FILE, DO NOT EDIT BY HAND\./, 'the generated-file banner is gone');
});

test('3b. /en carries none of what it was told to drop', () => {
  const html = read(EN_FILE);
  const links = visibleLinks(html);
  assert.deepEqual(links.filter((h) => h.startsWith('/dukung')), [], '/dukung is Indonesian-only');
  for (const gone of ['id="maker-card"', 'class="tl-band"', 'id="sc-donate"', 'class="sc-qr"', 'qris.png', 'template.pdflokal.id', 'segera']) {
    assert.ok(!markupOnly(html).includes(gone), `/en still carries ${gone}`);
  }
  assert.ok(html.includes('Dibuat di Indonesia'), 'the brand pun stays');
});

test('3c. the privacy links stay on /privasi (the page is not translated)', () => {
  const links = visibleLinks(read(EN_FILE)).filter((h) => h.includes('privasi') || h.includes('privacy'));
  assert.ok(links.length >= 3, `expected the nav, mobile and footer privacy links, saw ${links.length}`);
  assert.deepEqual([...new Set(links)], ['/privasi']);
});

test('3d. the language link exists on both pages and points at the other one', () => {
  const id = visibleLinks(TEMPLATE.slice(TEMPLATE.indexOf('</head>')));
  assert.ok(id.filter((h) => h === EN_PATH).length >= 2, '`/` needs the English link in the desktop menu and the mobile drawer');
  const en = visibleLinks(read(EN_FILE).slice(read(EN_FILE).indexOf('</head>')));
  assert.ok(en.filter((h) => h === '/').length >= 2, '/en needs the Bahasa Indonesia link in the desktop menu and the mobile drawer');
  assert.match(read(EN_FILE), /<a class="ld-lang-opt" href="\/" hreflang="id" lang="id">Bahasa Indonesia<\/a>/);
});

test('3e. the wordmark on /en goes to /en, not to the Indonesian home', () => {
  assert.match(read(EN_FILE), new RegExp(`<a class="ld-mark" href="${EN_PATH}"`));
});

test('3f. the structured data on /en is English and says so; the FAQ matches the visible FAQ', () => {
  const html = read(EN_FILE);
  const blocks = [...headOf(html).matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
  const app = blocks.find((b) => b['@type'] === 'WebApplication');
  const faq = blocks.find((b) => b['@type'] === 'FAQPage');
  assert.ok(app && faq, 'both blocks should survive on /en');
  assert.equal(app.inLanguage, 'en-US');
  assert.equal(app.url, `${ORIGIN}${EN_PATH}`);
  const visible = html.slice(html.indexOf('<section class="ld-faq">'));
  for (const q of faq.mainEntity) {
    assert.ok(visible.includes(q.name), `FAQPage question not in the visible FAQ: ${q.name}`);
    assert.ok(visible.includes(q.acceptedAnswer.text), `FAQPage answer not in the visible FAQ: ${q.acceptedAnswer.text}`);
  }
});

test('3g. /en is exactly what the generator emits (the drift check, in-process)', () => {
  assert.equal(read(EN_FILE), render(), 'en/index.html differs from the generator output: run `npm run seo`');
});

// ---- 4. the map ---------------------------------------------------------------

test('4. the English carries no em-dash and no Indonesian stoplist word', () => {
  const STOP = /\b(dan|yang|untuk|atau|dari|dengan|ini|itu|kamu|nggak|aja|udah|saya|Unduh|halaman|Halaman|ketuk|Tarik|Pilih|Seret|Buka|Hapus|Kirim|Gratis|Cepat|Bahasa|Ukuran|Tutup|Batal|Pakai)\b/;
  // The brand pun, the company name and the language's own name are the exemptions.
  const EXEMPT = new Set(['Dibuat di Indonesia', '© 2026 PT Fauzan Karya Digital', 'Bahasa Indonesia']);
  const bad = [];
  for (const [src, en] of Object.entries(MAP)) {
    if (/[—–]/.test(en)) bad.push(`dash: ${en}`);
    if (!EXEMPT.has(en) && STOP.test(en)) bad.push(`indonesian: ${en}`);
    if (en.trim() === '') bad.push(`empty: ${src}`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
  assert.ok(Object.keys(MAP).length >= 150, 'the map shrank, check that nothing was deleted by accident');
});
