/*
 * PDFLokal — docx/extract.js  (TEXT EXTRACTION: pdf.js -> runs -> lines -> words)
 * ============================================================================
 * Everything between pdf.js and layout that is about reading TEXT off a page.
 *
 *   readPage({ pdfjs, page, pageNumber, shared, options }) -> ctx            (async)
 *       Builds the page context (model.js documents every field): viewport, text
 *       content, operator list, per-font style, the page `kind` as far as text can
 *       tell, and ctx.runs.
 *       ORDER IS A PHONE-PERFORMANCE DECISION (as in v2/text-runs.js): the cheap
 *       getTextContent runs first, the dear getOperatorList second.
 *   applyOcr(ctx, ocr) -> boolean        a scan's OCR lines replace ctx.runs (the SHELL
 *                                        supplies `ocr`; canvas + Tesseract live in the browser)
 *   groupLines(ctx)                      ctx.runs -> ctx.lines (core/text-lines.js, the
 *                                        same clustering the editor uses) and ctx.words
 *   styledRuns(line, colorOf?) -> Run[]  one visual line as model runs (font, size,
 *                                        bold/italic, colour); layout and tables both use it
 *   wordsOfLine(line) -> Word[]          word boxes (APPROXIMATE, see below)
 *
 * The per-item geometry is core/text-run-geometry.js (shared with the editor).
 * pdf.js and fflate are INJECTED (no import of either): node loads the vendored
 * UMD builds, the browser passes the window globals.
 */

import { groupRunsIntoLines, SPACE_GAP_FACTOR } from '../core/text-lines.js';
import { pageHasVisibleText } from '../core/text-visibility.js';
import { runsFromTextContent } from '../core/text-run-geometry.js';

// ---------------------------------------------------------------- fonts ----
const ALIAS = [
  [/^(times new roman|times|tinos|liberation serif|nimbus rom\w*)$/i, 'Times New Roman'],
  [/^(arial|helvetica|helvetica neue|liberation sans|arimo|nimbus sans\w*)$/i, 'Arial'],
  [/^(courier|courier new|cousine|liberation mono|nimbus mono\w*)$/i, 'Courier New'],
  [/^(calibri|carlito)$/i, 'Calibri'],
  [/^(cambria|caladea)$/i, 'Cambria'],
  [/^(symbol|symbolmt)$/i, 'Symbol'],
];

