/*
 * THE ENGLISH SUPPORT PAGE (/en/support) SAYS WHAT /dukung SAYS, IN ENGLISH, ONCE.
 * ============================================================================
 * `en/support.html` is generated from dukung.html + i18n/markup.en.support.json
 * by scripts/gen-en-support.js (the founder's ruling 2026-10-02: /en is the same
 * product, only the language differs). Each property, as the failure it prevents:
 *
 *   1. THE GENERATOR SHOUTS, both directions: a string that left dukung.html
 *      leaves orphaned English; a new string without English ships in Indonesian.
 *   2. THE WORK LOG IS TRANSLATED BY TOKEN, NEVER BY ROW. Months and kind tags
 *      become English; the commit subjects are byte-identical to the source
 *      (gen-riwayat.js: "NO TRANSLATION of commit subjects"). An unknown month
 *      or kind throws, and the vocabulary is read out of gen-riwayat.js itself,
 *      so a kind added there without English here fails this file.
 *   3. THE PAIR IS RECIPROCAL: the same id/en/x-default set on both pages, each
 *      page self-canonical and named by its own hreflang entry.
 *   4. NO INDONESIAN SURVIVES outside the log's commit subjects and the declared
 *      "Bahasa Indonesia" language link; no /dukung link survives except that
 *      option; the QR block is identical to the Indonesian one.
 *   5. EVERY ASSET IS ROOT-ABSOLUTE (the page now also lives one directory
 *      deeper, where `images/x.png` would resolve to /en/images/x.png).
 *
 * ⚠️ NON-VACUOUS: the log reader is first shown it finds hundreds of rows, and
 * the stoplist is first pointed at dukung.html, which is Indonesian by
 * construction and must hit plenty.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  renderEnSupport, sourceStrings, cutLog, translateLog, MONTHS, KINDS,
  SUPPORT_EN_PATH, SUPPORT_EN_FILE, SUPPORT_ID_PATH,
} from '../../scripts/gen-en-support.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const TEMPLATE = read('dukung.html');
const MAP = JSON.parse(read('i18n/markup.en.support.json'));
const ORIGIN = 'https://www.pdflokal.id';
const render = (tpl = TEMPLATE, map = MAP) => renderEnSupport(tpl, map, { origin: ORIGIN });

const headOf = (html) => html.slice(0, html.indexOf('</head>')).replace(/<!--[\s\S]*?-->/g, '');
const hreflangs = (html) => Object.fromEntries(
  [...headOf(html).matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map((m) => [m[1], m[2]]),
);
const canonical = (html) => /<link rel="canonical" href="([^"]+)">/.exec(headOf(html))?.[1];
const withoutLog = (html) => cutLog(html).page;
const markupOnly = (html) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/g, '');
const subjects = (log) => [...log.matchAll(/<span>([\s\S]*?)<\/span><\/li>/g)].map((m) => m[1]);

// ---- 1. the generator shouts ----------------------------------------------------

test('1a. CONTROL: the real page and the real map render', () => {
  assert.doesNotThrow(() => render());
  assert.ok(sourceStrings(TEMPLATE).size > 40, 'the extractor is blind');
});

test('1b. a source string that left dukung.html throws, naming it', () => {
  const edited = TEMPLATE.replace('<h2>Tanya Jawab</h2>', '<h2>Pertanyaan</h2>');
  assert.notEqual(edited, TEMPLATE, 'the fixture edit did not land');
  assert.throws(() => render(edited), (e) => /no longer contains/.test(e.message) && e.message.includes('Tanya Jawab'));
});

test('1c. a new Indonesian string with no English throws, naming it', () => {
  const edited = TEMPLATE.replace('<h2>Tanya Jawab</h2>', '<h2>Tanya Jawab</h2><p>Kalimat baru tanpa terjemahan</p>');
  assert.notEqual(edited, TEMPLATE);
  assert.throws(() => render(edited), (e) => /no English/.test(e.message) && e.message.includes('Kalimat baru tanpa terjemahan'));
});

test('1d. a map entry for text that does not exist throws', () => {
  assert.throws(() => render(TEMPLATE, { ...MAP, 'Kalimat yang tidak ada': 'A sentence that is not there' }), /no longer contains/);
});

test('1e. a template that lost the work-log markers, or the hreflang trio, throws', () => {
  assert.throws(() => render(TEMPLATE.replace('<!-- riwayat:end -->', '')), /riwayat/);
  const noHreflang = TEMPLATE.replace(/[ \t]*<link rel="alternate" hreflang="[^"]*" href="[^"]*">\n/g, '');
  assert.notEqual(noHreflang, TEMPLATE);
  assert.throws(() => render(noHreflang), /three hreflang/);
});

// ---- 2. the work log ------------------------------------------------------------

test('2a. CONTROL: the log reader sees the log (hundreds of rows, every kind of token)', () => {
  const { log } = cutLog(TEMPLATE);
  assert.ok((log.match(/<li>/g) || []).length > 100, 'the log is missing or the reader is blind');
  assert.ok(/<b class="rw-jenis">/.test(log) && /<time datetime=/.test(log));
});

test('2b. months and kinds are English, commit subjects are untouched, row for row', () => {
  const src = cutLog(TEMPLATE).log;
  const out = cutLog(read(SUPPORT_EN_FILE)).log;
  assert.equal((out.match(/<li>/g) || []).length, (src.match(/<li>/g) || []).length, 'row count changed');
  assert.deepEqual(subjects(out), subjects(src), 'a commit subject was altered');
  for (const id of Object.keys(MONTHS).filter((m) => m !== MONTHS[m])) {
    assert.ok(!new RegExp(`>\\d{1,2} ${id} \\d{4}</time>`).test(out), `Indonesian month ${id} survived`);
  }
  for (const id of Object.keys(KINDS)) {
    assert.ok(!out.includes(`<b class="rw-jenis">${id}</b>`), `Indonesian kind ${id} survived`);
  }
  assert.match(out, /<time datetime="2025-12-20">20 December 2025<\/time>/, 'Desember did not become December');
  assert.match(out, /<b class="rw-jenis">Feature<\/b>/);
  assert.match(out, /aria-label="Every change to PDFLokal, newest first"/);
});

test('2c. an unknown month or kind throws instead of shipping Indonesian', () => {
  assert.throws(() => translateLog('<time datetime="2026-01-01">1 Bulanbaru 2026</time>'), /month/);
  assert.throws(() => translateLog('<b class="rw-jenis">Kategoribaru</b>'), /kind/);
});

test('2d. the vocabulary is read out of gen-riwayat.js: nothing it can write is unknown here', () => {
  const src = read('scripts/gen-riwayat.js');
  const bulan = [...src.slice(src.indexOf('const BULAN'), src.indexOf('];', src.indexOf('const BULAN'))).matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const jenisBlock = src.slice(src.indexOf('const JENIS'), src.indexOf('};', src.indexOf('const JENIS')));
  const jenis = [...jenisBlock.matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.equal(bulan.length, 12, 'could not read the twelve months out of gen-riwayat.js');
  assert.ok(jenis.length >= 10, `read only ${jenis.length} kinds out of gen-riwayat.js`);
  assert.deepEqual(bulan.filter((m) => !Object.hasOwn(MONTHS, m)), [], 'a month gen-riwayat.js writes has no English');
  assert.deepEqual([...new Set(jenis)].filter((k) => !Object.hasOwn(KINDS, k)), [], 'a kind gen-riwayat.js writes has no English');
});

// ---- 3. the pair is reciprocal --------------------------------------------------

test('3. dukung and /en/support carry the same hreflang set, each self-canonical', () => {
  const en = read(SUPPORT_EN_FILE);
  const want = { id: `${ORIGIN}${SUPPORT_ID_PATH}`, en: `${ORIGIN}${SUPPORT_EN_PATH}`, 'x-default': `${ORIGIN}${SUPPORT_EN_PATH}` };
  assert.deepEqual(hreflangs(TEMPLATE), want, 'dukung.html lost or changed its hreflang set (also proves the reader sees one)');
  assert.deepEqual(hreflangs(en), want, 'the pair is not reciprocal');
  assert.equal(canonical(TEMPLATE), want.id);
  assert.equal(canonical(en), want.en);
  assert.match(en, /<html lang="en">/);
  assert.match(en, /<meta property="og:locale" content="en_US">/);
  assert.match(TEMPLATE, /<html lang="id">/);
  assert.match(en, /^<!-- GENERATED FILE, DO NOT EDIT BY HAND\./, 'the generated-file banner is gone');
});

test('3b. the sitemap lists both, once each, as clean URLs', () => {
  const locs = [...read('sitemap.xml').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.equal(locs.filter((l) => l === `${ORIGIN}${SUPPORT_EN_PATH}`).length, 1);
  assert.equal(locs.filter((l) => l === `${ORIGIN}${SUPPORT_ID_PATH}`).length, 1);
  assert.deepEqual(locs.filter((l) => l.endsWith('.html')), [], 'a .html sitemap URL answers 308 on Vercel');
});

// ---- 4. no Indonesian survives --------------------------------------------------

const STOP = /\b(dan|yang|untuk|atau|dengan|dari|ini|itu|kamu|nggak|aja|udah|saya|ke|di|jadi|mau|bisa|biar|Unduh|halaman|ketuk|Tarik|Pilih|Seret|Buka|Hapus|Kirim|Gratis|Cepat|Tutup|Batal|Pakai|Kembali|Bantu|Traktir|Kopi|Dukung|Kasih|Makasih|Balik|Tanya|Jawab)\b/i;
const EXEMPT = new Set(['Dibuat di Indonesia', '© 2026 PT Fauzan Karya Digital', 'Bahasa Indonesia']);
function hits(html) {
  const body = markupOnly(withoutLog(html)).replace(/<[^>]*\blang="id"[^>]*>[^<]*<\/[a-z]+>/g, '');
  const found = [];
  for (const m of body.matchAll(/>([^<>]+)</g)) {
    const t = m[1].replace(/\s+/g, ' ').trim();
    if (t && !EXEMPT.has(t) && STOP.test(t)) found.push(`text: ${t}`);
  }
  for (const m of body.matchAll(/\s(?:aria-label|title|alt|placeholder|content)="([^"]*)"/g)) {
    if (STOP.test(m[1]) && !EXEMPT.has(m[1])) found.push(`attr: ${m[1]}`);
  }
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
  if (title && STOP.test(title)) found.push(`title: ${title}`);
  return found;
}

test('4a. CONTROL: the stoplist is not blind (dukung.html is full of Indonesian)', () => {
  assert.ok(hits(TEMPLATE).length > 25, `only ${hits(TEMPLATE).length} hits on the Indonesian page`);
});

test('4b. /en/support has no Indonesian outside the log subjects and the language link', () => {
  assert.deepEqual(hits(read(SUPPORT_EN_FILE)), []);
});

test('4c. no /dukung link survives except the "Bahasa Indonesia" option; links go to English twins', () => {
  const html = markupOnly(read(SUPPORT_EN_FILE));
  const hrefs = [...html.matchAll(/<a\b[^>]*\shref="([^"]*)"[^>]*>/g)].map((m) => [m[1], m[0]]);
  const dukung = hrefs.filter(([h]) => h === SUPPORT_ID_PATH);
  assert.equal(dukung.length, 2, 'only the two language options (desktop + drawer) may point at /dukung');
  for (const [, tag] of dukung) assert.match(tag, /hreflang="id"/);
  assert.ok(hrefs.filter(([h]) => h === SUPPORT_EN_PATH).length >= 3, 'header, drawer and footer Support links');
  assert.match(html, /<a class="ld-mark" href="\/en"/);
  assert.match(html, /<p class="dk-balik">\s*<a href="\/en">/);
  assert.ok(hrefs.some(([h]) => h === '/privasi'), '/privasi (no English twin) stays');
});

test('4d. the QR block is the same image and the same download as the Indonesian page', () => {
  const grab = (html) => [/<img src="\/images\/qris\.png"[^>]*class="qr-image"[^>]*>/, /<a class="qr-unduh"[^>]*download="[^"]*"[^>]*>/].map((re) => (re.exec(html) || [''])[0].replace(/alt="[^"]*"/, ''));
  const id = grab(TEMPLATE); const en = grab(read(SUPPORT_EN_FILE));
  assert.ok(id.every(Boolean), 'the QR markup was not found on dukung.html');
  assert.deepEqual(en, id);
  assert.match(read(SUPPORT_EN_FILE), />\s*Download QR\s*</);
});

test('4e. the English carries no em-dash', () => {
  const bad = Object.values(MAP).filter((v) => /[—–]/.test(v));
  assert.deepEqual(bad, []);
});

// ---- 5. assets are root-absolute ------------------------------------------------

test('5. every src/href on dukung.html is root-absolute, an absolute URL or a fragment', () => {
  const rel = [...markupOnly(withoutLog(TEMPLATE)).matchAll(/\s(?:src|href)="([^"]*)"/g)].map((m) => m[1])
    .filter((u) => u && !/^(\/|https?:|#|mailto:)/.test(u));
  assert.deepEqual(rel, [], 'a relative URL resolves under /en/ on the twin and 404s');
  const mods = [...TEMPLATE.matchAll(/<script[^>]*\ssrc="([^"]*)"/g)].map((m) => m[1]).filter((u) => !/^(\/|https?:)/.test(u));
  assert.deepEqual(mods, []);
});

// ---- the file is what the generator emits ---------------------------------------

test('6. en/support.html is exactly what the generator emits (drift check, in-process)', () => {
  assert.equal(read(SUPPORT_EN_FILE), render(), 'en/support.html differs from the generator output: run `npm run riwayat && npm run seo`');
});
