/*
 * core/font-decide.js — tier-1 exact-clone routing (spec-font-fidelity-engine.md §3).
 * Pure string logic — zero PDFLib/fixture needed, same shape as font-style.test.mjs's
 * parseStyleFromName block. The table rows are the REAL /BaseFont spellings the
 * wild produces (Word, LibreOffice, InDesign, pdf-lib itself).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBaseFont, cloneFamilyFor } from '../../js/core/font-decide.js';

test('normalizeBaseFont: strips subset prefix, style suffixes, foundry noise', () => {
  assert.equal(normalizeBaseFont('ABCDEF+Calibri-Bold'), 'calibri');
  assert.equal(normalizeBaseFont('Arial-BoldMT'), 'arial');
  assert.equal(normalizeBaseFont('ArialMT'), 'arial');
  assert.equal(normalizeBaseFont('TimesNewRomanPS-BoldItalicMT'), 'timesnewroman');
  assert.equal(normalizeBaseFont('TimesNewRomanPSMT'), 'timesnewroman');
  assert.equal(normalizeBaseFont('CourierNewPS-ItalicMT'), 'couriernew');
  assert.equal(normalizeBaseFont('Arial,Bold'), 'arial');
  // a '+' that is not a 6-letter subset tag is kept as name content (stripped
  // as non-alphabetic by the fold, but the head is NOT cut)
  assert.equal(normalizeBaseFont('Ab+Cd'), 'abcd');
  assert.equal(normalizeBaseFont(''), '');
  assert.equal(normalizeBaseFont(undefined), '');
});

test('cloneFamilyFor: the ratified table — Word/system fonts route to metric twins', () => {
  const cases = [
    ['ABCDEF+Calibri', 'Carlito'],
    ['GHIJKL+Calibri-BoldItalic', 'Carlito'],
    ['ArialMT', 'Arimo'],
    ['Arial-BoldMT', 'Arimo'],
    ['Helvetica', 'Arimo'],
    ['Helvetica-Oblique', 'Arimo'],
    ['LiberationSans', 'Arimo'],
    ['TimesNewRomanPSMT', 'Tinos'],
    ['TimesNewRomanPS-BoldMT', 'Tinos'],
    ['Times-Roman', 'Tinos'],
    ['LiberationSerif-Italic', 'Tinos'],
    ['CourierNewPSMT', 'Cousine'],
    ['Courier', 'Cousine'],
    ['Cambria', 'Caladea'],
    ['ABCDEF+Cambria-Bold', 'Caladea'],
  ];
  for (const [input, want] of cases) {
    assert.equal(cloneFamilyFor(input), want, `cloneFamilyFor(${input})`);
  }
});

test('cloneFamilyFor: everything outside the table declines to null (never guesses)', () => {
  for (const name of [
    'ABCDEF+Aptos', // Word 2024 default — no metric clone exists anywhere
    'Montserrat-Regular',
    'Georgia',
    'Verdana', // metric-DIFFERENT sans; Arimo would shift layout — must not route
    'SegoeUI',
    'CMR10',
    '',
    'MT', // pure noise reduces to empty — must not accidentally match
    // width-changing variants of table families — metrics differ from the
    // clones we ship, so exact-match MUST break and decline them:
    'ArialNarrow',
    'Arial-Black',
    'CambriaMath',
    'Calibri-Light',
    'HelveticaNeue',
  ]) {
    assert.equal(cloneFamilyFor(name), null, `cloneFamilyFor(${name})`);
  }
});
