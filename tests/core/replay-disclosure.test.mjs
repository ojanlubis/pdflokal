/*
 * THE RECORDERS THAT SHIP AND THE RECORDERS /privasi NAMES ARE THE SAME SET.
 * ============================================================================
 * Replaces replay-study-expiry.test.mjs (retired 2026-10-01). That file went
 * red on 2026-10-11 if Mixpanel's recorder was still on, because the recorder
 * was a one-month study. On 2026-10-01 he ruled the replay keeps running (seat
 * decisions.md, 2026-10-01 sore), so the date it enforced stopped being a
 * fact and the file became a bomb that would turn every CI run red.
 *
 * What still matters, and is what this file guards, is the DISCLOSURE: the
 * privacy page is the one claim this product cannot get wrong, and the replay
 * config and the page that describes it live in different files that nobody
 * edits together. So, in both directions:
 *   - Mixpanel's recorder is configured in index.html (comments stripped)
 *     => privasi.html's Perekaman Sesi section names Mixpanel, and its line
 *        carries no end date (no "sampai", no day-month-year, no "batas waktu").
 *   - The recorder is gone => the section does not name Mixpanel at all.
 *   - Same pair for Sentry's replayIntegration in js/sentry-init.js.
 *
 * ⚠️ HTML COMMENTS ARE STRIPPED BEFORE ANY KEY IS LOOKED FOR, carried over
 * from the file this replaces: index.html's head DISCUSSES record_* keys by
 * name at length, so a bare includes() is satisfied by the prose about the
 * key. The keys are matched with their `:` so only the config site counts.
 * The section is likewise read with comments and tags removed, because the
 * comment above it names Mixpanel and the 2026-10-10 date on purpose.
 *
 * The red-on-revert proofs are in this file, run against mutated copies of
 * the real strings, so the guard is shown able to go red every time it runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const stripComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const toText = (s) => stripComments(s).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const MONTHS = 'Januari|Februari|Maret|April|Mei|Juni|Juli|Agustus|September|Oktober|November|Desember';
const END_DATE = new RegExp(`\\bsampai\\b|\\bbatas waktu\\b|\\b\\d{1,2}\\s+(${MONTHS})\\s+20\\d\\d\\b`, 'i');

export function mixpanelRecorderOn(indexHtml) {
  const m = stripComments(indexHtml).match(/record_sessions_percent\s*:\s*(\d+)/);
  return Boolean(m && Number(m[1]) > 0);
}

export function sentryReplayOn(sentryInit) {
  const code = sentryInit.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const m = code.match(/replaysSessionSampleRate\s*:\s*([\d.]+)/);
  const e = code.match(/replaysOnErrorSampleRate\s*:\s*([\d.]+)/);
  return /replayIntegration\s*\(/.test(code)
    && ((m && Number(m[1]) > 0) || (e && Number(e[1]) > 0));
}

// The Perekaman Sesi section's raw HTML: from its heading to the next section.
export function replaySection(privasiHtml) {
  const html = stripComments(privasiHtml);
  const start = html.search(/<h2>\s*Perekaman sesi/i);
  if (start < 0) return null;
  const rest = html.slice(start);
  const end = rest.indexOf('class="privacy-section"');
  return end < 0 ? rest : rest.slice(0, end);
}

export function disclosureProblems({ indexHtml, privasiHtml, sentryInit }) {
  const problems = [];
  const section = replaySection(privasiHtml);
  if (section === null) return ['privasi.html has no "Perekaman Sesi" section'];
  const text = toText(section);
  const items = [...section.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => toText(m[1]));

  const mpOn = mixpanelRecorderOn(indexHtml);
  const mpItem = items.find((t) => /^Mixpanel\b/.test(t));
  if (mpOn && !mpItem) problems.push('Mixpanel records sessions but privasi.html does not list it');
  if (mpOn && mpItem && END_DATE.test(mpItem)) {
    problems.push(`privasi.html gives Mixpanel's recording an end date it no longer has: "${mpItem}"`);
  }
  if (mpOn && /\bbatas waktu\b/i.test(text)) {
    problems.push('privasi.html still says the recording has a time limit ("batas waktu")');
  }
  if (!mpOn && /Mixpanel/.test(text)) {
    problems.push('the Mixpanel recorder is off but privasi.html still describes it');
  }

  const sOn = sentryReplayOn(sentryInit);
  const sItem = items.find((t) => /^Sentry\b/.test(t));
  if (sOn && !sItem) problems.push('Sentry records sessions but privasi.html does not list it');
  if (!sOn && sItem) problems.push('Sentry replay is off but privasi.html still lists it');
  return problems;
}

const real = () => ({
  indexHtml: read('index.html'),
  privasiHtml: read('privasi.html'),
  sentryInit: read('js/sentry-init.js'),
});

test('the instrument sees both recorders and the section (known positive)', () => {
  const r = real();
  assert.equal(mixpanelRecorderOn(r.indexHtml), true, 'record_sessions_percent not found: renamed key, guard inert');
  assert.equal(sentryReplayOn(r.sentryInit), true, 'Sentry replayIntegration not found: guard inert');
  const section = replaySection(r.privasiHtml);
  assert.ok(section && toText(section).length > 200, 'Perekaman Sesi section not found or empty');
});

// Mutate inside the Perekaman sesi section only. Since 2026-10-02 the
// "Yang dikirim ke layanan lain" list ALSO has an item starting with
// "Mixpanel", earlier on the page, so an unscoped replace mutated that one and
// left the section under test untouched.
function inReplay(html, re, to) {
  const at = html.search(/<h2>\s*Perekaman sesi/i);
  assert.ok(at >= 0, 'Perekaman sesi heading not found');
  return html.slice(0, at) + html.slice(at).replace(re, to);
}

test('privasi.html names exactly the recorders that ship, with no end date', () => {
  assert.deepEqual(disclosureProblems(real()), []);
});

test('red on revert: the old 10 Oktober end date comes back', () => {
  const r = real();
  const privasiHtml = inReplay(r.privasiHtml,
    /<li>(?:<strong>)?Mixpanel\b[\s\S]*?<\/li>/,
    '<li><strong>Mixpanel</strong>, semua sesi, sampai <strong>10 Oktober 2026</strong>.</li>',
  );
  assert.notEqual(privasiHtml, r.privasiHtml, 'mutation did not apply');
  assert.equal(disclosureProblems({ ...r, privasiHtml }).length > 0, true);
});

test('red on revert: the page stops naming Mixpanel while it records', () => {
  const r = real();
  const privasiHtml = inReplay(r.privasiHtml, /<li>(?:<strong>)?Mixpanel\b[\s\S]*?<\/li>/, '');
  assert.notEqual(privasiHtml, r.privasiHtml, 'mutation did not apply');
  assert.match(disclosureProblems({ ...r, privasiHtml }).join('\n'), /does not list it/);
});

test('red on revert: the recorder is removed but the page still claims it', () => {
  const r = real();
  const indexHtml = r.indexHtml.replace(/record_sessions_percent\s*:\s*\d+,?/, '');
  assert.equal(mixpanelRecorderOn(indexHtml), false, 'mutation did not apply');
  assert.match(disclosureProblems({ ...r, indexHtml }).join('\n'), /off but privasi\.html still describes it/);
});

test('prose about a key is not the key: a commented-out recorder counts as off', () => {
  assert.equal(mixpanelRecorderOn('<!-- record_sessions_percent: 100 -->'), false);
  assert.equal(mixpanelRecorderOn('<script>x({ record_sessions_percent: 100 })</script>'), true);
  assert.equal(mixpanelRecorderOn('<script>x({ record_sessions_percent: 0 })</script>'), false);
});

test('red on revert: Sentry replay keeps running but drops off the page', () => {
  const r = real();
  const privasiHtml = inReplay(r.privasiHtml, /<li>(?:<strong>)?Sentry\b[\s\S]*?<\/li>/, '');
  assert.notEqual(privasiHtml, r.privasiHtml, 'mutation did not apply');
  assert.match(disclosureProblems({ ...r, privasiHtml }).join('\n'), /Sentry records sessions/);
});
