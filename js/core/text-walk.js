/*
 * PDFLokal — core/text-walk.js  (RUNG B production — position-matched removal)
 * ============================================================================
 * String-match removal (content-stream.js's removeShowOps) breaks the moment
 * a subset/CID font is involved: the show-text string holds glyph ids, not
 * ASCII, so matching against user-visible text is impossible. This module
 * walks the content-stream interpreter state (CTM, text matrix, font/size)
 * so we know WHERE every show op paints in user space, then matches ops to a
 * target run's GEOMETRY instead of its text. That's the only removal path
 * that works regardless of font encoding.
 *
 * HEADLESS on purpose (no DOM, no vendor imports) — tested in tests/core/
 * under `node --test`, same as content-stream.js.
 *
 * Caller-provided FontMetrics: { bytesPerCode: 1|2, widths: Map<number,number>|null,
 * defaultWidth: number }. widths === null means "unknown font" — any op using
 * that font gets advanceText = null, which poisons position-tracking (posValid)
 * until the next explicit positioning op (Td, TD, Tm, T-star, or BT) restores it. That's
 * the safety net: we'd rather stop trusting positions than guess wrong.
 */

import { tokenizeOps } from './content-stream.js';

// Matrices are [a,b,c,d,e,f]; point map (x,y) -> (a*x+c*y+e, b*x+d*y+f).
// mul(A, B) = "apply A, then B" (A's row-vector composed into B's space).
function mul(A, B) {
  return [
    A[0] * B[0] + A[1] * B[2],
    A[0] * B[1] + A[1] * B[3],
    A[2] * B[0] + A[3] * B[2],
    A[2] * B[1] + A[3] * B[3],
    A[4] * B[0] + A[5] * B[2] + B[4],
    A[4] * B[1] + A[5] * B[3] + B[5],
  ];
}

const translate = (tx, ty) => [1, 0, 0, 1, tx, ty];

function normalize(x, y) {
  const len = Math.hypot(x, y);
  return len === 0 ? [1, 0] : [x / len, y / len];
}

// Split a decoded (binary-safe, one-char-per-byte) string into glyph codes.
// bytesPerCode 2: byte pairs big-endian; a trailing odd byte is shifted high
// (PDF CID strings are always even-length in practice, but stay defensive).
function codesForString(str, bytesPerCode) {
  const codes = [];
  if (bytesPerCode === 2) {
    for (let i = 0; i < str.length; i += 2) {
      const b1 = str.charCodeAt(i);
      const b2 = i + 1 < str.length ? str.charCodeAt(i + 1) : undefined;
      codes.push(b2 === undefined ? (b1 << 8) : (b1 * 256 + b2));
    }
  } else {
    for (let i = 0; i < str.length; i += 1) codes.push(str.charCodeAt(i));
  }
  return codes;
}

// Text-space advance for one decoded string operand under the CURRENT text
// state (widths in glyph-space thousandths — the /1000 is the PDF spec unit).
// Word spacing (Tw) applies only to single-byte code 32 (PDF 32000 9.3.3).
function stringAdvance(str, font, fontSize, Tc, Tw, Th) {
  let sum = 0;
  for (const code of codesForString(str, font.bytesPerCode)) {
    const w = font.widths.get(code) ?? font.defaultWidth;
    const wordSpace = code === 32 && font.bytesPerCode === 1 ? Tw : 0;
    sum += ((w / 1000) * fontSize + Tc + wordSpace) * Th;
  }
  return sum;
}

// advanceText for a show op's "content" tokens (i.e. excluding TJ's [ ] and,
// for ", the leading aw/ac numbers which are state-setters, not kerns — see
// the deviation note in the module report re: the " op's num tokens).
function computeAdvance(showTokens, font, fontSize, Tc, Tw, Th) {
  if (!font || font.widths === null) return null;
  let sum = 0;
  for (const tok of showTokens) {
    if (tok.t === 'str') sum += stringAdvance(tok.v, font, fontSize, Tc, Tw, Th);
    else if (tok.t === 'num') sum += (-tok.v / 1000) * fontSize * Th; // TJ kern
  }
  return sum;
}

