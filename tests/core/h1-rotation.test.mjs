/*
 * The homepage headline rotation's pure rules (2026-10-06): the thresholds, the
 * pick, and the shape of the pool. Wiring (WIB day counter, the h1 write, the
 * gates) is rendered in tests/h1-rotation.spec.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LEVELS, DEFAULT_H1, levelFor, pickH1, wibDay } from '../../js/core/h1-rotation.js';

test('levelFor: every threshold edge', () => {
  const edges = [[1, 0], [2, 1], [3, 1], [4, 2], [7, 2], [8, 3], [14, 3], [15, 4], [29, 4], [30, 5], [400, 5]];
  for (const [days, level] of edges) assert.equal(levelFor(days), level, `day ${days}`);
});

test('levelFor: nothing usable is level 0 (static), never a throw', () => {
  for (const bad of [0, -3, NaN, undefined, null, 'x', Infinity * 0]) assert.equal(levelFor(bad), 0, String(bad));
});

const LANGS = ['id', 'en'];

test('level 0 is each page\'s own static headline: pickH1 returns null', () => {
  for (const lang of LANGS) {
    assert.equal(pickH1({ visitDays: 1, lang }), null);
    assert.equal(pickH1({ visitDays: 0, last: 'x', lang }), null);
  }
  assert.equal(pickH1({}), null);
  assert.deepEqual(LEVELS.id[0], ['Buat ngurus PDF.']);
  assert.deepEqual(LEVELS.en[0], ['For all your PDF Needs']);
  assert.deepEqual(DEFAULT_H1, { id: 'Buat ngurus PDF.', en: 'For all your PDF Needs' });
});

test('both languages have the same six levels: five lines in 1-4, seven in 5', () => {
  for (const lang of LANGS) {
    assert.equal(LEVELS[lang].length, 6, lang);
    for (let l = 1; l <= 4; l++) assert.equal(LEVELS[lang][l].length, 5, `${lang} level ${l}`);
    assert.equal(LEVELS[lang][5].length, 7, `${lang} level 5`);
  }
});

test('pickH1 never repeats last, for every line of every level, at every random value, in both languages', () => {
  const dayOf = [1, 2, 4, 8, 15, 30];
  for (const lang of LANGS) {
    for (let level = 1; level <= 5; level++) {
      for (const last of LEVELS[lang][level]) {
        for (let k = 0; k < 20; k++) {
          const got = pickH1({ visitDays: dayOf[level], last, rand: () => k / 20, lang });
          assert.ok(LEVELS[lang][level].includes(got), `${got} belongs to ${lang} level ${level}`);
          assert.notEqual(got, last);
        }
      }
    }
  }
});

test('pickH1 reaches every line of a level (the rand mapping is not lopsided)', () => {
  for (const lang of LANGS) {
    for (let level = 1; level <= 5; level++) {
      const seen = new Set();
      for (let k = 0; k < 50; k++) seen.add(pickH1({ visitDays: [1, 2, 4, 8, 15, 30][level], last: null, rand: () => k / 50, lang }));
      assert.deepEqual([...seen].sort(), [...LEVELS[lang][level]].sort());
    }
  }
});

test('an unknown language falls back to Indonesian, never a throw', () => {
  assert.ok(LEVELS.id[3].includes(pickH1({ visitDays: 10, lang: 'fr', rand: () => 0.1 })));
});

test('pickH1 survives rand() at the edges', () => {
  for (const r of [0, 0.999999999, 1, -1, NaN]) {
    const got = pickH1({ visitDays: 10, last: null, rand: () => r });
    assert.ok(LEVELS.id[3].includes(got), `rand ${r}`);
  }
});

test('level 5 is random like the others: seven lines, no empty headline anywhere', () => {
  for (const lang of LANGS) {
    for (const lines of LEVELS[lang]) for (const l of lines) assert.ok(l.trim().length > 0, `${lang}: empty line`);
    for (let k = 0; k < 20; k++) assert.ok(LEVELS[lang][5].includes(pickH1({ visitDays: 99, last: null, rand: () => k / 20, lang })));
  }
});

test('his words, character for character (Indonesian level 4 spelling and punctuation)', () => {
  assert.deepEqual(LEVELS.id[4], [
    'Kamu lagi ngejar apa sih?', 'Hidup lagi capek2nya...', 'In this economy...', 'Dewasa bukan soal umur', 'Ketabahan adalah kekuatan',
  ]);
  assert.ok(!LEVELS.id[3].includes('Kabar ibumu gimana?'), 'he cut it');
  for (const l of Object.values(LEVELS).flat(2)) assert.ok(!l.includes('\u2014'), `no em-dash: ${l}`);
});

test('level 5, his words verbatim (no full stop on the last three, Tuhan capitalised)', () => {
  assert.deepEqual(LEVELS.id[5], [
    'Bebanmu tak melebihi kekuatanmu.', 'Terhimpit, tapi tak hancur.', 'Bersama kesulitan ada kemudahan.', 'Dari tanah, kembali ke tanah.',
    'Semoga Tuhan menjaga kita', 'Semoga doa kita terkabul', 'Semoga kebahagiaan menyertai kita',
  ]);
  assert.deepEqual(LEVELS.en[5], [
    'No burden beyond what you can bear.', 'Pressed, but not crushed.', 'With hardship comes ease.', 'From dust, back to dust.',
    'May God watch over us', 'May our prayers be answered', 'May happiness be with us',
  ]);
});

test('the English lines are the seat draft table, in order', () => {
  assert.deepEqual(LEVELS.en[1], ['For doing stuff to PDFs.', 'For sorting out documents.', 'PDF again? PDF again.', 'More documents, huh?', 'Back with another file?']);
  assert.deepEqual(LEVELS.en[2], ["Relax. Don't panic.", "When's the deadline?", 'Got all the paperwork?', 'Still waiting on whose signature?', "Your boss doesn't need to know."]);
  assert.deepEqual(LEVELS.en[3], ["Don't forget to smile.", 'Have you eaten?', 'Drink some water first.', 'Sleeping enough?', 'When was your last day off?']);
  assert.deepEqual(LEVELS.en[4], ['What are you chasing, really?', "Life's been heavy lately...", 'In this economy...', "Growing up isn't about age", 'Patience is a kind of strength']);
});

test('wibDay is the Jakarta calendar day', () => {
  assert.equal(wibDay(Date.parse('2026-10-06T16:59:59Z')), '2026-10-06');
  assert.equal(wibDay(Date.parse('2026-10-06T17:00:00Z')), '2026-10-07');
  assert.equal(wibDay(Date.parse('2026-12-31T20:00:00Z')), '2027-01-01');
});
