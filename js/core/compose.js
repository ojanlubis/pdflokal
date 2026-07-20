/*
 * PDFLokal — core/compose.js  (FONT-FIDELITY tier 2 — glyph COMPOSITION)
 * ============================================================================
 * WHY this module exists (spec-font-fidelity-engine.md §4, founder-ratified
 * 2026-07-20): planNativeInsert declines 'missing-glyph' the moment ONE char
 * of the replacement isn't in the embedded subset — and the whole edit falls
 * back to a substitute font. But many "missing" glyphs are Latin base+accent
 * combinations whose PARTS the subset already carries: a document containing
 * é carries the acute outline (composite glyphs pull their components into
 * every real subsetter's output) even when no codepoint reaches it. The
 * Identity-H writer addresses glyphs by GID, so those orphan outlines are
 * paintable: É = base-E in the main run + the subset's own acute painted as
 * one extra absolutely-positioned show op. The document's own font stays on
 * the page — zero font mutation, zero substitution, zero guessing.
 *
 * Placement is NOT invented: the ladder below prefers the font's OWN
 * calibration, stolen from a donor composite (é says exactly where this font
 * puts an acute), re-centered on the new base's outline and keeping the
 * donor's optical clearance gap. Measured against full Carlito's real É
 * composite (the designer's own answer), this lands within ~30/2048 em
 * (~0.2pt at 12pt) — the irreducible remainder is that full fonts may carry
 * a dedicated flattened uppercase accent variant the subset simply lacks.
 *
 * HONESTY CONTRACT (same law as reinsert.js): every path either PROVES its
 * plan from bytes actually present in the file, or declines with a typed
 * reason — the caller falls back to the substitute tier exactly as today.
 * A composed glyph ships SILENT (founder ruling 2026-07-20): the pixels are
 * the document's own outlines; there is no substitution to disclose.
 *
 * v1 SCOPE (each exclusion is a distinct reason, mirrored into telemetry
 * when the rail lands): Type0/Identity-H callers only (the caller gates —
 * see page-surgery.js; simple-TrueType writes bytes, not GIDs, and real Word
 * subsets don't cmap unused marks); single ABOVE-mark diacritics only;
 * unscaled components only; glyf donors only (CFF declines; rungs a/b still
 * work on any shape fontkit parses).
 *
 * Same vendor-injection discipline as reinsert.js: fontkit objects are
 * passed in; this file has zero vendor imports.
 */

import { fmtNum, hexToRgb01, escapeNameForWrite } from './reinsert.js';

// NFD combining mark -> spacing clone, for the cmap ladder's rung b. ONLY
// above-marks: below-marks (cedilla, ogonek, dot-below) attach differently
// and decline — never guess an attachment model the font didn't prove.
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

const isUpper = (ch) => /\p{Lu}/u.test(ch);

// ---- sfnt/glyf reader ---------------------------------------------------------

