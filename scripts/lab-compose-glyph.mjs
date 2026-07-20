/*
 * LAB — tier-2 glyph COMPOSITION prototype (spec-font-fidelity-engine.md §4)
 * ============================================================================
 * Proves ONE real case end to end: a TRUE subset (tests/fixtures/nasty/
 * carlito-subset.ttf — é present as a composite, É absent, the acute outline
 * reachable ONLY as an un-cmapped glyf component) receives an edit containing
 * É, and we paint É in the document's OWN font by composing base E + the
 * subset's own acute — two show ops, zero font mutation, zero guess.
 *
 * Run: `node scripts/lab-compose-glyph.mjs [outDir]` (outDir defaults to the
 * OS temp dir). Writes out-before.pdf / out-composed.pdf / out-reference.pdf.
 * The reference uses the FULL Carlito (fonts/carlito-regular.woff2) so the
 * composed accent can be judged against the font designer's own É.
 *
 * STATUS: proposal-grade lab code. The ship version of the planner lands as
 * js/core/compose.js behind js/core/font-decide.js (see the spec §2/§4) with
 * typed decline reasons; this file exists so the spec's claims stay runnable.
 *
 * Same "load the vendored UMD in the current realm" loader every
 * gen-fixture-*.mjs script uses (a vm sandbox breaks pdf-lib's type checks).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] || os.tmpdir();
const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis);
  return module.exports;
};
const PDFLib = loadUmd('js/vendor/pdf-lib.min.js');
const fontkit = loadUmd('js/vendor/fontkit.umd.min.js');
const { extractFontProgram, appendNativeText } = await import(path.join(root, 'js/core/reinsert.js'));

// ---------------------------------------------------------------------------
// 1) FIXTURE — a nota using the true subset (real sfnt in FontFile2)
// ---------------------------------------------------------------------------
const subsetBytes = new Uint8Array(fs.readFileSync(path.join(root, 'tests/fixtures/nasty/carlito-subset.ttf')));

async function makeDoc(fontBytes, lines) {
  const doc = await PDFLib.PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: false });
  const page = doc.addPage([595, 842]);
  const ink = PDFLib.rgb(0.1, 0.1, 0.12);
  for (const [text, x, y, size] of lines) page.drawText(text, { x, y, size, font, color: ink });
  return doc;
}

const FIXTURE_LINES = [
  ['FORMULIR PESANAN', 72, 760, 20],
  ['Kafé Andréa, Jakarta Selatan', 72, 720, 12],
  ['Kepada Bapak Dimas Rahman: Edisi Juli 2026', 72, 690, 12],
  ['pesanan kopi susu gula aren, total Rp 48.500,-', 72, 660, 12],
];
const beforeDoc = await makeDoc(subsetBytes, FIXTURE_LINES);
fs.writeFileSync(path.join(outDir, 'out-before.pdf'), await beforeDoc.save());

// ---------------------------------------------------------------------------
// 2) THE COMPOSITION PLANNER (spec §4 — prototyped inline)
// ---------------------------------------------------------------------------

// -- sfnt/glyf reader: composite component records for one gid.
// This is the "mark resolution ladder rung c" of the spec: when no codepoint
// reaches the mark, a cmapped precomposed glyph (é) is parsed as a DONOR —
// its component records carry both the mark's GID and the font designer's own
// placement offsets.
function makeGlyfReader(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numTables = dv.getUint16(4);
  const tables = {};
  for (let i = 0; i < numTables; i += 1) {
    const off = 12 + i * 16;
    const tag = String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
    tables[tag] = { offset: dv.getUint32(off + 8), length: dv.getUint32(off + 12) };
  }
  if (!tables.glyf || !tables.loca || !tables.head || !tables.maxp) return null; // CFF etc. — decline
  const indexToLocFormat = dv.getInt16(tables.head.offset + 50);
  const loca = (gid) => (indexToLocFormat === 0
    ? [dv.getUint16(tables.loca.offset + gid * 2) * 2, dv.getUint16(tables.loca.offset + (gid + 1) * 2) * 2]
    : [dv.getUint32(tables.loca.offset + gid * 4), dv.getUint32(tables.loca.offset + (gid + 1) * 4)]);
  return function componentsOf(gid) {
    const [start, end] = loca(gid);
    if (start === end) return null; // empty glyph
    const base = tables.glyf.offset + start;
    if (dv.getInt16(base) >= 0) return null; // simple glyph — no components
    const comps = [];
    let off = base + 10;
    let flags;
    do {
      flags = dv.getUint16(off);
      const glyphIndex = dv.getUint16(off + 2);
      off += 4;
      let dx = 0, dy = 0;
      const argsAreXY = !!(flags & 0x0002);
      if (flags & 0x0001) { dx = dv.getInt16(off); dy = dv.getInt16(off + 2); off += 4; }
      else { dx = dv.getInt8(off); dy = dv.getInt8(off + 1); off += 2; }
      let hasScale = false;
      if (flags & 0x0008) { hasScale = true; off += 2; }        // WE_HAVE_A_SCALE
      else if (flags & 0x0040) { hasScale = true; off += 4; }   // X_AND_Y_SCALE
      else if (flags & 0x0080) { hasScale = true; off += 8; }   // TWO_BY_TWO
      comps.push({ glyphIndex, dx, dy, argsAreXY, hasScale });
    } while (flags & 0x0020); // MORE_COMPONENTS
    return comps;
  };
}

// Above-marks v1 (spec §4 scope guard): NFD combining codepoint -> spacing
// clone for the cmap ladder. Below-marks/stacked marks decline, never guess.
const ABOVE_MARKS = new Map([
  [0x0301, 0x00b4], // acute
  [0x0300, 0x0060], // grave
  [0x0302, 0x02c6], // circumflex
  [0x0303, 0x02dc], // tilde
  [0x0308, 0x00a8], // diaeresis
  [0x0304, 0x00af], // macron
  [0x030c, 0x02c7], // caron
  [0x0306, 0x02d8], // breve
  [0x030a, 0x02da], // ring
]);

// Mark resolution ladder (spec §4 step 2): cmap combining -> cmap spacing
// clone -> glyf composite donor. Returns { gid, dx, dy, calibChar } (dx/dy =
// the donor composite's own placement, null when cmap-direct) or null.
function resolveMark(font, subsetSfnt, markCp) {
  for (const cp of [markCp, ABOVE_MARKS.get(markCp)]) {
    if (cp && font.hasGlyphForCodePoint(cp)) {
      return { gid: font.glyphForCodePoint(cp).id, dx: null, dy: null, calibChar: null };
    }
  }
  const componentsOf = makeGlyfReader(subsetSfnt);
  if (!componentsOf) return null;
  for (const cp of font.characterSet) {
    const s = String.fromCodePoint(cp).normalize('NFD');
    if (s.length < 2 || !s.includes(String.fromCodePoint(markCp))) continue;
    const baseCh = s[0];
    if (!font.hasGlyphForCodePoint(baseCh.codePointAt(0))) continue;
    const baseGid = font.glyphForCodePoint(baseCh.codePointAt(0)).id;
    const comps = componentsOf(font.glyphForCodePoint(cp).id);
    if (!comps) continue;
    const markComps = comps.filter((c) => {
      if (c.glyphIndex === baseGid || !c.argsAreXY || c.hasScale) return false;
      const b = font.getGlyph(c.glyphIndex).bbox;
      return b.maxX > b.minX && b.maxY > b.minY; // skip empty width-setter components
    });
    if (markComps.length !== 1) continue; // ambiguous — try another donor
    return { gid: markComps[0].glyphIndex, dx: markComps[0].dx, dy: markComps[0].dy, calibChar: baseCh };
  }
  return null;
}

const isUpper = (ch) => /\p{Lu}/u.test(ch);

// Plan ONE composed char (spec §4 steps 1-4). Returns null = decline.
function planComposedChar(font, subsetSfnt, ch) {
  const nfd = ch.normalize('NFD');
  if (nfd.length !== 2) return null;                        // single mark only (v1)
  const [baseCh, markCh] = [...nfd];
  const markCp = markCh.codePointAt(0);
  if (!ABOVE_MARKS.has(markCp)) return null;                // above-marks only (v1)
  if (!font.hasGlyphForCodePoint(baseCh.codePointAt(0))) return null;
  const base = font.glyphForCodePoint(baseCh.codePointAt(0));
  const mark = resolveMark(font, subsetSfnt, markCp);
  if (!mark) return null;
  const markGlyph = font.getGlyph(mark.gid);

  let dx, dy;
  if (mark.dx !== null) {
    // Donor-calibrated placement (spec §4 step 3). Horizontal: re-center on
    // the base's OUTLINE center — measured against Carlito's own real É
    // composite, bbox centering lands ~2x closer than advance centering.
    // Vertical: PRESERVE THE DONOR'S OPTICAL CLEARANCE GAP (mark bottom above
    // base top) — the quantity the designer actually chose; it transfers
    // exactly across x-height -> cap-height bases.
    const donorBase = font.glyphForCodePoint(mark.calibChar.codePointAt(0));
    dx = mark.dx + ((base.bbox.minX + base.bbox.maxX) / 2
      - (donorBase.bbox.minX + donorBase.bbox.maxX) / 2);
    const donorGap = (markGlyph.bbox.minY + mark.dy) - donorBase.bbox.maxY;
    dy = (base.bbox.maxY + donorGap) - markGlyph.bbox.minY;
  } else {
    // cmap-direct mark, no donor calibration: center the mark outline on the
    // base outline; raise a lowercase-positioned outline for an uppercase base.
    const mb = markGlyph.bbox;
    dx = (base.bbox.minX + base.bbox.maxX) / 2 - (mb.minX + mb.maxX) / 2;
    dy = isUpper(baseCh) && mb.minY < font.capHeight ? font.capHeight - font.xHeight : 0;
  }

  // Collision guard (spec §4 step 4): the raised mark must clear the base's
  // outline — a font whose geometry breaks the model declines, never smudges.
  if (markGlyph.bbox.minY + dy <= base.bbox.maxY) return null;

  return { baseGid: base.id, baseAdvance: base.advanceWidth, markGid: mark.gid, dx, dy };
}

// ---------------------------------------------------------------------------
// 3) EMIT (spec §4 step 5) — covered chars ride a normal TJ run; each composed
//    char adds ONE absolutely-positioned mark block. Width = base advances, so
//    the cut/insert geometry contract holds.
// ---------------------------------------------------------------------------
function fmtNum(n) {
  let v = Math.round(n * 10000) / 10000;
  if (Object.is(v, -0)) v = 0;
  let s = String(v);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

function planComposedInsert(font, subsetSfnt, insert, text, colorRgb) {
  const upm = font.unitsPerEm;
  const marks = [];
  let hexRun = '';
  let advUnits = 0;
  for (const ch of text) {
    if (ch === ' ') {
      // same space-as-kern reality as planNativeInsert; 0.28em fallback
      const sp = font.hasGlyphForCodePoint(32) ? font.glyphForCodePoint(32).advanceWidth : 0.28 * upm;
      hexRun = hexRun ? hexRun + `> ${fmtNum(-Math.round((sp / upm) * 1000))} <` : hexRun;
      advUnits += sp;
      continue;
    }
    if (font.hasGlyphForCodePoint(ch.codePointAt(0))) {
      const g = font.glyphForCodePoint(ch.codePointAt(0));
      hexRun += g.id.toString(16).padStart(4, '0');
      advUnits += g.advanceWidth;
      continue;
    }
    const plan = planComposedChar(font, subsetSfnt, ch);
    if (!plan) return { ok: false, reason: 'not-composable', char: ch };
    hexRun += plan.baseGid.toString(16).padStart(4, '0');
    marks.push({ gid: plan.markGid, atUnits: advUnits + plan.dx, riseUnits: plan.dy });
    advUnits += plan.baseAdvance;
  }

  const s = insert.size;
  const [r, g, b] = colorRgb;
  const a = fmtNum(s * insert.ux), bC = fmtNum(s * insert.uy);
  const c = fmtNum(-s * insert.uy), d = fmtNum(s * insert.ux);
  const blocks = [];
  blocks.push(`q BT /${insert.fontResourceName} 1 Tf ${fmtNum(r)} ${fmtNum(g)} ${fmtNum(b)} rg `
    + `${a} ${bC} ${c} ${d} ${fmtNum(insert.x)} ${fmtNum(insert.y)} Tm [<${hexRun}>] TJ ET Q`);
  for (const m of marks) {
    // absolute position: origin + baseline-dir * atUnits + normal-dir * rise
    const t = (m.atUnits / upm) * s;
    const nr = (m.riseUnits / upm) * s;
    const mx = insert.x + insert.ux * t - insert.uy * nr;
    const my = insert.y + insert.uy * t + insert.ux * nr;
    blocks.push(`q BT /${insert.fontResourceName} 1 Tf ${fmtNum(r)} ${fmtNum(g)} ${fmtNum(b)} rg `
      + `${a} ${bC} ${c} ${d} ${fmtNum(mx)} ${fmtNum(my)} Tm [<${m.gid.toString(16).padStart(4, '0')}>] TJ ET Q`);
  }
  return { ok: true, snippet: blocks.join(' '), width: (advUnits / upm) * s, composedCount: marks.length };
}

// ---------------------------------------------------------------------------
// 4) RUN — compose 'KAFÉ ANDRÉA' onto the fixture, plus the full-font truth
// ---------------------------------------------------------------------------
const composedDoc = await PDFLib.PDFDocument.load(await beforeDoc.save());
const page = composedDoc.getPages()[0];

const { PDFName, PDFRef } = PDFLib;
const ctx = page.doc.context;
const res = (v) => (v instanceof PDFRef ? ctx.lookup(v) : v);
const fontDict = res(page.node.Resources().get(PDFName.of('Font')));
const fontResourceName = fontDict.keys()[0].toString().replace(/^\//, '');

const extracted = extractFontProgram(page, PDFLib, fontResourceName);
if (!extracted.ok) throw new Error('extract failed: ' + extracted.reason);
const font = fontkit.create(extracted.bytes);
if (font.hasGlyphForCodePoint(0xc9)) throw new Error('fixture invalid: É unexpectedly covered');

const TARGET = 'KAFÉ ANDRÉA';
const insert = { x: 72, y: 560, ux: 1, uy: 0, size: 28, fontResourceName };
const plan = planComposedInsert(font, extracted.bytes, insert, TARGET, [0.1, 0.1, 0.12]);
if (!plan.ok) throw new Error(`composition declined: ${plan.reason} for "${plan.char}"`);
console.log(`composed insert: ${plan.composedCount} composed glyph(s), width ${plan.width.toFixed(1)}pt`);
appendNativeText(page, PDFLib, plan.snippet);
fs.writeFileSync(path.join(outDir, 'out-composed.pdf'), await composedDoc.save());

const fullWoff2 = new Uint8Array(fs.readFileSync(path.join(root, 'fonts/carlito-regular.woff2')));
const refDoc = await makeDoc(fullWoff2, [...FIXTURE_LINES, [TARGET, 72, 560, 28]]);
fs.writeFileSync(path.join(outDir, 'out-reference.pdf'), await refDoc.save());
console.log(`wrote out-before.pdf / out-composed.pdf / out-reference.pdf to ${outDir}`);
console.log('NOTE: out-reference.pdf embeds woff2 bytes (renders via fontkit-based tooling,');
console.log('not strict viewers) — the before/composed pair embeds a real sfnt and renders anywhere.');
