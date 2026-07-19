/*
 * PDFLokal — core/content-stream.js  (RUNG B LAB — content-stream surgery)
 * ============================================================================
 * A minimal PDF content-stream tokenizer + show-text-op remover. This is the
 * seed of Edit Teks Asli Rung B (true removal): strip the operators that PAINT
 * a text run, so covered text is GONE from the file, not hidden under a
 * rectangle (the honest-redaction upgrade — see the seat's spec).
 *
 * HEADLESS on purpose (no DOM, no vendor libs) — tested in tests/core/ under
 * `node --test`, the same litmus every core module passes.
 *
 * LAB SCOPE (2026-07-19 night run): string-match removal works for simple
 * fonts whose strings decode ASCII-ish (StandardFonts — our fixtures, and a
 * large share of Word-born documents). Subset/CID fonts encode glyph ids, not
 * ASCII — those need position-matched removal (the interpreter walk), which is
 * the real Rung B build. The tokenizer below already yields everything that
 * walk needs (ordered ops with operands + byte offsets).
 */

// Show-text operators. ' and " also advance to the next line — removing them
// removes that advance too (acceptable at lab stage; the interpreter walk
// will preserve positioning by replacing, not deleting, when it matters).
const SHOW_OPS = new Set(['Tj', 'TJ', "'", '"']);

// Decode a PDF literal string body ((...) content, escapes handled).
export function decodeLiteralString(body) {
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (c !== '\\') { out += c; continue; }
    const n = body[i + 1];
    if (n === undefined) break;
    if (n === 'n') { out += '\n'; i += 1; } else if (n === 'r') { out += '\r'; i += 1; } else if (n === 't') { out += '\t'; i += 1; } else if (n === 'b') { out += '\b'; i += 1; } else if (n === 'f') { out += '\f'; i += 1; } else if (n >= '0' && n <= '7') {
      let oct = '';
      for (let k = 1; k <= 3 && body[i + k] >= '0' && body[i + k] <= '7'; k += 1) oct += body[i + k];
      out += String.fromCharCode(parseInt(oct, 8));
      i += oct.length;
    } else { out += n; i += 1; } // \\, \(, \), and line continuations
  }
  return out;
}

function decodeHexString(body) {
  const hex = body.replace(/[^0-9a-fA-F]/g, '');
  let out = '';
  for (let i = 0; i + 1 < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  if (hex.length % 2 === 1) out += String.fromCharCode(parseInt(hex[hex.length - 1] + '0', 16));
  return out;
}

// Decode a PDF name token's body (the part after the leading '/'): #xx hex
// escapes stand for a raw byte (e.g. a space in a font subset name).
function decodeName(body) {
  return body.replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

const isWS = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0';
const isDelim = (c) => '()<>[]{}/%'.includes(c);

// Tokenize a content stream string into ordered OP RECORDS:
//   { op, start, end, strings, tokens }
// where start..end spans the operands AND the operator (safe to splice),
// strings holds every decoded string operand (for match predicates), and
// tokens is the ORDERED operand list the interpreter walk consumes:
//   {t:'str',v} {t:'num',v} {t:'name',v} {t:'['} {t:']'}
// (TJ kern numbers keep their position between strings — that order IS the
// glyph advance math). Dicts and braces carry no walk meaning and are skipped.
export function tokenizeOps(src) {
  const ops = [];
  let i = 0;
  let groupStart = -1;   // byte offset where the current operand group began
  let strings = [];
  let tokens = [];

  const beginToken = (at) => { if (groupStart === -1) groupStart = at; };

  while (i < src.length) {
    const c = src[i];
    if (isWS(c)) { i += 1; continue; }
    if (c === '%') { while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i += 1; continue; }

    if (c === '(') {                               // literal string
      beginToken(i);
      let depth = 1; let j = i + 1; let body = '';
      while (j < src.length && depth > 0) {
        const ch = src[j];
        if (ch === '\\') { body += ch + (src[j + 1] ?? ''); j += 2; continue; }
        if (ch === '(') depth += 1; else if (ch === ')') depth -= 1;
        if (depth > 0) body += ch;
        j += 1;
      }
      const lit = decodeLiteralString(body);
      strings.push(lit);
      tokens.push({ t: 'str', v: lit });
      i = j; continue;
    }
    if (c === '<' && src[i + 1] === '<') {         // dict
      beginToken(i);
      let depth = 1; let j = i + 2;
      while (j < src.length && depth > 0) {
        if (src[j] === '<' && src[j + 1] === '<') { depth += 1; j += 2; continue; }
        if (src[j] === '>' && src[j + 1] === '>') { depth -= 1; j += 2; continue; }
        j += 1;
      }
      i = j; continue;
    }
    if (c === '<') {                               // hex string
      beginToken(i);
      const close = src.indexOf('>', i + 1);
      const hexStr = decodeHexString(src.slice(i + 1, close === -1 ? src.length : close));
      strings.push(hexStr);
      tokens.push({ t: 'str', v: hexStr });
      i = close === -1 ? src.length : close + 1; continue;
    }
    if (c === '[' || c === ']' || c === '{' || c === '}') {
      beginToken(i);
      if (c === '[' || c === ']') tokens.push({ t: c }); // {} carry no walk meaning: skipped
      i += 1; continue;
    }
    if (c === ')' || c === '>') { i += 1; continue; } // stray closer (malformed stream): skip, never loop
    if (c === '/') {                               // name
      beginToken(i);
      const nameStart = i + 1;
      i += 1;
      while (i < src.length && !isWS(src[i]) && !isDelim(src[i])) i += 1;
      tokens.push({ t: 'name', v: decodeName(src.slice(nameStart, i)) });
      continue;
    }
    if (c === '+' || c === '-' || c === '.' || (c >= '0' && c <= '9')) {  // number
      beginToken(i);
      const numStart = i;
      i += 1;
      while (i < src.length && (src[i] === '.' || (src[i] >= '0' && src[i] <= '9'))) i += 1;
      tokens.push({ t: 'num', v: parseFloat(src.slice(numStart, i)) });
      continue;
    }

    // Operator (regular characters, incl. ' and ")
    beginToken(i);
    let j = i;
    if (c === "'" || c === '"') j = i + 1;
    else { while (j < src.length && !isWS(src[j]) && !isDelim(src[j])) j += 1; }
    const op = src.slice(i, j);

    if (op === 'BI') {                             // inline image: raw-skip to EI
      const ei = src.indexOf('EI', j);
      const end = ei === -1 ? src.length : ei + 2;
      ops.push({ op: 'BI', start: groupStart, end, strings: [], tokens: [] });
    } else {
      ops.push({ op, start: groupStart, end: j, strings, tokens });
    }
    groupStart = -1;
    strings = [];
    tokens = [];
    i = op === 'BI' ? (ops[ops.length - 1].end) : j;
  }
  return ops;
}

// Remove every show-text op for which `shouldRemove({op, text})` is true.
// Returns { content, removed } — content unchanged when removed === 0.
export function removeShowOps(src, shouldRemove) {
  const ops = tokenizeOps(src);
  const cuts = [];
  for (const rec of ops) {
    if (!SHOW_OPS.has(rec.op)) continue;
    const text = rec.strings.join('');
    if (shouldRemove({ op: rec.op, text })) cuts.push(rec);
  }
  if (cuts.length === 0) return { content: src, removed: 0 };
  let out = '';
  let pos = 0;
  for (const rec of cuts) {
    out += src.slice(pos, rec.start);
    pos = rec.end;
  }
  out += src.slice(pos);
  return { content: out, removed: cuts.length };
}