export function fontInfoOf(fontObj, generic) {
  const raw = String((fontObj && fontObj.name) || '');
  const name = raw.replace(/^.*\+/, '');
  const bold = /bold|black|heavy|semibold|demi/i.test(name) || !!(fontObj && fontObj.bold);
  const italic = /italic|oblique/i.test(name) || !!(fontObj && fontObj.italic);
  // family = the part before the style suffix ("ArialNarrow-BoldItalic" -> "Arial Narrow")
  let fam = name.split(/[-,]/)[0]
    .replace(/(PSMT|PS|MT)$/i, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\s+(bold|italic|oblique|regular)\b.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  let family = null;
  for (const [re, f] of ALIAS) if (re.test(fam)) { family = f; break; }
  if (!family) {
    // A generator placeholder ("F1", "g d0 f1", "CIDFont") teaches nothing.
    const uninformative = !fam || /^(f|c|g|tt|font|cidfont|type|d|[a-z]\d*)(\s?\d+)*$/i.test(fam) || fam.length < 3;
    if (!uninformative) family = fam;
  }
  fam = '';
  if (!family) {
    if (fontObj && fontObj.isMonospace) family = 'Courier New';
    else if ((fontObj && fontObj.isSerifFont) || generic === 'serif') family = 'Times New Roman';
    else if (generic === 'monospace') family = 'Courier New';
    else family = 'Arial';
  }
  return { family, bold, italic };
}

// ---------------------------------------------------------------- spaces ----
// Many generators (PowerPoint, some Word exports) write a word space as a SEPARATE text item
// (" ") and position the words by matrix, so the gap between two words can be well under the
// 0.18em the line assembler needs to guess a space ("Memperolehpalingsedikit"). runsFromTextContent
// drops whitespace-only items; this keeps what they mean by folding each one into the item
// before it on the same baseline as a trailing space. Geometry (width) is untouched. MEASURED
// effect: see the lane notes in the commit; the glued-token share of n065 was 7%.
export function foldSpaceItems(items) {
  const out = [];
  for (const it of items) {
    if (it.str && it.width && !it.str.trim() && out.length) {
      const prev = out[out.length - 1];
      if (prev.str && prev.str.trim() && !/\s$/.test(prev.str) && prev.fontName !== undefined) {
        const size = Math.hypot(it.transform[2], it.transform[3]) || 10;
        const dy = Math.abs(it.transform[5] - prev.transform[5]);
        const dx = it.transform[4] - (prev.transform[4] + prev.width);
        if (dy <= 0.3 * size && dx >= -0.5 * size && dx <= size) { out[out.length - 1] = { ...prev, str: `${prev.str} ` }; continue; }
      }
    }
    out.push(it);
  }
  return out;
}

// ---------------------------------------------------------------- page -----
export async function readPage({ pdfjs, page, pageNumber, shared, options }) {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  const ops = await page.getOperatorList();
  const fontInfo = new Map();
  for (const name of new Set(tc.items.map((it) => it.fontName))) {
    let fo = null;
    try { fo = page.commonObjs.get(name); } catch { /* font not resolved */ }
    fontInfo.set(name, fontInfoOf(fo, (tc.styles[name] || {}).fontFamily));
  }
  const hasTextItems = tc.items.some((it) => it.str && it.str.trim());
  let kind = 'empty';
  if (hasTextItems) kind = (await pageHasVisibleText(page, pdfjs)) ? 'text' : 'searchable-scan';
  const runs = hasTextItems
    ? runsFromTextContent({
      pdfjs, tc: { ...tc, items: foldSpaceItems(tc.items) }, vp,
      extra: (item) => ({ dir: item.dir, style: fontInfo.get(item.fontName) || { family: 'Arial', bold: false, italic: false } }),
    })
    : [];
  return {
    pdfjs, page, pageNumber, vp, widthPt: vp.width, heightPt: vp.height, tc, ops, fontInfo, hasTextItems, kind, runs,
    images: [], lines: [], tables: [], color: null, shared, options: options || {},
  };
}

// OCR lines (core/ocr-lines.js shape: str, x, y, w, h, size in page-space px,
// top-left origin) as pseudo text runs, so a scan goes through the SAME layout
// pipeline as a text page. y0 is the negated display baseline: the clustering
// only needs a consistent perpendicular axis.
function runsFromOcr(ocrLines) {
  return ocrLines.map((l) => {
    const base = l.y + l.h * 0.8;
    return {
      str: l.str, x: l.x, y: l.y, w: l.w, h: l.h, size: l.size, fontName: 'ocr', fontFamily: '', dir: 'ltr',
      org: { x: l.x, y: base },
      pdf: { x0: l.x, y0: -base, ux: 1, uy: 0, len: l.w, size: l.size },
      style: { family: 'Arial', bold: false, italic: false },
    };
  });
}

// `ocr`: async ({ page, viewport, pageNumber }) => ocr lines.
export async function applyOcr(ctx, ocr) {
  const found = await ocr({ page: ctx.page, viewport: ctx.vp, pageNumber: ctx.pageNumber });
  if (found && found.length) { ctx.runs = runsFromOcr(found); ctx.kind = 'ocr-scan'; return true; }
  return false;
}

// ---------------------------------------------------------------- lines ----
export function groupLines(ctx) {
  ctx.lines = groupRunsIntoLines(ctx.runs);
  // words are derived on demand: most pages never ask
  let words = null;
  Object.defineProperty(ctx, 'words', {
    configurable: true,
    enumerable: false,
    get() { if (!words) words = ctx.lines.flatMap((l, k) => wordsOfLine(l, k)); return words; },
  });
  return ctx.lines;
}

// A line's styled runs: same space-synthesis rule as text-lines.js assembleLine
// (so the text of the docx equals the text of the line the editor sees).
// `colorOf(run)` (optional) -> 'RRGGBB'|null; defaults to the colour lane's run.color.
export function styledRuns(line, colorOf) {
  const out = [];
  let prev = null;
  let prevA1 = 0;
  const colour = colorOf || ((r) => r.color || null);
  const push = (text, r) => {
    const s = r.style;
    const last = out[out.length - 1];
    const sz = Math.round(r.pdf.size * 2) / 2;
    const c = colour(r);
    if (last && last.b === s.bold && last.i === s.italic && last.f === s.family && last.sz === sz && (last.c || null) === c) last.t += text;
    else out.push(c ? { t: text, b: s.bold, i: s.italic, f: s.family, sz, c } : { t: text, b: s.bold, i: s.italic, f: s.family, sz });
  };
  for (const r of line.runs) {
    const a0 = r.pdf.x0 * r.pdf.ux + r.pdf.y0 * r.pdf.uy;
    let text = r.str;
    if (prev) {
      const gap = a0 - prevA1;
      const prevText = out.length ? out[out.length - 1].t : '';
      if (gap > SPACE_GAP_FACTOR * prev.pdf.size && !/\s$/.test(prevText) && !/^\s/.test(text)) text = ` ${text}`;
    }
    push(text, r);
    prev = r;
    prevA1 = a0 + r.pdf.len;
  }
  // a folded word space at the end of a line is not part of the line
  if (out.length) out[out.length - 1].t = out[out.length - 1].t.replace(/\s+$/, '');
  return out;
}

// Word boxes of one line, page px, top-left origin: { str, x0, x1, y0, y1, base, size, line }.
// APPROXIMATE: pdf.js gives a width per text ITEM, not per glyph, so a word's x-extent is its
// share of its run's box by character count (exact for monospace, within a few percent for
// proportional text). Fine for "which column is this word in", wrong for a glyph-exact box.
// Words never cross runs; a run is one font and one baseline. Unrotated text only (the box is axis-aligned).
export function wordsOfLine(line, lineIndex) {
  const words = [];
  for (const r of line.runs) {
    const pad = r.size * 0.06;
    const x0 = r.x + pad;
    const w = Math.max(0, r.w - pad * 2);
    const n = r.str.length;
    if (!n) continue;
    const re = /\S+/g;
    let m;
    while ((m = re.exec(r.str))) {
      words.push({
        str: m[0],
        x0: x0 + (w * m.index) / n,
        x1: x0 + (w * (m.index + m[0].length)) / n,
        y0: r.y + pad,
        y1: r.y + r.h - pad,
        base: r.org.y,
        size: r.size,
        line: lineIndex === undefined ? null : lineIndex,
      });
    }
  }
  return words;
}
