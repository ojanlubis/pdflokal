/*
 * The maker card's pure rules and the visitor count endpoint (2026-09-23).
 *
 * The approval rule is the one that matters most: Fauzan ruled a model writes
 * the entry and he approves it, so an unapproved entry reaching a visitor is
 * the defect. The endpoint's rule: a number it cannot vouch for is never
 * shown — a refused statement arrives as HTTP 200 on Turso (api/_turso.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UPDATES, shownUpdates, updateText } from '../../js/updates.js';
import { shouldShowCard, shortDate, formatCount } from '../../js/v2/maker-card.js';
import { countVisitors, startOfDayWIB, wibDay, MIN_SHOWN } from '../../api/visitors.js';

const u = (id, date, approved = true) => ({ id, date, text: `t ${id}`, approved });

test('only approved entries are shown, newest first, at most three', () => {
  const list = [u('a', '2026-09-01'), u('b', '2026-09-05', false), u('c', '2026-09-03'), u('d', '2026-09-04'), u('e', '2026-09-02')];
  assert.deepEqual(shownUpdates(list).map((x) => x.id), ['d', 'c', 'e']);
  assert.deepEqual(shownUpdates([u('x', '2026-09-01', false)]), []);
  // approved must be literally true, not truthy
  assert.deepEqual(shownUpdates([{ ...u('y', '2026-09-01'), approved: 'yes' }]), []);
});

test('the shipped list: every entry is well-formed and ids are unique', () => {
  // VACUITY: an empty UPDATES makes every check below pass having checked nothing.
  assert.ok(Array.isArray(UPDATES) && UPDATES.length > 0, 'UPDATES is empty, so the shipped list is unchecked');
  const ids = new Set();
  for (const e of UPDATES) {
    assert.match(e.id, /^[a-z0-9-]+$/);
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(typeof e.approved, 'boolean', `${e.id}: approved must be a boolean`);
    assert.ok(e.text.length > 0 && e.text.length <= 90, `${e.id}: text must fit two lines`);
    assert.ok(!e.text.includes('—'), `${e.id}: no em-dash in public copy`);
    // /en carries the card too (founder ruling 2026-10-02): an entry with no English
    // would put one Indonesian line on the English page.
    assert.ok(typeof e.en === 'string' && e.en.length > 0 && e.en.length <= 90, `${e.id}: needs an English line (en), at most 90 chars`);
    assert.ok(!e.en.includes('—'), `${e.id}: no em-dash in the English line`);
    assert.notEqual(e.en, e.text, `${e.id}: the English line is a copy of the Indonesian one`);
    assert.ok(!ids.has(e.id), `${e.id}: duplicate id`);
    ids.add(e.id);
  }
});

test('the card shows when the newest approved id is unseen, and only then', () => {
  const entries = [u('new', '2026-09-23'), u('old', '2026-09-20')];
  assert.equal(shouldShowCard(entries, null), true);
  assert.equal(shouldShowCard(entries, 'old'), true);
  assert.equal(shouldShowCard(entries, 'new'), false);
  assert.equal(shouldShowCard([], null), false);
});

// Run fn with the page language set, as the browser would have it.
function withLang(lang, fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = { documentElement: { lang } };
  try { return fn(); } finally {
    if (had) Object.defineProperty(globalThis, 'document', had); else delete globalThis.document;
  }
}

test('on /en the dates, the count and the update lines are English; the Indonesian is unchanged', () => {
  withLang('en', () => {
    assert.equal(shortDate('2026-08-01'), '1 Aug');
    assert.equal(shortDate('2026-10-23'), '23 Oct');
    assert.equal(shortDate('2026-12-05'), '5 Dec');
    assert.equal(shortDate('2026-05-09'), '9 May');
    assert.equal(formatCount(1234), '1,234');
    const u = UPDATES[0];
    assert.equal(updateText(u), u.en);
    assert.notEqual(updateText(u), u.text, 'the English line is the Indonesian one');
  });
  // CONTROL: out of the withLang block the same calls are Indonesian again.
  assert.equal(shortDate('2026-08-01'), '1 Agu');
  assert.equal(updateText(UPDATES[0]), UPDATES[0].text);
  // An entry with no `en` falls back to the Indonesian line, never to blank.
  assert.equal(updateText({ text: 'x' }, 'en'), 'x');
});

test('dates and counts render short and Indonesian', () => {
  assert.equal(shortDate('2026-09-23'), '23 Sep');
  assert.equal(shortDate('2026-08-01'), '1 Agu');
  assert.equal(shortDate('garbage'), '');
  assert.equal(formatCount(1234), '1.234');
  assert.equal(formatCount(null), null);
  assert.equal(formatCount(3.5), null);
});

// ---- api/visitors.js -------------------------------------------------------

async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const turso = (body, status = 200) => async () => ({ ok: status < 400, status, json: async () => body });
const row = (v) => ({ results: [{ type: 'ok', response: { type: 'execute', result: { rows: [[{ type: 'integer', value: String(v) }]] } } }, { type: 'ok', response: { type: 'close' } }] });
const cfg = { url: 'libsql://x.turso.io', token: 't', now: Date.parse('2026-09-23T10:00:00Z') };

test('countVisitors: a real count comes back as a number', async () => {
  let sent;
  const n = await withFetch(async (url, init) => { sent = JSON.parse(init.body); return turso(row(184))(); }, () => countVisitors(cfg));
  assert.equal(n, 184);
  assert.equal(sent.requests[0].stmt.args[0].value, '2026-09-23', 'the WIB day of now (17:00 WIB)');
});

test('countVisitors: reads ONE row of the tally, never the events table (rows-read quota, 2026-10-06)', async () => {
  let sent;
  await withFetch(async (url, init) => { sent = JSON.parse(init.body); return turso(row(184))(); }, () => countVisitors(cfg));
  const sql = sent.requests[0].stmt.sql;
  assert.match(sql, /from visitor_day_counts where day = \?/i);
  assert.doesNotMatch(sql, /\bevents\b/i, 'a count over events reads every row of the day (or worse) per call');
});

test('wibDay: the Jakarta calendar date', () => {
  assert.equal(wibDay(Date.parse('2026-09-24T16:59:59Z')), '2026-09-24');
  assert.equal(wibDay(Date.parse('2026-09-24T17:00:00Z')), '2026-09-25');
});

test('startOfDayWIB: the Jakarta calendar day, not the UTC one', () => {
  // 17:00Z is 00:00 WIB — the boundary itself belongs to the new day.
  assert.equal(startOfDayWIB(Date.parse('2026-09-24T17:00:00Z')), '2026-09-24T17:00:00.000Z');
  // 16:59Z is 23:59 WIB, still yesterday in Jakarta.
  assert.equal(startOfDayWIB(Date.parse('2026-09-24T16:59:59Z')), '2026-09-23T17:00:00.000Z');
  // 00:30Z is 07:30 WIB — same Jakarta day as the 17:00Z boundary before it.
  assert.equal(startOfDayWIB(Date.parse('2026-09-25T00:30:00Z')), '2026-09-24T17:00:00.000Z');
});

test('countVisitors: anything it cannot vouch for is null, never a number', async () => {
  const refused = { results: [{ type: 'error', error: { code: 'SQLITE_ERROR', message: 'x' } }] };
  assert.equal(await withFetch(turso(refused), () => countVisitors(cfg)), null, 'refused inside a 200');
  assert.equal(await withFetch(turso({}, 500), () => countVisitors(cfg)), null, 'http error');
  assert.equal(await withFetch(async () => { throw new TypeError('net'); }, () => countVisitors(cfg)), null, 'network');
  assert.equal(await withFetch(turso(row(MIN_SHOWN - 1)), () => countVisitors(cfg)), null, 'below the floor');
  assert.equal(await countVisitors({ ...cfg, url: '', token: '' }), null, 'unconfigured (preview)');
});
