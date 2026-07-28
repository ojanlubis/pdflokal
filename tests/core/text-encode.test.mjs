/*
 * WinAnsi survival for pasted text (headless) — core/text-encode.js.
 *
 * THE INCIDENT, 2026-07-28. One user: 82 minutes, 174 text annotations, 41
 * download attempts, zero successful exports. Cause: pdf-lib's STANDARD fonts
 * encode through WinAnsi, one codepoint outside it throws a bare Error, and
 * core/export.js has no per-annotation guard — so a single invisible character
 * in one of 174 annotations destroys the entire document. Helvetica is the
 * DEFAULT font, so this is the ordinary path.
 *
 * These tests drive the REAL vendored pdf-lib. They do not hardcode which
 * characters throw; they ASK it. If a vendor upgrade changes the encodable set,
 * that shows up here instead of in someone's lost afternoon.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toStandardFontSafe, unencodableInStandardFont, isStandardFamily } from '../../js/core/text-encode.js';
import { failureReason } from '../../js/core/failure-reason.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'window', 'define', 'globalThis',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports && Object.keys(module.exports).length ? module.exports : globalThis.PDFLib;
};
const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');

// Draw with a real standard font and report what pdf-lib actually did.
async function draws(text) {
  const doc = await PDFLib.PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  try {
    page.drawText(text, { x: 40, y: 400, size: 11, font });
    return { ok: true };
  } catch (err) {
    return { ok: false, name: err.name, message: err.message };
  }
}

// The characters this module claims to rescue, as codepoints.
const RESCUED = [
  0x200b, 0x200c, 0x200d, 0x2060, 0xfeff,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008,
  0x2009, 0x200a, 0x202f, 0x205f, 0x3000, 0x1680,
  0x2010, 0x2011, 0x2012, 0x2212,
  0x2032, 0x2033, 0x2028, 0x2029,
].map((cp) => String.fromCodePoint(cp));

test('1. VACUITY GUARD: these characters really do break a standard font today', async () => {
  // If this stops being true, the module is protecting against nothing and
  // every test below would pass while proving it.
  const throwing = [];
  for (const ch of RESCUED) {
    const r = await draws(`teks ${ch} teks`);
    if (!r.ok) throwing.push(ch);
  }
  assert.ok(
    throwing.length >= 20,
    `only ${throwing.length}/${RESCUED.length} of the mapped characters still throw — `
    + 'if pdf-lib learned to encode them, this module may no longer be needed',
  );
});

test('2. after sanitising, NONE of them throw', async () => {
  for (const ch of RESCUED) {
    const safe = toStandardFontSafe(`teks ${ch} teks`);
    const r = await draws(safe);
    assert.ok(r.ok, `U+${ch.codePointAt(0).toString(16)} still throws after sanitising: ${r.message}`);
  }
});

test('3. nothing a reader can SEE is changed', async () => {
  // The mapping must never become a transliterator: rewriting visible text
  // would be silently editing the user's document.
  for (const clean of [
    'Pondok Sapi, Cibeber',
    'Rp 1.500.000 — “Budi Santoso”',
    'e-mail: budi@contoh.id · 50% · ½ · café · naïve',
    'Ini kalimat biasa… dengan elipsis dan  spasi-tanpa-putus.',
  ]) {
    assert.equal(toStandardFontSafe(clean), clean, `sanitiser altered visible text: ${clean}`);
    assert.ok((await draws(clean)).ok, `clean text should already draw: ${clean}`);
  }
});

test('4. THE INCIDENT SHAPE: 174 annotations, exactly one poisoned, still exports', async () => {
  // The dimension that matters is the CHARACTER, not the count. An earlier
  // reproduction varied the count with pure-ASCII text and passed at 174,
  // which ruled out the wrong hypothesis.
  //
  // The poison is built from a CODEPOINT, never typed as a literal: writing a
  // thin space into source is how the first draft of this test silently became
  // a plain space and asserted nothing.
  const POISON = String.fromCodePoint(0x2009); // THIN SPACE
  const lines = Array.from({ length: 174 }, (_, i) => (i === 91 ? `Rp 10.000${POISON}sudah` : `Catatan ${i}`));

  const fresh = async () => {
    const doc = await PDFLib.PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
    return { page, font };
  };

  // BEFORE: one bad line among 174 kills the whole document.
  const a = await fresh();
  assert.throws(() => {
    for (const l of lines) a.page.drawText(l, { x: 40, y: 400, size: 11, font: a.font });
  }, /cannot encode/, 'the poisoned line must break an unsanitised run, or this proves nothing');

  // AFTER: the same 174 lines, sanitised, all draw.
  const b = await fresh();
  for (const l of lines) b.page.drawText(toStandardFontSafe(l), { x: 40, y: 400, size: 11, font: b.font });

  // And the rescue is real, not incidental: the poisoned line specifically.
  assert.equal(toStandardFontSafe(lines[91]), 'Rp 10.000 sudah');
});

test('5. THE KNOWN LIMIT: an emoji still fails — but now it SAYS so', async () => {
  // Deliberately not fixed here: dropping a character the user can SEE is a
  // product call, not a bug fix. What changed is that the rail can name it, so
  // the seat can decide with data instead of a guess.
  const r = await draws('oke \u{1F44D}');
  assert.equal(r.ok, false, 'emoji unexpectedly encodable — revisit the header note');
  assert.equal(r.name, 'Error', 'pdf-lib still gives us no usable error name');
  assert.equal(failureReason(r), 'unsupported');
  assert.notEqual(failureReason(r), 'unknown');
});

test('6. THE PREDICATE IS DERIVED, NOT REMEMBERED: it agrees with real pdf-lib', async () => {
  // unencodableInStandardFont() decides whether to WARN the user at commit.
  // If it drifts from what pdf-lib actually accepts it either cries wolf or
  // misses the crash, and both are invisible without this check. So walk real
  // codepoints through the real library and demand exact agreement.
  const ranges = [[0x20, 0x7f], [0xa0, 0x180], [0x2000, 0x2070], [0x20a0, 0x20d0], [0x4e00, 0x4e10]];
  const disagreements = [];
  let checked = 0;
  for (const [lo, hi] of ranges) {
    for (let cp = lo; cp < hi; cp++) {
      const ch = String.fromCodePoint(cp);
      // Ask the library. Sanitise first: that is what export.js actually draws.
      const drawn = await draws(toStandardFontSafe(ch));
      const wePredict = unencodableInStandardFont(ch).length > 0;
      const libRejects = !drawn.ok;
      checked++;
      if (wePredict !== libRejects) disagreements.push(`U+${cp.toString(16)} we=${wePredict} lib=${libRejects}`);
    }
  }
  assert.ok(checked > 400, `only ${checked} codepoints checked — the sweep is too small to mean anything`);
  assert.deepEqual(disagreements.slice(0, 12), [], `predicate disagrees with pdf-lib on ${disagreements.length}/${checked}`);
});

test('7. the standard-family list matches the families that actually throw', () => {
  // Only pdf-lib's built-ins encode through WinAnsi. The embedded clones paint
  // .notdef instead of throwing, so warning about them would be manufactured
  // alarm about a different defect.
  for (const f of ['Helvetica', 'Times-Roman', 'Courier']) assert.equal(isStandardFamily(f), true, f);
  for (const f of ['Montserrat', 'Carlito', 'Arimo', 'Tinos', 'Cousine', 'Caladea']) {
    assert.equal(isStandardFamily(f), false, f);
  }
  assert.equal(isStandardFamily(undefined), true, 'no family means the Helvetica default');
});

test('8. emoji and CJK are REPORTED, never silently removed', async () => {
  // The ruling: warn at commit, never drop. Dropping deletes something the
  // user can see; the sanitiser must not have quietly eaten it.
  const txt = 'oke \u{1F44D} 中';
  assert.deepEqual(unencodableInStandardFont(txt), ['\u{1F44D}', '中']);
  assert.equal(toStandardFontSafe(txt), txt, 'sanitiser must leave visible characters alone');
});
