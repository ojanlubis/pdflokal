// /privasi loads no Google Ads tag (seat decisions.md 2026-10-01, his ruling):
// the page that lists the cookies must not be the one setting Ads' cookies.
// GA4 stays; only the AW- carrier and its config call are banned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../privasi.html', import.meta.url), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, '');

test('privasi.html neither loads nor configures the Google Ads tag', () => {
  assert.doesNotMatch(html, /gtag\/js\?id=AW-/, 'privasi.html loads the Ads carrier');
  assert.doesNotMatch(html, /gtag\(\s*'config'\s*,\s*'AW-/, 'privasi.html configures an AW- id');
});

test('privasi.html still loads GA4', () => {
  assert.match(html, /gtag\/js\?id=G-7J8JF8XZ1Q/);
});