// Walk a content stream's interpreter state and return one record per
// show-text op: where it paints (x,y), its baseline direction (ux,uy), its
// rendered size, and whether that position is currently trustworthy (exact).
export function walkShowOps(src, fonts) {
  const ops = tokenizeOps(src);
  const records = [];

  let CTM = [1, 0, 0, 1, 0, 0];
  let Tc = 0; let Tw = 0; let Th = 1; let TL = 0; let Ts = 0;
  let fontName = null; let fontSize = 0;
  let Tm = [1, 0, 0, 1, 0, 0];
  let Tlm = [1, 0, 0, 1, 0, 0];
  let posValid = false; // becomes true once BT/Td/TD/Tm/T* gives us a known Tlm
  let btIndex = -1;
  const stack = []; // q/Q — graphics state INCLUDING text params, but not Tm/Tlm

  const nums = (rec) => rec.tokens.filter((t) => t.t === 'num').map((t) => t.v);

  // Td tx ty: Tlm = translate(tx,ty) . Tlm; Tm = Tlm. Shared by Td/TD/T*/'/".
  const doTd = (tx, ty) => {
    Tlm = mul(translate(tx, ty), Tlm);
    Tm = Tlm.slice();
    posValid = true;
  };

  for (const rec of ops) {
    switch (rec.op) {
      case 'q':
        stack.push({ CTM: CTM.slice(), Tc, Tw, Th, TL, Ts, fontName, fontSize });
        break;
      case 'Q': {
        const saved = stack.pop(); // ignore underflow — malformed stream, not our job to fix
        if (saved) ({ CTM, Tc, Tw, Th, TL, Ts, fontName, fontSize } = saved);
        break;
      }
      case 'cm': {
        const [a, b, c, d, e, f] = nums(rec);
        CTM = mul([a, b, c, d, e, f], CTM);
        break;
      }
      case 'BT':
        Tm = [1, 0, 0, 1, 0, 0];
        Tlm = [1, 0, 0, 1, 0, 0];
        btIndex += 1;
        posValid = true;
        break;
      case 'ET':
        break; // nothing else — Tm/Tlm just go unused until the next BT
      case 'Tf': {
        const nameTok = rec.tokens.find((t) => t.t === 'name');
        const sizeTok = rec.tokens.find((t) => t.t === 'num');
        if (nameTok) fontName = nameTok.v;
        if (sizeTok) fontSize = sizeTok.v;
        break;
      }
      case 'Td': {
        const [tx, ty] = nums(rec);
        doTd(tx, ty);
        break;
      }
      case 'TD': {
        const [tx, ty] = nums(rec);
        TL = -ty;
        doTd(tx, ty);
        break;
      }
      case 'Tm': {
        const [a, b, c, d, e, f] = nums(rec);
        Tm = [a, b, c, d, e, f];
        Tlm = Tm.slice();
        posValid = true;
        break;
      }
      case 'T*':
        doTd(0, -TL);
        break;
      case 'TL': [TL] = nums(rec); break;
      case 'Tc': [Tc] = nums(rec); break;
      case 'Tw': [Tw] = nums(rec); break;
      case 'Tz': { const [v] = nums(rec); Th = v / 100; break; }
      case 'Ts': [Ts] = nums(rec); break;
      case 'Tj':
      case "'":
      case '"':
      case 'TJ': {
        if (rec.op === "'") doTd(0, -TL); // ' does T* FIRST, then shows
        if (rec.op === '"') {             // " sets Tw/Tc, THEN T*, then shows
          const n = nums(rec);
          [Tw, Tc] = n;
          doTd(0, -TL);
        }

        const exact = posValid;
        // This mirrors what pdf.js reports as item.transform for the glyph.
        const full = mul(mul([fontSize * Th, 0, 0, fontSize, 0, Ts], Tm), CTM);
        const [ux, uy] = normalize(full[0], full[1]);
        const size = Math.hypot(full[2], full[3]);

        let showTokens;
        if (rec.op === 'TJ') showTokens = rec.tokens.filter((t) => t.t === 'str' || t.t === 'num');
        else if (rec.op === '"') showTokens = [rec.tokens[2]]; // tokens[0..1] are aw/ac, not content
        else showTokens = [rec.tokens[0]];
        // A malformed stream can leave a show op with no operand — an export
        // must degrade (advance unknown), never throw.
        showTokens = showTokens.filter(Boolean);

        const font = fonts.get(fontName);
        const advanceText = computeAdvance(showTokens, font, fontSize, Tc, Tw, Th);

        records.push({
          op: rec.op, start: rec.start, end: rec.end, tokens: rec.tokens,
          x: full[4], y: full[5], ux, uy, size,
          exact, advanceText, th: Th, fontSize, btIndex,
          // The RESOURCE font name (the Tf operand) — Rung C's re-insert needs
          // it to write replacement text with the document's OWN font; pdf.js
          // only ever exposes its internal id, so the walk is the one place
          // this name is knowable.
          fontName,
        });

        if (advanceText === null) posValid = false; // can't prove where the NEXT op sits
        else Tm = mul(translate(advanceText, 0), Tm); // posValid unchanged (stays false if already lost)
        break;
      }
      default:
        break; // Do, BI, and unknown ops: no state change (BI...EI already raw-skipped)
    }
  }
  return records;
}

