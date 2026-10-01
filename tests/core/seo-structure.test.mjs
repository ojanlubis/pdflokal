/*
 * A GENERATED PAGE DECLARES ONLY WHAT IT SHOWS.
 * ============================================================================
 * `scripts/gen-seo-pages.js` used to replace ONE ld+json block of index.html's
 * two. The other, the landing's FAQPage, rode into all 12 tool pages: Q&As that
 * are on `/` and on no tool page, so structured data that disagreed with the
 * visible text, and the same FAQPage as the homepage twelve times over.
 *
 * ⚠️ WHAT WOULD LOOK IDENTICAL IF BROKEN: head-tags.test.mjs reads the FIRST
 * ld+json block and checks its types, so it stayed green with the stowaway
 * sitting right behind it. This reads ALL of them.
 *
 * ⚠️ NON-VACUOUS BY CONSTRUCTION: the detector is first pointed at index.html,
 * which really does carry a FAQPage. A parser that cannot find one there would
 * pass every tool page for free.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const PAGES = JSON.parse(read('seo/pages.json')).pages;

const ldBlocks = (file) => {
  const html = read(file);
  const head = html.slice(0, html.indexOf('</head>'));
  return [...head.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map((m) => JSON.parse(m[1]));
};
const typesOf = (node) => JSON.stringify(node).match(/"@type":"([A-Za-z]+)"/g)?.map((t) => t.slice(9, -1)) ?? [];

test('0. the detector can see a FAQPage where one exists (the landing)', () => {
  const landing = ldBlocks('index.html');
  assert.ok(landing.length >= 2, `index.html should carry two ld+json blocks, found ${landing.length}`);
  assert.ok(landing.some((b) => typesOf(b).includes('FAQPage')), 'index.html no longer has a FAQPage block, so this suite proves nothing; rethink it');
});

test('1. each generated page has exactly one ld+json block and it is not a FAQPage', () => {
  assert.equal(PAGES.length, 12, `expected 12 generated pages, got ${PAGES.length}`);
  const bad = [];
  for (const p of PAGES) {
    const blocks = ldBlocks(`${p.slug}.html`);
    if (blocks.length !== 1) bad.push(`${p.slug}: ${blocks.length} ld+json blocks, expected 1`);
    for (const b of blocks) {
      if (typesOf(b).includes('FAQPage')) bad.push(`${p.slug}: carries the homepage's FAQPage`);
    }
  }
  assert.deepEqual(bad, [], `generated pages declare structured data that is not theirs:\n  ${bad.join('\n  ')}`);
});

test('2. the one block is the page\'s own: its url, its language', () => {
  const bad = [];
  for (const p of PAGES) {
    const [block] = ldBlocks(`${p.slug}.html`);
    const app = block?.['@graph']?.find((n) => n['@type'] === 'SoftwareApplication');
    if (!app) { bad.push(`${p.slug}: no SoftwareApplication node`); continue; }
    if (app.url !== `https://www.pdflokal.id/${p.slug}`) bad.push(`${p.slug}: schema url ${app.url}`);
    const want = { id: 'id-ID', en: 'en-US' }[p.lang ?? 'id'];
    if (app.inLanguage !== want) bad.push(`${p.slug}: inLanguage ${app.inLanguage}, expected ${want}`);
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});
