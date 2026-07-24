/*
 * PDFLokal — lib/i18n.js  (the translation layer PDFLokal never had)
 * ============================================================================
 * SINGLE SOURCE OF TRUTH for looking up user-facing copy by key + locale.
 *
 * WHY this exists (and why it's separate from intent-copy.js):
 *   intent-copy.js re-words the editor by the user's JOB (gabung/split/…) — it is
 *   explicitly "not a translation layer". THIS is the translation layer: the same
 *   sentence, in the reader's language. The two compose — an intent override still
 *   goes through t() once other locales exist.
 *
 * DESIGN — deliberately tiny, no framework, no build step, no async at call time:
 *   - Dictionaries are plain ES modules (js/locales/<locale>.js), imported like any
 *     other module. `id` is imported statically here because it is BOTH the app's
 *     source language AND the guaranteed fallback — it must always be present.
 *   - t(key, params) is SYNCHRONOUS. It reads the active locale, falls back to `id`,
 *     falls back to the key itself (a visible, greppable miss — never a blank UI).
 *   - This module SELF-BOOTSTRAPS on import (resolveLocale + setLocale). That is on
 *     purpose: callers just `import { t }` and it works, with ZERO edits to the app
 *     boot path (js/v2/app.js). Adding a second locale later is additive.
 *
 * SLOTS, NOT SUBSTRINGS: sentences that vary mid-string (the "hapemu"/"komputermu"
 *   device word, "N halaman") pass their variable parts as {slots}. Never splice a
 *   translated substring into a template — word order differs by language.
 *
 * HEADLESS-SAFE: every DOM/URL/storage read is guarded so this imports cleanly
 *   under `node --test` (see tests/core/i18n.test.mjs).
 */
import idMessages from '../locales/id.js';

// The app's source language — also the universal fallback. Anything missing in
// another locale resolves here before it resolves to the raw key.
export const DEFAULT_LOCALE = 'id';

// Locale registry. Each entry: { label (endonym, for a future switcher), dir }.
// Adding a locale = register its metadata here + registerMessages() its dict.
export const LOCALES = {
  id: { label: 'Bahasa Indonesia', dir: 'ltr' },
};

// locale -> messages object. Seeded with `id`; other locales register into this.
const MESSAGES = { id: idMessages };

let activeLocale = DEFAULT_LOCALE;
const listeners = new Set();

// WHY register at runtime: a locale switcher (or a per-page <script>) can pull in
// js/locales/en.js and light it up without this file importing every language.
export function registerMessages(locale, dict) {
  MESSAGES[locale] = dict;
}

export function getLocale() { return activeLocale; }

export function setLocale(locale) {
  if (!MESSAGES[locale]) return false; // unknown/unloaded locale — stay put, keep falling back
  if (locale === activeLocale) return true;
  activeLocale = locale;
  listeners.forEach((fn) => { try { fn(locale); } catch { /* a bad listener must not break i18n */ } });
  return true;
}

// For a future language switcher: re-render hooks. No-op cost until someone subscribes.
export function onLocaleChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// Detection order (first match wins), all guarded for headless: ?lang= → /<locale>/
// path prefix → saved preference → <html lang> → DEFAULT. Only locales we actually
// have messages for are eligible, so an unknown value quietly yields the default.
export function resolveLocale() {
  const available = Object.keys(MESSAGES);
  try {
    const url = new URL(globalThis.location.href);
    const q = url.searchParams.get('lang');
    if (q && available.includes(q)) return q;
    const seg = url.pathname.split('/')[1];
    if (seg && available.includes(seg)) return seg;
  } catch { /* no location (headless) */ }
  try {
    const saved = globalThis.localStorage.getItem('pdflokal-locale');
    if (saved && available.includes(saved)) return saved;
  } catch { /* no/blocked storage */ }
  try {
    const htmlLang = globalThis.document.documentElement.getAttribute('lang');
    if (htmlLang && available.includes(htmlLang)) return htmlLang;
  } catch { /* no document (headless) */ }
  return DEFAULT_LOCALE;
}

// Walk a dotted key ('install.cardSub') through a nested dict. Returns undefined
// (not a throw) on any miss so t() can fall back cleanly.
function lookup(dict, key) {
  if (!dict) return undefined;
  return key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), dict);
}

// {slot} substitution. A missing param leaves the token visible on purpose — a
// silent '' would hide the bug; '{screen}' in the UI shouts it.
function interpolate(str, params) {
  if (!params) return str;
  return str.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

// Pluralization via the platform's CLDR data. Dict values may be a plural object
// keyed by category ({ one, other, ... }); we pick by params.count. Indonesian has
// only 'other', but English/Arabic/… need this the moment they're added.
function plural(value, params) {
  const count = params && params.count;
  if (typeof count !== 'number') return value.other ?? value.one ?? '';
  let cat = 'other';
  try { cat = new Intl.PluralRules(activeLocale).select(count); } catch { /* fall through to other */ }
  return value[cat] ?? value.other ?? value.one ?? '';
}

/*
 * t(key, params) — the one function callers use.
 *   - string  → interpolated string
 *   - array   → array with each element interpolated (e.g. install step lists)
 *   - plural object ({ one, other }) → selected form, then interpolated
 *   - miss    → the key itself (visible + greppable), never blank
 */
export function t(key, params) {
  let value = lookup(MESSAGES[activeLocale], key);
  if (value === undefined && activeLocale !== DEFAULT_LOCALE) value = lookup(MESSAGES[DEFAULT_LOCALE], key);
  if (value === undefined) return key;

  if (Array.isArray(value)) return value.map((s) => interpolate(String(s), params));
  if (value && typeof value === 'object') return interpolate(plural(value, params), params);
  return interpolate(String(value), params);
}

// ---- locale-aware number formatting -------------------------------------------
// WHY here and not in each caller: the decimal separator is a locale fact (id uses
// "0,5 MB", en uses "0.5 MB"). fmtMB() in download-sheet.js was hardcoding ','.

export function decimalSeparator(locale = activeLocale) {
  try { return (1.1).toLocaleString(locale).replace(/[0-9\s]/g, '') || '.'; } catch { return '.'; }
}

// Fixed-digit decimal in the active locale's separator. formatDecimal(0.5, 1) ->
// "0,5" (id) / "0.5" (en). Keeps download-sheet's fmtMB byte-identical for `id`.
export function formatDecimal(n, digits, locale = activeLocale) {
  return n.toFixed(digits).replace('.', decimalSeparator(locale));
}

// Self-bootstrap: pick the locale now so the first t() call is already correct.
setLocale(resolveLocale());
