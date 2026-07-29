/*
 * THE EDIT PATH MUST SURVIVE PASTED INVISIBLE CHARACTERS TOO.
 * ============================================================================
 * LIVE BREAKAGE, 2026-07-28. One user, two consecutive sessions six minutes
 * apart (they reloaded and tried again): 24 `ganti_commit`, 10
 * `failure{stage:export, reason:unsupported}`, ZERO successful exports. Every
 * `surgery` and `insert` reported `clean` right up to the download. Nine
 * minutes of editing, nothing to show for it.
 *
 * ⚠️ THEY WERE RUNNING THE WINANSI FIX ITSELF (app_version 5f9b92a). The fix
 * did not rescue them. It made the failure LEGIBLE — 'unsupported' instead of
 * 'unknown', the classifier working exactly as built — while the user still
 * could not save their document.
 *
 * WHY: `toStandardFontSafe` was wired into ONE drawText call site,
 * export.js's ANNOTATION path, because that is where the first incident
 * happened. There were four sites. The Edit/ganti reinsert stamps through
 * core/stamp.js, which never saw the sanitiser, so a thin space or a ZWSP
 * pasted from Word still reached pdf-lib's WinAnsi encoder and threw.
 *
 * ⭐ THE LESSON, and it is the expensive one: I FIXED THE SITE, NOT THE CLASS.
 * A guard applied at the place a bug was observed leaves every sibling path
 * unguarded, and the telemetry then reports the same failure from a route
 * nobody re-checked. The structural answer is drawTextSafe() plus the static
 * test in stamp-drawtext-chokepoint — one door, and a scan that proves there
 * is only one.
 *
 * WHY SANITISE RATHER THAN DECLINE: every offender is INVISIBLE — thin space,
 * ZWSP, BOM, non-breaking hyphen. The user cannot see them, did not type them
 * deliberately, and pasted them in from Word or a web page. Stripping them is
 * lossless. Declining asks someone to hunt for a character that renders as
 * nothing, which is also why the warning copy has been stuck waiting on a
 * ruling.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStampFont, stampText } from '../../js/core/stamp.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'window', 'define', 'globalThis',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports && Object.keys(module.exports).length ? module.exports : globalThis.PDFLib;
};
const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');

// The characters real users actually paste. All invisible; all fatal to a
// WinAnsi standard font.
const ZWSP = String.fromCodePoint(0x200b);
const THIN = String.fromCodePoint(0x2009);
const BOM = String.fromCodePoint(0xfeff);
const NBHY = String.fromCodePoint(0x2011);

async function standardFontPage() {
  // The TWIN rung: a plain standard font, which is what the ladder falls back
  // to and what encodes through WinAnsi.
  const doc = await PDFLib.PDFDocument.create();
  doc.registerFontkit(fontkit);
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  return { page, font };
}

test('1. REPRODUCTION: the edit path stamps text carrying a ZWSP without throwing', async () => {
  const { page, font } = await standardFontPage();
  const insert = { fontName: 'Helvetica', x: 72, y: 700, ux: 1, uy: 0, size: 11, mixedFonts: false };
  // Exactly the shape of the live failure: ordinary Indonesian with one
  // invisible character pasted into the middle of it.
  const text = `Nama${ZWSP} : Budi Santoso`;
  assert.doesNotThrow(
    () => stampText(page, PDFLib, font, insert, text, '#000000'),
    'the Edit/ganti reinsert still throws on an invisible pasted character, which is the '
    + '2026-07-28 live breakage: 24 commits, 10 failures, zero exports',
  );
});

test('2. every invisible offender, one at a time', async () => {
  const insert = { fontName: 'Helvetica', x: 72, y: 700, ux: 1, uy: 0, size: 11, mixedFonts: false };
  for (const [name, ch] of [['ZWSP', ZWSP], ['THIN SPACE', THIN], ['BOM', BOM], ['NB-HYPHEN', NBHY]]) {
    const { page, font } = await standardFontPage();
    assert.doesNotThrow(
      () => stampText(page, PDFLib, font, insert, `Jalan${ch}Merdeka 17`, '#000000'),
      `${name} still kills an Edit commit`,
    );
  }
});

test('3. VACUITY GUARD: the raw characters really do still break pdf-lib', async () => {
  // If pdf-lib ever starts accepting these, tests 1 and 2 would pass against a
  // sanitiser that does nothing at all, and this file would be decoration.
  const { page, font } = await standardFontPage();
  assert.throws(
    () => page.drawText(`Nama${ZWSP} : Budi`, { x: 72, y: 700, size: 11, font }),
    /cannot encode/,
    'pdf-lib no longer throws on a ZWSP, so these tests can no longer distinguish anything',
  );
});

test('4. the visible text is PRESERVED, not mangled, by the rescue', async () => {
  // Sanitising must not become a licence to alter what the user can see. A
  // fix that silently rewrote their words would be worse than the crash.
  const { toStandardFontSafe } = await import('../../js/core/text-encode.js');
  assert.equal(toStandardFontSafe(`Nama${ZWSP} : Budi Santoso`), 'Nama : Budi Santoso');
  assert.equal(toStandardFontSafe(`Rp 10.000${THIN}saja`), 'Rp 10.000 saja');
  assert.equal(toStandardFontSafe('Perihal: Undangan Rapat'), 'Perihal: Undangan Rapat');
});
