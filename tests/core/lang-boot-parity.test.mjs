/*
 * THE LANGUAGE SCRIPT IS ONE SCRIPT, IN THREE HEADS, AND IT DECIDES CORRECTLY.
 * ============================================================================
 * The inline script first in <head> sends an English browser on `/` to /en, and
 * remembers a language picked in the menu (pdflokal_lang). It is byte-copied
 * into index.html, dukung.html and privasi.html (the generators copy
 * index.html's head into /en and the 12 tool pages). Properties:
 *
 *   1. ONE COPY EACH, BYTE-IDENTICAL (same shape as theme-boot-parity): a
 *      drifted copy is a menu that forgets its choice on one page.
 *   2. FIRST, BEFORE ANALYTICS: in index.html it precedes gtag and the Mixpanel
 *      recorder, and both honour window.__pdlLeaving, or `/` would log a
 *      pageview it then leaves.
 *   3. THE DECISION TABLE, run headless in a vm (the Playwright spec proves the
 *      same in a browser): redirects only on the exact path `/`, only for an
 *      English FIRST language or a stored 'en', never for a stored 'id', never
 *      for a crawler UA (webdriver is deliberately not read), query and hash
 *      kept, every storage access survives a throwing localStorage.
 *   4. THE CLICK WRITES THE CHOICE: a language link writes its hreflang, anything
 *      else (or a bad value) writes nothing.
 *
 * ⚠️ NON-VACUOUS: the extractor is shown the script on each page, and every
 * "stays" case is paired with a "goes" case under the same harness.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PAGES = ['index.html', 'privasi.html', 'dukung.html'];
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SNIPPET = /<script>\s*\(function \(\) \{\s*var KEY = 'pdflokal_lang';[\s\S]*?<\/script>/g;

const found = PAGES.map((file) => ({ file, hits: read(file).match(SNIPPET) || [] }));

test('1. each page carries exactly one language script, byte-identical', () => {
  for (const { file, hits } of found) assert.equal(hits.length, 1, `${file} has ${hits.length} language scripts, expected exactly 1`);
  const [first, ...rest] = found.map((f) => f.hits[0]);
  assert.ok(first.length > 600, `the matched script is only ${first.length} chars: the regex is matching the wrong thing`);
  rest.forEach((r, i) => assert.equal(r, first, `${PAGES[i + 1]}'s language script drifted from index.html's`));
});

test('2. it is the first script in index.html\'s head, ahead of gtag and the Mixpanel recorder, which both honour it', () => {
  const html = read('index.html');
  const head = html.slice(0, html.indexOf('</head>'));
  const at = head.search(/<script>\s*\(function \(\) \{\s*var KEY = 'pdflokal_lang'/);
  assert.ok(at > 0, 'the language script is not in the head');
  assert.equal(head.slice(0, at).includes('<script'), false, 'a script runs before the language script');
  assert.ok(head.indexOf('googletagmanager.com/gtag/js') > at, 'gtag loads before the language script');
  assert.ok(head.indexOf('mixpanel.init') > at, 'the recorder starts before the language script');
  assert.match(head, /if \(!window\.__pdlLeaving && \(location\.hostname === 'pdflokal\.id'/, 'gtag config no longer honours __pdlLeaving');
  assert.match(head, /if \(window\.__pdlLeaving\) return;/, 'the Mixpanel recorder no longer honours __pdlLeaving');
  // The same head is copied into /en and the tool pages: still exactly one script, still first.
  for (const f of ['en/index.html', 'kompres-pdf.html', 'gabung-pdf.html']) {
    const h = read(f);
    assert.equal((h.match(SNIPPET) || []).length, 1, `${f} lost or duplicated the language script`);
  }
});

// ---- 3 & 4. the decision table, headless ----------------------------------------

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// Run the script as the browser would. Returns { went, store, click(link), leaving }.
function run({ path: p = '/', search = '', hash = '', ua = CHROME, languages, language, stored, storageThrows = false, webdriver = true, timeZone, intlThrows = false } = {}) {
  const store = new Map(stored ? [['pdflokal_lang', stored]] : []);
  const went = [];
  const listeners = {};
  const localStorage = {
    getItem: (k) => { if (storageThrows) throw new Error('denied'); return store.has(k) ? store.get(k) : null; },
    setItem: (k, v) => { if (storageThrows) throw new Error('denied'); store.set(k, String(v)); },
  };
  const style = {};
  const ctx = {
    location: { pathname: p, search, hash, replace: (u) => went.push(u) },
    navigator: { userAgent: ua, languages, language, webdriver },
    document: { addEventListener: (t, fn) => { listeners[t] = fn; }, documentElement: { style } },
    setTimeout: () => 0,
    // The device's time zone as Intl reports it. `undefined` leaves the real Intl absent here,
    // so the script must cope with a bare context (the vm has no Intl of its own).
    Intl: intlThrows ? { DateTimeFormat: () => { throw new TypeError('no Intl'); } }
      : { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone }) }) },
  };
  ctx.window = ctx;
  Object.defineProperty(ctx, 'localStorage', { get: () => localStorage });
  vm.runInNewContext(found[0].hits[0].replace(/^<script>/, '').replace(/<\/script>$/, ''), ctx);
  const click = (hreflang, { isLink = true } = {}) => listeners.click({
    target: { closest: (sel) => (isLink && /ld-lang-opt/.test(sel) ? { getAttribute: (n) => (n === 'hreflang' ? hreflang : null) } : null) },
  });
  return { went, store, click, leaving: ctx.__pdlLeaving === true, hidden: style.visibility === 'hidden', listeners };
}

test('3a. an English first language on `/` goes to /en, query and hash kept; the rest stays', () => {
  const goes = run({ languages: ['en-US', 'id'], search: '?x=1', hash: '#y' });
  assert.deepEqual(goes.went, ['/en?x=1#y']);
  assert.equal(goes.leaving, true);
  assert.equal(goes.hidden, true, 'the Indonesian page would flash while /en loads');
  assert.deepEqual(run({ languages: ['en-GB'] }).went, ['/en']);
  assert.deepEqual(run({ language: 'en-AU' }).went, ['/en'], 'navigator.language is the fallback when languages is absent');
  // Stays: Indonesian, other languages, and an English SECOND language.
  for (const languages of [['id-ID'], ['fr-FR'], ['id-ID', 'en-US'], []]) {
    const r = run({ languages });
    assert.deepEqual(r.went, [], `${languages} must stay on /`);
    assert.equal(r.leaving, false);
    assert.equal(r.hidden, false);
  }
  assert.deepEqual(run({}).went, [], 'no language at all stays');
});

test('3b. a stored choice wins over the browser, both ways', () => {
  assert.deepEqual(run({ languages: ['en-US'], stored: 'id' }).went, []);
  assert.deepEqual(run({ languages: ['id-ID'], stored: 'en' }).went, ['/en']);
  // Garbage in storage is no choice at all: the browser decides.
  assert.deepEqual(run({ languages: ['en-US'], stored: 'fr' }).went, ['/en']);
  assert.deepEqual(run({ languages: ['id-ID'], stored: 'fr' }).went, []);
});

test('3c. a crawler or headless agent is never moved, even stored-en or English; webdriver alone is not a bot', () => {
  const bots = [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    `${CHROME} Google-InspectionTool/1.0`, `${CHROME} Chrome-Lighthouse`, 'Mozilla/5.0 HeadlessChrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (compatible; bingbot/2.0)', 'Mozilla/5.0 (compatible; Yahoo! Slurp)', 'Mozilla/5.0 (compatible; SomeCrawler/1.0)', 'Mozilla/5.0 (compatible; MJ12spider)',
  ];
  for (const ua of bots) {
    assert.deepEqual(run({ ua, languages: ['en-US'] }).went, [], ua);
    assert.deepEqual(run({ ua, languages: ['id-ID'], stored: 'en' }).went, [], ua);
  }
  // CONTROL under the same harness: an ordinary UA goes, with webdriver true (Playwright).
  assert.deepEqual(run({ languages: ['en-US'], webdriver: true }).went, ['/en']);
});

test('3d. it does nothing off the exact path `/` (the same head is on /en, /dukung and the tool pages)', () => {
  for (const p of ['/en', '/en/support', '/dukung', '/privasi', '/kompres-pdf', '/index.html', '/x/']) {
    const r = run({ path: p, languages: ['en-US'], stored: 'en' });
    assert.deepEqual(r.went, [], p);
    assert.equal(r.leaving, false, p);
  }
  assert.deepEqual(run({ path: '/', languages: ['en-US'] }).went, ['/en'], 'CONTROL: the same inputs on `/` go');
});

test('3e. a throwing localStorage does not stop the redirect or throw', () => {
  const r = run({ languages: ['en-US'], storageThrows: true });
  assert.deepEqual(r.went, ['/en']);
  assert.deepEqual(run({ languages: ['id-ID'], storageThrows: true }).went, []);
});

test('4. a click on a language link writes its hreflang; nothing else writes', () => {
  const r = run({ path: '/en', languages: ['en-US'] });
  assert.equal(typeof r.listeners.click, 'function', 'no click listener is registered off `/` (dukung, /en and privasi need it)');
  r.click('id');
  assert.equal(r.store.get('pdflokal_lang'), 'id');
  r.click('en');
  assert.equal(r.store.get('pdflokal_lang'), 'en');
  r.store.delete('pdflokal_lang');
  r.click('fr');
  r.click('en', { isLink: false });
  assert.equal(r.store.has('pdflokal_lang'), false, 'a non-language click or a bad hreflang wrote a choice');
  // Storage that throws must not throw out of the listener (a page error per click otherwise).
  const t = run({ path: '/en', storageThrows: true });
  assert.doesNotThrow(() => t.click('id'));
});

test('5. an Indonesian time zone keeps an English browser on `/`; every other zone leaves the browser language in charge', () => {
  for (const timeZone of ['Asia/Jakarta', 'Asia/Pontianak', 'Asia/Makassar', 'Asia/Jayapura']) {
    const r = run({ languages: ['en-US'], timeZone });
    assert.deepEqual(r.went, [], timeZone);
    assert.equal(r.leaving, false, timeZone);
    assert.equal(r.hidden, false, timeZone);
  }
  // CONTROLS under the same harness: other zones (Malaysia, Brunei, anywhere) go.
  for (const timeZone of ['Asia/Kuala_Lumpur', 'Asia/Kuching', 'Asia/Brunei', 'Asia/Singapore', 'America/New_York', 'UTC', undefined, '']) {
    assert.deepEqual(run({ languages: ['en-US'], timeZone }).went, ['/en'], String(timeZone));
  }
  // Exact match only: a lookalike is not Indonesia.
  assert.deepEqual(run({ languages: ['en-US'], timeZone: 'Asia/Jakarta2' }).went, ['/en']);
  assert.deepEqual(run({ languages: ['en-US'], timeZone: 'asia/jakarta' }).went, ['/en']);
  // An Indonesian browser stays in any zone.
  assert.deepEqual(run({ languages: ['id-ID'], timeZone: 'Europe/London' }).went, []);
});

test('5b. the time zone sits below a stored choice and a crawler; Intl failing falls back to the language', () => {
  assert.deepEqual(run({ languages: ['en-US'], timeZone: 'Asia/Jakarta', stored: 'en' }).went, ['/en'], 'stored en beats the Jakarta rule');
  assert.deepEqual(run({ languages: ['id-ID'], timeZone: 'Asia/Jakarta', stored: 'en' }).went, ['/en']);
  assert.deepEqual(run({ languages: ['en-US'], timeZone: 'America/New_York', stored: 'id' }).went, [], 'stored id still stays');
  assert.deepEqual(run({ ua: 'Mozilla/5.0 (compatible; Googlebot/2.1)', languages: ['en-US'], timeZone: 'America/New_York' }).went, []);
  // Old browsers: Intl throws -> the old rule, no exception out of the script.
  assert.deepEqual(run({ languages: ['en-US'], intlThrows: true }).went, ['/en']);
  assert.deepEqual(run({ languages: ['id-ID'], intlThrows: true }).went, []);
  // Off `/` the time zone is never even asked.
  assert.deepEqual(run({ path: '/en', languages: ['en-US'], timeZone: 'America/New_York' }).went, []);
});
