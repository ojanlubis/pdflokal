/*
 * HIS PHOTO NEVER APPEARS WITHOUT HIS NAME AND HIS LINK.
 * ============================================================================
 * His ask, 2026-11-03: every place with his photo and name behaves the same:
 * the photo, "okeojan" beside it, "Fauzan Lubis" smaller underneath, photo and
 * name one link to his Instagram in a new tab. The look lives in
 * css/ojan-id.css; THIS file is the one rule for the markup, over every page a
 * browser can be served (generated pages included, so a template drift that
 * `seo:check` cannot see still goes red here).
 *
 * Why a guard and not just the markup: the old blocks were six hand-written
 * variants that drifted (one linked mesindev.com, one had no name, one said
 * "Foto Ojan"). A seventh copy-pasted from an old SEO page would drift again.
 * And a mistyped handle does not 404: Instagram hands a near-miss username to
 * whoever owns it, so every Instagram href on the site must be exactly IG.
 * Handle source: ~/machine/engine/wiki/machine/public-identity.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const IG = 'https://www.instagram.com/okeojan.lubis/';
const PHOTO = '/images/ojan.jpg';

// Every served page: the root's .html files and /en. Lab and old-wing pages are
// included on purpose; a photo there is a photo on the site.
function pages() {
  const root = fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'));
  const en = fs.readdirSync(path.join(ROOT, 'en')).filter((f) => f.endsWith('.html')).map((f) => `en/${f}`);
  return [...root, ...en].map((f) => ({ f, html: fs.readFileSync(path.join(ROOT, f), 'utf8') }));
}

// Comments may name the file; only markup counts.
const strip = (html) => html.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const BLOCK = /<a class="oj oj-(?:s|m|l|xl)(?: oj-stack)?"([^>]*)>([\s\S]*?)<\/a>/g;

test('every photo of him sits inside the one block, and each block is whole', () => {
  let photos = 0;
  let blocks = 0;
  for (const { f, html } of pages()) {
    const body = strip(html);
    for (const m of body.matchAll(BLOCK)) {
      blocks++;
      const [, attrs, inner] = m;
      assert.match(attrs, new RegExp(`href="${IG.replace(/[.]/g, '\\.')}"`), `${f}: a block links somewhere other than ${IG}`);
      assert.match(attrs, /target="_blank"/, `${f}: a block opens in the same tab`);
      assert.match(attrs, /rel="noopener"/, `${f}: a block without rel=noopener`);
      assert.ok(inner.includes(`src="${PHOTO}"`), `${f}: a block without his photo`);
      assert.match(inner, /class="oj-name">okeojan /, `${f}: a block without "okeojan"`);
      assert.match(inner, /class="oj-real">Fauzan Lubis</, `${f}: a block without "Fauzan Lubis"`);
      assert.match(inner, /class="oj-face"[^>]*alt=""/, `${f}: the photo repeats the name to a screen reader (alt must be empty, the link text names him)`);
    }
    const rest = body.replace(BLOCK, '');
    const stray = rest.split(PHOTO).length - 1;
    assert.equal(stray, 0, `${f}: ${stray} photo(s) of him outside the shared block (css/ojan-id.css)`);
    photos += body.split(PHOTO).length - 1;
  }
  // Guard the instrument: a walk that found nothing would pass for free.
  // index.html has 4 (maker, feedback, vote, support card), dukung and privasi 1 each.
  assert.ok(blocks >= 6, `only ${blocks} blocks found; the walk is not reading the pages`);
  assert.equal(photos, blocks, 'one photo per block');
});

test('the source pages carry exactly the places he approved', () => {
  const count = (f) => (strip(fs.readFileSync(path.join(ROOT, f), 'utf8')).match(BLOCK) || []).length;
  assert.equal(count('index.html'), 4);
  assert.equal(count('dukung.html'), 1);
  assert.equal(count('privasi.html'), 1);
});

test('no near-miss Instagram handle anywhere: every instagram.com link is his exact URL', () => {
  for (const { f, html } of pages()) {
    for (const [href] of strip(html).matchAll(/https?:\/\/(?:www\.)?instagram\.com\/[^"'\s<)]*/g)) {
      assert.equal(href, IG, `${f}: ${href}`);
    }
  }
});

test('every page that shows the block loads its stylesheet', () => {
  for (const { f, html } of pages()) {
    if (!strip(html).match(BLOCK)) continue;
    assert.ok(html.includes('<link rel="stylesheet" href="/css/ojan-id.css">'), `${f}: shows the block but never loads css/ojan-id.css`);
  }
});
