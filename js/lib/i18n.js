/*
 * PDFLokal — lib/i18n.js  (the translation layer)
 * ============================================================================
 * Looks up user-facing JS copy by key. Lifted from tag archive/i18n-groundwork
 * (js/lib/i18n.js) with its detection order REMOVED, on purpose.
 *
 * THE LOCALE IS `document.documentElement.lang`, AND NOTHING ELSE. The page's
 * language is set statically by whoever served the page (`/` is lang="id",
 * `/en/` is lang="en"). One URL, one language, always. The archive version also
 * read `?lang=`, a path prefix and localStorage; those would let one URL show
 * two languages, which breaks the canonical tag and makes the URL lie
 * (docs: reference/seo-i18n-plan-2026-10-01.md §4). Do not add them back.
 *
 * - t(key, vars) is SYNCHRONOUS and reads the locale on every call (no state).
 * - `id` is the source language and the fallback for a missing key in any other
 *   locale. A key missing in `id` too returns the key itself (visible, never
 *   blank). tests/core/i18n.test.mjs fails the build on either kind of miss.
 * - Every t() call must pass a STRING LITERAL key, so the call-site test can
 *   see it. Never build a key from a template.
 * - SLOTS, NOT SUBSTRINGS: variable parts are {slots}; never splice a
 *   translated fragment into a sentence (word order differs by language).
 * - Headless-safe: no `document` (node --test) means `id`.
 */
import idMessages from '../locales/id.js';
import enMessages from '../locales/en.js';

export const DEFAULT_LOCALE = 'id';

const MESSAGES = { id: idMessages, en: enMessages };

// The active locale: the primary subtag of <html lang>, if we have a dictionary
// for it, else Indonesian. 'en-US' -> 'en'.
export function getLocale() {
  const raw = globalThis.document?.documentElement?.lang;
  const primary = typeof raw === 'string' ? raw.trim().toLowerCase().split('-')[0] : '';
  return Object.hasOwn(MESSAGES, primary) ? primary : DEFAULT_LOCALE;
}

// Walk a dotted key ('toast.armText') through a nested dict. undefined on any
// miss, so the caller can fall back cleanly.
function lookup(dict, key) {
  return key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), dict);
}

// {slot} substitution. A missing param leaves the token visible on purpose: a
// silent '' would hide the bug, '{n}' in the UI shouts it.
function interpolate(str, vars) {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

// Dict values may be a plural object keyed by CLDR category ({ one, other }),
// picked by vars.count. Indonesian has only 'other'; English needs one/other.
function plural(value, vars, locale) {
  const count = vars && vars.count;
  if (typeof count !== 'number') return value.other ?? value.one ?? '';
  let cat = 'other';
  try { cat = new Intl.PluralRules(locale).select(count); } catch { /* fall through to other */ }
  return value[cat] ?? value.other ?? value.one ?? '';
}

// The same lookup for an explicit locale. `t` is this with the page's locale;
// tests use it to render `en` without a DOM.
export function tFor(locale, key, vars) {
  let value = lookup(MESSAGES[locale], key);
  if (value === undefined && locale !== DEFAULT_LOCALE) value = lookup(MESSAGES[DEFAULT_LOCALE], key);
  if (value === undefined) return key;

  if (Array.isArray(value)) return value.map((s) => interpolate(String(s), vars));
  if (value && typeof value === 'object') return interpolate(plural(value, vars, locale), vars);
  return interpolate(String(value), vars);
}

/*
 * t(key, vars): the one function callers use.
 *   string -> interpolated string
 *   array  -> array, each element interpolated (step lists)
 *   plural object ({ one, other }) -> the form for vars.count, interpolated
 *   miss   -> the key itself
 */
export function t(key, vars) {
  return tFor(getLocale(), key, vars);
}

// The BCP-47 tag for Intl number formatting. Indonesian pages keep 'id-ID'.
export function numberLocale() {
  return getLocale() === 'en' ? 'en-US' : 'id-ID';
}

// Fixed-digit decimal with the locale's separator ("0,5" id, "0.5" en). The
// separator lives in the dictionary (number.decimal), not in Intl, so the
// Indonesian output is byte-identical by construction.
export function formatDecimal(n, digits) {
  return n.toFixed(digits).replace('.', t('number.decimal'));
}