// Build the positioning-only replacement for a removed show op — an empty
// string is fine (nothing downstream depends on this op's absence), but when
// we know the advance it caused, we replace with a same-advance `[n] TJ` so
// ops after this one in the same text object don't shift left. ' and " also
// carry a line-step (T*) and, for ", a Tw/Tc side effect — those must survive
// even when the advance itself is unknown, since ' and " ALWAYS step the line.
function replacementFor(rec) {
  const parts = [];
  if (rec.op === "'") {
    parts.push('T*');
  } else if (rec.op === '"') {
    const [aw, ac] = rec.tokens.filter((t) => t.t === 'num').map((t) => t.v);
    parts.push(`${aw} Tw ${ac} Tc T*`);
  }
  if (rec.advanceText !== null && rec.fontSize > 0 && rec.th > 0) {
    let n = -(rec.advanceText * 1000) / (rec.fontSize * rec.th);
    n = Math.round(n * 10000) / 10000; // 4 decimals
    let nStr = String(n);
    if (nStr.includes('.')) nStr = nStr.replace(/0+$/, '').replace(/\.$/, ''); // strip trailing zeros
    parts.push(`[${nStr}] TJ`);
  }
  return parts.join(' ');
}

// Walk once, match show ops to target run geometries, and splice out the
// matched ops (replaced, not deleted — see replacementFor). Returns
// { content, removed, results } where results[i] = { matched, ops } per
// target; content === src when nothing was removed.
export function planRunRemoval(src, fonts, targets) {
  const records = walkShowOps(src, fonts);

  // First matching target wins per record — only exact (trustworthy) records
  // are eligible; a record inside an untrustworthy run can't be matched at all.
  const matchesByTarget = targets.map(() => []);
  for (const rec of records) {
    if (!rec.exact) continue;
    for (let ti = 0; ti < targets.length; ti += 1) {
      const t = targets[ti];
      const vx = rec.x - t.x0;
      const vy = rec.y - t.y0;
      const along = vx * t.ux + vy * t.uy;
      const perp = Math.abs(vx * t.uy - vy * t.ux);
      const alongOk = along >= -0.35 * t.size && along <= t.len - Math.min(1, t.size * 0.1);
      const sizeOk = rec.size >= 0.55 * t.size && rec.size <= 1.8 * t.size;
      if (perp <= 0.4 * t.size && alongOk && sizeOk) {
        matchesByTarget[ti].push(rec);
        break;
      }
    }
  }

  // DECLINE rule: any target whose matches include a record from a text
  // object (btIndex) that ALSO contains an exact:false record can't be
  // trusted — an unknown-advance op in that object means we can't prove
  // what else sits where. Decline the whole target rather than risk it.
  const badBts = new Set();
  for (const rec of records) if (!rec.exact) badBts.add(rec.btIndex);

  const results = targets.map(() => ({ matched: false, ops: 0 }));
  const cuts = [];
  for (let ti = 0; ti < targets.length; ti += 1) {
    const matches = matchesByTarget[ti];
    if (matches.length === 0) continue;
    if (matches.some((r) => badBts.has(r.btIndex))) continue; // declined
    // `insert` describes where/how the REMOVED text was painted — everything
    // Rung C's native re-insert needs to put replacement text back with the
    // document's own font: the resource font name + size of the first cut op,
    // and its exact painted origin/direction/rendered size. Single-font per
    // target is the honest claim (a mixed-font line reports its FIRST op's
    // font; the coverage check downstream decides whether that's usable).
    const first = matches.reduce((a, b) => (a.start <= b.start ? a : b));
    results[ti] = {
      matched: true,
      ops: matches.length,
      insert: {
        fontName: first.fontName, fontSize: first.fontSize,
        x: first.x, y: first.y, ux: first.ux, uy: first.uy, size: first.size,
        mixedFonts: matches.some((r) => r.fontName !== first.fontName),
      },
    };
    cuts.push(...matches);
  }

  if (cuts.length === 0) return { content: src, removed: 0, results };

  cuts.sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  for (const rec of cuts) {
    out += src.slice(pos, rec.start);
    out += replacementFor(rec);
    pos = rec.end;
  }
  out += src.slice(pos);
  return { content: out, removed: cuts.length, results };
}