// Composite component records for one gid, read straight from the raw sfnt
// (OpenType glyf spec). fontkit exposes outlines but NOT component records —
// and the component record is the whole prize here: it carries the mark's
// GID *and* the font designer's own placement of that mark over a base.
// Returns a componentsOf(gid) reader, or null when the program isn't a raw
// sfnt with a glyf table (WOFF2-wrapped fixtures, CFF) — rung c is then
// simply unavailable; rungs a/b still work through fontkit.
function makeGlyfReader(bytes) {
  if (bytes.length < 12) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // sfnt magic: 0x00010000 (TrueType) — anything else (wOF2, OTTO/CFF, ttcf)
  // has no directly-addressable glyf table for this reader.
  if (dv.getUint32(0) !== 0x00010000) return null;
  const numTables = dv.getUint16(4);
  const tables = {};
  for (let i = 0; i < numTables; i += 1) {
    const off = 12 + i * 16;
    const tag = String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
    tables[tag] = { offset: dv.getUint32(off + 8), length: dv.getUint32(off + 12) };
  }
  if (!tables.glyf || !tables.loca || !tables.head) return null;
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
      if (flags & 0x0001) { dx = dv.getInt16(off); dy = dv.getInt16(off + 2); off += 4; } // ARG_1_AND_2_ARE_WORDS
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

// ---- mark resolution ladder -----------------------------------------------------

// Find the mark outline for `markCp` in the subset. First hit wins:
//   a. cmap has the combining mark itself           -> gid (bbox placement)
//   b. cmap has the spacing clone (´ ` ˆ ˜ ¨ ¯ …)   -> gid (bbox placement)
//   c. glyf composite donor parse: a cmapped precomposed glyph whose NFD
//      carries this mark (é for acute) is parsed; its non-base, non-empty
//      component IS the mark — with the FONT'S OWN calibrated offsets.
// Returns { gid, dx, dy, calibChar } (dx/dy null when cmap-direct) or null.
function resolveMark(font, subsetBytes, markCp) {
  for (const cp of [markCp, ABOVE_MARKS.get(markCp)]) {
    if (cp && font.hasGlyphForCodePoint(cp)) {
      return { gid: font.glyphForCodePoint(cp).id, dx: null, dy: null, calibChar: null };
    }
  }
  const componentsOf = makeGlyfReader(subsetBytes);
  if (!componentsOf) return null;
  for (const cp of font.characterSet) {
    const s = String.fromCodePoint(cp).normalize('NFD');
    if (s.length < 2 || !s.includes(String.fromCodePoint(markCp))) continue;
    const baseCh = s[0];
    if (!font.hasGlyphForCodePoint(baseCh.codePointAt(0))) continue;
    const baseGid = font.glyphForCodePoint(baseCh.codePointAt(0)).id;
    let comps;
    try { comps = componentsOf(font.glyphForCodePoint(cp).id); } catch { continue; }
    if (!comps) continue;
    const markComps = comps.filter((c) => {
      if (c.glyphIndex === baseGid || !c.argsAreXY || c.hasScale) return false;
      const b = font.getGlyph(c.glyphIndex).bbox;
      return b.maxX > b.minX && b.maxY > b.minY; // skip empty width-setter components
    });
    if (markComps.length !== 1) continue; // ambiguous donor — try another
    return { gid: markComps[0].glyphIndex, dx: markComps[0].dx, dy: markComps[0].dy, calibChar: baseCh };
  }
  return null;
}

// ---- per-char plan --------------------------------------------------------------

// Plan the composition of ONE char missing from the subset. Returns
// { ok:true, baseGid, baseAdvance, markGid, markCp, dx, dy } (font units) or
// { ok:false, reason } — the same decline-shape discipline as reinsert.js.
// EXPORTED for the commit-time coverage check in js/v2/app.js: the toast must
// follow the DECISION (covered-or-composable), or it lies downward about an
// edit export will in fact paint in the document's own font.
export function planComposedChar(font, subsetBytes, ch) {
  const parts = [...ch.normalize('NFD')]; // code points, not UTF-16 units
  if (parts.length === 1) return { ok: false, reason: 'compose-not-decomposable' };
  if (parts.length !== 2) return { ok: false, reason: 'compose-multi-mark' };
  const [baseCh, markCh] = parts;
  const markCp = markCh.codePointAt(0);
  if (!ABOVE_MARKS.has(markCp)) return { ok: false, reason: 'compose-below-mark' };
  if (!font.hasGlyphForCodePoint(baseCh.codePointAt(0))) return { ok: false, reason: 'compose-base-missing' };
  const base = font.glyphForCodePoint(baseCh.codePointAt(0));
  const mark = resolveMark(font, subsetBytes, markCp);
  if (!mark) return { ok: false, reason: 'compose-mark-missing' };
  const markGlyph = font.getGlyph(mark.gid);

  let dx, dy;
  if (mark.dx !== null) {
    // Donor-calibrated placement. Horizontal: keep the donor offset,
    // re-centered on the base's OUTLINE center (measured against Carlito's
    // own real É composite: ~2x closer to the designer's placement than
    // advance-centering). Vertical: PRESERVE THE DONOR'S OPTICAL CLEARANCE
    // GAP — mark-bottom above base-top is the quantity the designer chose,
    // and it transfers exactly across x-height -> cap-height bases.
    const donorBase = font.glyphForCodePoint(mark.calibChar.codePointAt(0));
    dx = mark.dx + ((base.bbox.minX + base.bbox.maxX) / 2
      - (donorBase.bbox.minX + donorBase.bbox.maxX) / 2);
    const donorGap = (markGlyph.bbox.minY + mark.dy) - donorBase.bbox.maxY;
    dy = (base.bbox.maxY + donorGap) - markGlyph.bbox.minY;
  } else {
    // cmap-direct mark (rungs a/b), no donor calibration: center the mark
    // outline on the base outline; an outline sitting in the x-height zone
    // is raised by the cap/x-height delta for an uppercase base.
    const mb = markGlyph.bbox;
    dx = (base.bbox.minX + base.bbox.maxX) / 2 - (mb.minX + mb.maxX) / 2;
    dy = isUpper(baseCh) && mb.minY < font.capHeight ? font.capHeight - font.xHeight : 0;
  }

  // Collision guard: the placed mark must clear the base's outline — a font
  // whose geometry breaks this model declines, never smudges.
  if (markGlyph.bbox.minY + dy <= base.bbox.maxY) return { ok: false, reason: 'compose-collision' };

  return { ok: true, baseGid: base.id, baseAdvance: base.advanceWidth, markGid: mark.gid, markCp, dx, dy };
}

// ---- the full insert plan --------------------------------------------------------

// The composed sibling of planNativeInsert's Type0 body: covered chars ride a
// normal hex TJ run (spaces as kerns, same subset reality and 0.28em fallback
// as v1); each uncovered-but-composable char contributes its BASE glyph to
// that run (advance = base advance — typographically right for Latin marks)
// plus ONE absolutely-positioned mark block. Same snippet/width contract as
// planNativeInsert, plus `marks` [{gid, codepoint}] for the ToUnicode patch.
//
// The CALLER gates the font shape (Type0/Identity-H — see page-surgery.js):
// this planner writes GIDs and must never be handed a byte-keyed simple font.
export function planComposedInsert(font, subsetBytes, insert, text, color) {
  const upm = font.unitsPerEm;
  const spaceAdvance = font.hasGlyphForCodePoint(32)
    ? font.glyphForCodePoint(32).advanceWidth
    : 0.28 * upm;

  const marks = [];
  const tjParts = [];
  let hexRun = '';
  let widthUnits = 0;
  let composedCount = 0;
  const flushHex = () => {
    if (hexRun) { tjParts.push(`<${hexRun}>`); hexRun = ''; }
  };
  // NFC first: a user who typed e + combining-acute means é — judge coverage
  // and composition on the composed form, one char at a time.
  for (const ch of text.normalize('NFC')) {
    if (ch === ' ') {
      flushHex();
      tjParts.push(String(-Math.round((spaceAdvance / upm) * 1000)));
      widthUnits += spaceAdvance;
      continue;
    }
    if (font.hasGlyphForCodePoint(ch.codePointAt(0))) {
      const g = font.glyphForCodePoint(ch.codePointAt(0));
      hexRun += g.id.toString(16).padStart(4, '0');
      widthUnits += g.advanceWidth;
      continue;
    }
    const plan = planComposedChar(font, subsetBytes, ch);
    if (!plan.ok) return plan; // typed decline bubbles out unchanged
    hexRun += plan.baseGid.toString(16).padStart(4, '0');
    marks.push({
      gid: plan.markGid,
      codepoint: plan.markCp,
      atUnits: widthUnits + plan.dx,
      riseUnits: plan.dy,
    });
    widthUnits += plan.baseAdvance;
    composedCount += 1;
  }
  flushHex();
  if (composedCount === 0) return { ok: false, reason: 'compose-nothing-to-compose' };

  const escapedName = escapeNameForWrite(insert.fontName);
  if (escapedName === null) return { ok: false, reason: 'font-name-unwritable' };

  const s = insert.size;
  const [r, g, b] = hexToRgb01(color);
  // Same rendering-matrix reproduction as planNativeInsert: Tf fixed at 1,
  // size folded into Tm, direction from the walk's (ux, uy).
  const a = fmtNum(s * insert.ux);
  const bC = fmtNum(s * insert.uy);
  const c = fmtNum(-s * insert.uy);
  const d = fmtNum(s * insert.ux);

  const blocks = [];
  blocks.push(`q BT /${escapedName} 1 Tf ${fmtNum(r)} ${fmtNum(g)} ${fmtNum(b)} rg `
    + `${a} ${bC} ${c} ${d} ${fmtNum(insert.x)} ${fmtNum(insert.y)} Tm [${tjParts.join(' ')}] TJ ET Q`);
  for (const m of marks) {
    // Absolute mark position: origin + baseline-direction × horizontal
    // travel + baseline-normal × rise — the same rotated-frame math the main
    // block's Tm already encodes, applied to the translation only.
    const t = (m.atUnits / upm) * s;
    const nr = (m.riseUnits / upm) * s;
    const mx = insert.x + insert.ux * t - insert.uy * nr;
    const my = insert.y + insert.uy * t + insert.ux * nr;
    blocks.push(`q BT /${escapedName} 1 Tf ${fmtNum(r)} ${fmtNum(g)} ${fmtNum(b)} rg `
      + `${a} ${bC} ${c} ${d} ${fmtNum(mx)} ${fmtNum(my)} Tm [<${m.gid.toString(16).padStart(4, '0')}>] TJ ET Q`);
  }

  return {
    ok: true,
    snippet: blocks.join(' '),
    width: (widthUnits / upm) * s,
    marks: marks.map((m) => ({ gid: m.gid, codepoint: m.codepoint })),
  };
}

// ---- ToUnicode honesty patch ------------------------------------------------------

// A composed glyph's mark GID usually has no ToUnicode entry (nothing mapped
// it — that's exactly why it needed composing). Without a patch, extraction
// reads the base letter alone ("E" for É). Appending a bfchar per mark GID
// makes extraction yield base + combining mark — NFD, canonically equivalent
// to the char the user typed. The file must not lie to text extraction.
//
// Bounded by design: only runs when the font already HAS a /ToUnicode stream
// (a file without one was never extractable — composing doesn't make that
// worse, and inventing a whole CMap is out of scope); idempotent per GID
// (re-running for a second edit on the same font skips existing entries);
// any parse surprise returns false and the composed paint still ships — the
// patch is an honesty upgrade, never a gate.
export function patchToUnicodeForMarks(page, PDFLib, fontName, marks) {
  try {
    const { PDFName, PDFRef, PDFDict, PDFRawStream, decodePDFRawStream } = PDFLib;
    const context = page.doc.context;
    const res = (v) => (v instanceof PDFRef ? context.lookup(v) : v);

    const resources = page.node.Resources();
    if (!resources) return false;
    const fontDict = res(resources.get(PDFName.of('Font')));
    if (!(fontDict instanceof PDFDict)) return false;
    const fontObj = res(fontDict.get(PDFName.of(fontName)));
    if (!fontObj) return false;

    const tuRef = fontObj.get(PDFName.of('ToUnicode'));
    if (!tuRef) return false;
    const tuStream = res(tuRef);
    if (!(tuStream instanceof PDFRawStream)) return false;

    let cmap = '';
    for (const byte of decodePDFRawStream(tuStream).decode()) cmap += String.fromCharCode(byte);
    const endIdx = cmap.lastIndexOf('endcmap');
    if (endIdx === -1) return false;

    const entries = marks
      .map((m) => ({
        src: m.gid.toString(16).padStart(4, '0'),
        dst: m.codepoint.toString(16).padStart(4, '0'),
      }))
      // idempotence: a GID already mapped (by the file or a prior patch) is
      // left alone — never rewrite an existing claim
      .filter((e) => !cmap.includes(`<${e.src}>`));
    if (entries.length === 0) return true;

    const block = `${entries.length} beginbfchar\n`
      + entries.map((e) => `<${e.src}> <${e.dst}>`).join('\n')
      + '\nendbfchar\n';
    const patched = cmap.slice(0, endIdx) + block + cmap.slice(endIdx);

    const bytesOf = Uint8Array.from(patched, (chr) => chr.charCodeAt(0));
    const newStream = context.flateStream(bytesOf);
    // ToUnicode is referenced BY REF from the font dict — assigning the new
    // stream to the same ref updates every reader without touching the dict.
    if (tuRef instanceof PDFRef) context.assign(tuRef, newStream);
    else fontObj.set(PDFName.of('ToUnicode'), context.register(newStream));
    return true;
  } catch (err) {
    console.warn('[core/compose] ToUnicode patch skipped:', err);
    return false;
  }
}
