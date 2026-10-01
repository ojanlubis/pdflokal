/*
 * EVERY KEY PDFLOKAL WRITES TO THE BROWSER IS IN /privasi's TABLE, AND NO ROW
 * THERE NAMES A KEY NOTHING WRITES ANY MORE.
 * ============================================================================
 * tests/privasi-storage-table.spec.js pins his ratified wording row by row, but
 * it can only check rows somebody remembered to add. The table was 2 keys short
 * of the code in August and 5 short again by 2026-10-01 (pdflokal_maker_seen,
 * pdflokal_bugreport_last, pdflokal-support-last, pdflokal-support-optout,
 * pdflokal_boot_healed), each one a feature that shipped and a privacy page
 * that did not move. This file reads the CODE instead: it finds every
 * localStorage/sessionStorage.setItem, and every call to a wrapper whose body
 * does one, resolves the key (a literal, or a `const|var|let NAME = '...'` in
 * the same file), and requires each in privasi.html's #storage-ours table.
 *
 * An identifier it cannot resolve FAILS the test rather than being skipped:
 * a key the scanner cannot see is exactly the key that would go missing.
 * The only exemption is a wrapper's own parameter inside its own body.
 *
 * Third-party keys (Google's cookies, Sentry's sentryReplaySession) are NOT
 * scanned: they are written by vendor code, so they were measured on the live
 * site instead and sit in the second table (#storage-pihak-ketiga).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor') walk(p, out); } else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

export function realSources() {
  const files = [
    ...walk(path.join(ROOT, 'js')),
    ...fs.readdirSync(ROOT).filter((f) => f.endsWith('.html')).map((f) => path.join(ROOT, f)),
  ];
  return files.map((f) => ({ file: path.relative(ROOT, f), text: fs.readFileSync(f, 'utf8') }));
}

// Comments out, so prose that says "localStorage.setItem('x')" is not a write.
// Line comments only when the line STARTS with one: a URL inside a string
// ('https://…') must survive.
function code(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
}

const STORE_SET = /\b(?:localStorage|sessionStorage)\.setItem\(\s*([^,)]+)/g;
const LITERAL = /^(['"])([^'"]+)\1$/;

export function writtenKeys(sources) {
  const cleaned = sources.map((s) => ({ ...s, code: code(s.text) }));
  // Wrappers anywhere in the tree: a named function whose body (first ~160
  // chars) calls setItem with its own first parameter.
  const wrappers = new Map();
  const wrapperParams = new Set();
  for (const s of cleaned) {
    for (const m of s.code.matchAll(/function\s+(\w+)\s*\(\s*(\w+)[^)]*\)\s*\{([\s\S]{0,160}?)\}/g)) {
      if (new RegExp(`(?:localStorage|sessionStorage)\\.setItem\\(\\s*${m[2]}\\b`).test(m[3])) {
        wrappers.set(m[1], m[2]);
        wrapperParams.add(m[2]);
      }
    }
  }
  const keys = new Set();
  const unresolved = [];
  for (const s of cleaned) {
    const consts = new Map();
    for (const m of s.code.matchAll(/\b(?:const|var|let)\s+(\w+)\s*=\s*(['"])([^'"]+)\2/g)) consts.set(m[1], m[3]);
    const args = [...s.code.matchAll(STORE_SET)].map((m) => m[1].trim());
    for (const [name] of wrappers) {
      for (const m of s.code.matchAll(new RegExp(`(?<![\\w.])${name}\\(\\s*([^,)]+)`, 'g'))) args.push(m[1].trim());
    }
    for (const a of args) {
      const lit = a.match(LITERAL);
      if (lit) keys.add(lit[2]);
      else if (consts.has(a)) keys.add(consts.get(a));
      else if (!wrapperParams.has(a)) unresolved.push(`${s.file}: ${a}`);
    }
  }
  return { keys, unresolved, wrappers };
}

export function tableKeys(privasiHtml) {
  const m = privasiHtml.match(/<table[^>]*id="storage-ours"[^>]*>([\s\S]*?)<\/table>/);
  if (!m) return null;
  return new Set([...m[1].matchAll(/<code>([^<]+)<\/code>/g)].map((c) => c[1].trim()));
}

export function storageProblems(sources, privasiHtml) {
  const { keys, unresolved } = writtenKeys(sources);
  const table = tableKeys(privasiHtml);
  if (!table) return ['privasi.html has no #storage-ours table'];
  const problems = unresolved.map((u) => `cannot resolve the storage key passed in ${u}`);
  for (const k of keys) if (!table.has(k)) problems.push(`code writes "${k}" but privasi.html's table does not list it`);
  for (const k of table) {
    if (/^pdflokal/.test(k) && !keys.has(k)) problems.push(`privasi.html lists "${k}" but no code writes it any more`);
  }
  return problems;
}

const privasi = () => fs.readFileSync(path.join(ROOT, 'privasi.html'), 'utf8');

test('the scanner finds the keys it must (known positive)', () => {
  const { keys, wrappers } = writtenKeys(realSources());
  for (const k of ['pdflokal_theme', 'pdflokal_visitor_id', 'pdflokal_boot_healed', 'pdflokal_maker_seen',
    'pdflokal-install-dismissed', 'pdflokal_signature_hint_shown']) {
    assert.ok(keys.has(k), `scanner did not find ${k}: the instrument is blind`);
  }
  assert.ok(keys.size >= 12, `only ${keys.size} keys found`);
  assert.ok(wrappers.has('safeSet') && wrappers.has('lset') && wrappers.has('safeLocalSet'), 'wrapper detection broke');
});

test('privasi.html lists every key the code writes, and nothing it no longer writes', () => {
  assert.deepEqual(storageProblems(realSources(), privasi()), []);
});

test('red on revert: a row drops out of the table', () => {
  const html = privasi().replace(/<tr>\s*<td><code>pdflokal_maker_seen<\/code><\/td>[\s\S]*?<\/tr>/, '');
  assert.notEqual(html, privasi(), 'mutation did not apply');
  assert.match(storageProblems(realSources(), html).join('\n'), /writes "pdflokal_maker_seen"/);
});

test('red on revert: new code writes a key the table never heard of', () => {
  const sources = [...realSources(), {
    file: 'js/v2/new-feature.js',
    text: "const NEW_KEY = 'pdflokal_new_thing';\nfunction go() { safeSet(NEW_KEY, '1'); localStorage.setItem('pdflokal_raw', 'x'); }",
  }];
  const out = storageProblems(sources, privasi()).join('\n');
  assert.match(out, /writes "pdflokal_new_thing"/);
  assert.match(out, /writes "pdflokal_raw"/);
});

test('red on revert: a key the scanner cannot resolve fails instead of passing', () => {
  const sources = [...realSources(), { file: 'js/v2/x.js', text: 'localStorage.setItem(makeKey(), 1);' }];
  assert.match(storageProblems(sources, privasi()).join('\n'), /cannot resolve/);
});

test('red on revert: a row outlives the code that wrote it', () => {
  const html = privasi().replace('</tbody>', '<tr><td><code>pdflokal_gone</code></td><td>x</td></tr></tbody>');
  assert.match(storageProblems(realSources(), html).join('\n'), /lists "pdflokal_gone" but no code writes it/);
});

test('comments are not writes', () => {
  const { keys } = writtenKeys([{ file: 'a.js', text: "// localStorage.setItem('pdflokal_prose', 1)\n/* sessionStorage.setItem('pdflokal_block', 1) */" }]);
  assert.equal(keys.size, 0);
});
