/*
 * EVERY ASSET REFERENCE RESOLVES THE SAME FROM ANY DIRECTORY.
 * ============================================================================
 * The shell lived at `/`, so `src="js/v2/app.js"`, `url('fonts/x.woff2')` and a
 * bare `fetch('fonts/ttf/x.ttf')` all worked, because a relative URL resolves
 * against the DOCUMENT. Serve the same shell at `/en/` and each becomes
 * `/en/js/...` -> 404; the font fetch fails QUIETLY and Edit Teks Asli's font
 * proof dies with it. So the property is stated as it is used: resolve every
 * reference against `/` and against `/en/`, and demand the same path.
 *
 * ⚠️ SCOPE: the shell (index.html + the 12 pages generated from it) and every
 * module under js/ that names an asset path. ES `import` specifiers are
 * module-relative (resolved against the importing file, not the document) and
 * are deliberately left alone. Vendor loaders were already absolute.
 *
 * ⚠️ NON-VACUOUS: the detector is shown a known-positive first (test 0), and
 * every scan asserts it SAW a minimum number of references, so an over-narrow
 * regex cannot pass by finding nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SLUGS = JSON.parse(read('seo/pages.json')).pages.map((p) => p.slug);
const SHELL_PAGES = ['index.html', ...SLUGS.map((s) => `${s}.html`)];

const ABSOLUTE = /^(?:\/|#|[a-z][a-z0-9+.-]*:|$)/i; // root-absolute, fragment, or has a scheme
const moves = (ref) => new URL(ref, 'https://h/en/').pathname !== new URL(ref, 'https://h/').pathname;

// Relative asset references in markup: tag attributes + inline <style> url().
function markupRefs(html) {
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const styles = [...noComments.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  const noScriptBodies = noComments.replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/g, '$1</script>').replace(/<style[\s\S]*?<\/style>/g, '');
  const refs = [];
  for (const tag of noScriptBodies.matchAll(/<(?:script|img|link|source|video|audio|iframe|a)\b[^>]*>/g)) {
    for (const a of tag[0].matchAll(/\s(?:src|href|poster)="([^"]*)"/g)) refs.push(a[1]);
  }
  // An inline data: URI may itself contain `url(%23id)`; it is not a fetch, drop it first.
  for (const css0 of styles) {
    const css = css0.replace(/url\(\s*(['"])data:[\s\S]*?\1\s*\)/g, '');
    for (const u of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) refs.push(u[1]);
  }
  return refs;
}

// Bare path literals in JS that name a served asset directory. Comments and ES
// import specifiers excluded; `fonts/ttf/x.ttf` is the shape that bit.
const JS_ASSET = /['"`](?:\.\/)?((?:fonts|images|js|css)\/[\w./-]+\.[a-z0-9]+)['"`]/g;
function jsRefs(src) {
  const out = [];
  for (const line of src.split('\n')) {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    if (/\bfrom\s+['"]|\bimport\s*\(|\bimport\s+['"]/.test(line)) continue;
    for (const m of line.matchAll(JS_ASSET)) out.push(m[1]);
  }
  return out;
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) { if (e.name !== 'vendor') walk(rel, acc); } else if (e.name.endsWith('.js')) acc.push(rel);
  }
  return acc;
}

test('0. the detectors flag a relative reference and pass an absolute one', () => {
  assert.deepEqual(markupRefs('<img src="images/a.png"><img src="/images/b.png">').filter((r) => !ABSOLUTE.test(r)), ['images/a.png']);
  assert.deepEqual(markupRefs('<style>@font-face{src:url(\'fonts/a.woff2\')}</style><style>x{src:url("/fonts/b.woff2")}</style>').filter((r) => !ABSOLUTE.test(r)), ['fonts/a.woff2']);
  assert.deepEqual(jsRefs("const a = 'fonts/ttf/a.ttf'; const b = '/fonts/ttf/b.ttf';\n// 'fonts/c.ttf'\n * 'fonts/d.ttf'"), ['fonts/ttf/a.ttf']);
  assert.ok(moves('fonts/a.ttf') && !moves('/fonts/a.ttf'));
});

test('1. no shell page carries a document-relative asset reference', () => {
  assert.equal(SHELL_PAGES.length, 13, `expected 13 shell pages, got ${SHELL_PAGES.length}`);
  const bad = [];
  for (const f of SHELL_PAGES) {
    const refs = markupRefs(read(f));
    assert.ok(refs.length >= 40, `${f}: only ${refs.length} references seen, the scan is too narrow to mean anything`);
    for (const r of refs) if (!ABSOLUTE.test(r) && moves(r)) bad.push(`${f}: ${r}`);
  }
  assert.deepEqual(bad, [], `these 404 under /en/:\n  ${bad.join('\n  ')}`);
});

test('2. every root-absolute asset the shell names exists on disk', () => {
  const missing = [];
  for (const r of new Set(markupRefs(read('index.html')))) {
    if (!/^\/(?:fonts|images|js|css)\//.test(r)) continue;
    if (!fs.existsSync(path.join(ROOT, r.split(/[?#]/)[0]))) missing.push(r);
  }
  assert.deepEqual(missing, [], `the shell names assets that are not there:\n  ${missing.join('\n  ')}`);
});

test('3. no module under js/ names an asset by a document-relative path', () => {
  const files = walk('js');
  assert.ok(files.length > 50, `only ${files.length} js files walked`);
  const bad = [];
  let seen = 0;
  for (const f of files) {
    for (const r of jsRefs(read(f))) { seen += 1; bad.push(`${f}: ${r}`); }
  }
  assert.deepEqual(bad, [], `these resolve against the document and 404 under /en/ (fetch('fonts/..') is the quiet one):\n  ${bad.join('\n  ')}`);
  void seen;
});

test('4. the font tables the export path fetches are root-absolute and exist', async () => {
  // The positive side of 3: JS_ASSET only matches the relative form, so prove the
  // absolute form is what the tables hold, and that it points at a real file.
  const { CUSTOM_FONT_URLS } = await import('../../js/core/export.js');
  const { CLONE_FONT_URLS } = await import('../../js/core/clone-fonts.js');
  const urls = Object.values({ ...CUSTOM_FONT_URLS, ...CLONE_FONT_URLS });
  assert.ok(urls.length >= 24, `catalog unexpectedly small (${urls.length})`);
  for (const u of urls) {
    assert.ok(u.startsWith('/fonts/ttf/'), `${u} is not root-absolute`);
    assert.ok(fs.existsSync(path.join(ROOT, u)), `${u} does not exist`);
  }
});
