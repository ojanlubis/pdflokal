/*
 * The translation layer's contract, headless (node --test).
 *
 * What each test exists to catch, so none of them can pass by looking at nothing:
 *   - parity:     a key added to one locale and not the other
 *   - call sites: a t('key') in the code that no dictionary defines (the quiet
 *                 failure: the UI would show the raw key), and a dictionary key
 *                 nothing reads
 *   - baseline:   an Indonesian string that drifted from the literal that was in
 *                 the code before it moved into id.js (byte-identical is the promise)
 *   - locale:     the page language is <html lang> and nothing else
 * Each scan asserts it SAW a minimum number of things, and the detectors are
 * shown a known-positive first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { t, tFor, getLocale, formatDecimal, numberLocale, DEFAULT_LOCALE } from '../../js/lib/i18n.js';
import id from '../../js/locales/id.js';
import en from '../../js/locales/en.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Run fn with the page language set, as the browser would have it.
function withLang(lang, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = { documentElement: { lang } };
  try { return fn(); } finally {
    if (had) Object.defineProperty(globalThis, 'document', had); else delete globalThis.document;
  }
}

const PLURAL_CATS = new Set(['zero', 'one', 'two', 'few', 'many', 'other']);
const isPlural = (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => PLURAL_CATS.has(k));

// Dotted key -> leaf (string | array | plural object).
function flatten(obj, prefix = '') {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string' || Array.isArray(v) || isPlural(v)) out[key] = v;
    else if (v && typeof v === 'object') Object.assign(out, flatten(v, key));
    else assert.fail(`${key}: unsupported value ${typeof v}`);
  }
  return out;
}
const strings = (leaf) => (Array.isArray(leaf) ? leaf : isPlural(leaf) ? Object.values(leaf) : [leaf]);
const slotsOf = (leaf) => new Set(strings(leaf).flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1])));

const ID = flatten(id);
const EN = flatten(en);

// ---- locale: <html lang> only ----------------------------------------------

test('headless (no document) is Indonesian', () => {
  assert.equal(DEFAULT_LOCALE, 'id');
  assert.equal(getLocale(), 'id');
  assert.equal(t('landing.hideTools'), 'Sembunyikan');
});

test('the locale is the primary subtag of <html lang>; anything unknown is id', () => {
  assert.equal(withLang('en', getLocale), 'en');
  assert.equal(withLang('en-US', getLocale), 'en');
  assert.equal(withLang('EN', getLocale), 'en');
  assert.equal(withLang('id', getLocale), 'id');
  assert.equal(withLang('fr', getLocale), 'id');
  assert.equal(withLang('', getLocale), 'id');
  assert.equal(withLang(undefined, getLocale), 'id');
  assert.equal(withLang('en', () => t('landing.hideTools')), 'Hide');
  assert.equal(withLang('id', () => t('landing.hideTools')), 'Sembunyikan');
});

test('?lang=, a /en/ path and localStorage do NOT change the locale', () => {
  const saved = { location: globalThis.location, localStorage: globalThis.localStorage };
  globalThis.location = { href: 'https://www.pdflokal.id/en/?lang=en', pathname: '/en/', search: '?lang=en' };
  globalThis.localStorage = { getItem: () => 'en' };
  try {
    assert.equal(withLang('id', getLocale), 'id');
    assert.equal(withLang('id', () => t('landing.hideTools')), 'Sembunyikan');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
  }
});

// ---- the dictionaries ------------------------------------------------------

test('known-positive: the flattener sees leaves, arrays and plural objects', () => {
  const f = flatten({ a: { b: 'x', c: ['y', 'z'], d: { one: '1', other: '2' } } });
  assert.deepEqual(Object.keys(f), ['a.b', 'a.c', 'a.d']);
  assert.equal(isPlural(f['a.d']), true);
  assert.equal(isPlural(f['a.b']), false);
});

test('both locales have enough keys that "same keys" means something', () => {
  assert.ok(Object.keys(ID).length >= 30, `id has ${Object.keys(ID).length} keys`);
});

test('every key exists in both locales, and nothing extra in either', () => {
  const idKeys = Object.keys(ID).sort();
  const enKeys = Object.keys(EN).sort();
  assert.deepEqual(idKeys.filter((k) => !(k in EN)), [], 'in id.js but missing from en.js');
  assert.deepEqual(enKeys.filter((k) => !(k in ID)), [], 'in en.js but not in id.js');
});

test('each key has the same shape and the same {slots} in both locales', () => {
  for (const k of Object.keys(ID)) {
    const a = ID[k]; const b = EN[k];
    assert.equal(Array.isArray(a), Array.isArray(b), `${k}: array vs not`);
    if (Array.isArray(a)) assert.equal(a.length, b.length, `${k}: step count differs`);
    assert.deepEqual([...slotsOf(a)].sort(), [...slotsOf(b)].sort(), `${k}: {slots} differ`);
    if (isPlural(b)) assert.ok('other' in b, `${k}: en plural needs an "other" form`);
    assert.ok(!isPlural(a) || 'other' in a, `${k}: id plural needs "other"`);
    if (isPlural(b) || isPlural(a)) assert.ok(slotsOf(b).has('count'), `${k}: a plural needs {count}`);
  }
});

test('no empty strings, no em-dashes, in either locale', () => {
  for (const [name, flat] of [['id', ID], ['en', EN]]) {
    for (const [k, leaf] of Object.entries(flat)) {
      for (const s of strings(leaf)) {
        assert.ok(typeof s === 'string' && s.trim() !== '', `${name} ${k}: empty`);
        assert.ok(!/—/.test(s), `${name} ${k}: em-dash`);
      }
    }
  }
});

// ---- t() behaviour ---------------------------------------------------------

test('slots interpolate; a missing slot stays visible', () => {
  assert.equal(tFor('id', 'toast.tooBig', { name: 'a.pdf' }), '"a.pdf" terlalu besar (maks 100MB)');
  assert.equal(tFor('id', 'toast.tooBig'), '"{name}" terlalu besar (maks 100MB)');
});

test('English plurals pick by count; Indonesian has one form', () => {
  assert.equal(tFor('en', 'toast.skipped', { count: 1 }), "1 file skipped, it's empty or damaged");
  assert.equal(tFor('en', 'toast.skipped', { count: 3 }), "3 files skipped, they're empty or damaged");
  assert.equal(tFor('id', 'toast.skipped', { count: 1 }), '1 file dilewati, kosong atau rusak');
  assert.equal(tFor('id', 'toast.skipped', { count: 3 }), '3 file dilewati, kosong atau rusak');
});

test('a key missing from en falls back to id; missing everywhere returns the key', () => {
  const saved = en.landing.hideTools;
  delete en.landing.hideTools;
  try {
    assert.equal(tFor('en', 'landing.hideTools'), 'Sembunyikan');
    assert.equal(withLang('en', () => t('landing.hideTools')), 'Sembunyikan');
  } finally { en.landing.hideTools = saved; }
  assert.equal(tFor('en', 'no.such.key'), 'no.such.key');
  assert.equal(tFor('id', 'no.such.key'), 'no.such.key');
});

test('decimal separator and number locale follow the page language', () => {
  assert.equal(formatDecimal(0.5, 1), '0,5');
  assert.equal(withLang('en', () => formatDecimal(0.5, 1)), '0.5');
  assert.equal(numberLocale(), 'id-ID');
  assert.equal(withLang('en', numberLocale), 'en-US');
});

// ---- call sites: every t('key') resolves, every key is read ----------------

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'vendor' && e.name !== 'locales') walk(p, out); } else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// -> { keys: [...literal keys], nonLiteral: [...] } for one source file.
function scanCallSites(src, file) {
  const code = stripComments(src);
  const imp = code.match(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*lib\/i18n\.js['"]/);
  let ident = null;
  if (imp) {
    for (const spec of imp[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      const m = spec.match(/^t(?:\s+as\s+(\w+))?$/);
      if (m) ident = m[1] || 't';
    }
  } else if (file.endsWith(path.join('lib', 'i18n.js'))) ident = 't';
  if (!ident) return { ident, keys: [], nonLiteral: [] };
  const body = code.replace(/export function t\(/g, 'export function __def(');
  const call = new RegExp(`(?<![\\w.$])${ident}\\(\\s*(\\S)`, 'g');
  const keys = []; const nonLiteral = [];
  for (const m of body.matchAll(call)) {
    if (m[1] === "'" || m[1] === '"') {
      const lit = body.slice(m.index).match(new RegExp(`^${ident}\\(\\s*(['"])([^'"]+)\\1`));
      if (lit) keys.push(lit[2]); else nonLiteral.push(body.slice(m.index, m.index + 40));
    } else nonLiteral.push(body.slice(m.index, m.index + 40));
  }
  return { ident, keys, nonLiteral };
}

test('known-positive: the call-site scanner reads an aliased import and flags a template key', () => {
  const src = "import { t as tr } from '../lib/i18n.js';\nconst a = tr('x.y');\nconst b = tr(`x.${k}`);\nfoo.tr('no');";
  const r = scanCallSites(src, 'js/v2/x.js');
  assert.equal(r.ident, 'tr');
  assert.deepEqual(r.keys, ['x.y']);
  assert.equal(r.nonLiteral.length, 1);
});

const SCAN = walk(path.join(ROOT, 'js')).map((f) => ({ f: path.relative(ROOT, f), ...scanCallSites(fs.readFileSync(f, 'utf8'), f) }));
const USED = new Set(SCAN.flatMap((s) => s.keys));

test('every t() call passes a string literal key (so this test can see it)', () => {
  const bad = SCAN.flatMap((s) => s.nonLiteral.map((n) => `${s.f}: ${n}`));
  assert.deepEqual(bad, []);
});

test('every key a t() call reads exists in id.js and en.js', () => {
  assert.ok(USED.size >= 30, `scanner saw only ${USED.size} distinct keys`);
  assert.deepEqual([...USED].filter((k) => !(k in ID)), [], 'read by code, missing from id.js');
  assert.deepEqual([...USED].filter((k) => !(k in EN)), [], 'read by code, missing from en.js');
});

test('every key in id.js is read by some t() call', () => {
  assert.deepEqual(Object.keys(ID).filter((k) => !USED.has(k)), []);
});

// ---- baseline: id values are the strings that were in the code ------------

const BASELINE = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/core/fixtures/i18n-id-baseline.json'), 'utf8'));

test('id.js equals the pre-migration strings, key for key', () => {
  assert.ok(Object.keys(BASELINE).length >= 30, 'baseline is suspiciously small');
  assert.deepEqual(Object.keys(ID).filter((k) => !(k in BASELINE)), [], 'id key with no baseline entry');
  assert.deepEqual(Object.keys(BASELINE).filter((k) => !(k in ID)), [], 'baseline key missing from id.js');
  for (const [k, entry] of Object.entries(BASELINE)) {
    if (entry.text === null) continue;
    assert.deepEqual(ID[k], entry.text, `${k} differs from the string that was in ${entry.src.join(', ')} before it moved to id.js. Changing shipped Indonesian copy is a copy decision: update the baseline entry on purpose, not to make this pass.`);
  }
});
