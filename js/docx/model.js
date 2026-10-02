/*
 * PDFLokal — docx/model.js  (THE INTERMEDIATE DOCUMENT MODEL + the page context)
 * ============================================================================
 * Everything in js/docx/ talks through the two shapes documented here. Read
 * this file and you can write any one module without opening another.
 *
 *   PDF --pdf.js--> PageCtx --(extract, color, images, tables, layout)--> Page --writer--> .docx
 *
 * THE DOCUMENT MODEL (what the writer consumes; all lengths in PDF points, 1pt = 1/72in)
 *
 *   Doc     = { title?, pages: Page[] }
 *   Page    = { widthPt, heightPt, kind, segments: Segment[], anchors: Anchor[] }
 *             One Word SECTION per PDF page: that is what carries the page's own
 *             size and gives the page break between PDF pages.
 *   Segment = { cols, space, marginPt: {top,right,bottom,left}, blocks: Block[] }
 *             A run of blocks sharing margins. cols > 1 is a Word column band
 *             (continuous section break); `space` is the gutter in pt.
 *   Block   = Para | Img | Table | (any kind a module registered with the writer)
 *   Para    = { kind:'p', runs: Run[], align?: 'left'|'center'|'right'|'both',
 *               indentLeft?, indentRight?, indentFirst? (pt; negative = hanging),
 *               spaceBefore? (pt), lineExact? (pt), list?: 'bullet', rtl?,
 *               tabs?: number[] (pt from the left margin), colBreakAfter?,
 *               shd? (hex, paragraph background), extraPPr? (raw XML, see writer.js) }
 *   Run     = { t: string ('\t' = tab), b?, i?, u?, sz? (pt), f? (family),
 *               c? (hex 'RRGGBB' text colour), bg? (hex run shading), rtl?,
 *               xml? (raw <w:r>, bypasses everything above), extraRPr? }
 *   Img     = { kind:'img', bytes: Uint8Array, ext:'png'|'jpeg', wPt, hPt,
 *               align?, indentLeft?, spaceBefore?,
 *               anchor?: {x,y} (page pt: absolute, behind the text; use in Page.anchors),
 *               crop?: {l,t,r,b} (fractions 0..1 of the source), z? }
 *   Table   = { kind:'tbl', colsPt: number[], rows: Cell[][], border?: boolean, spaceBefore?,
 *               indentLeft? (pt), rowsH?: number[] (pt, one per row, written "at least"),
 *               src?: 'ruled'|'rules-h'|'text' (how tables.js found it; informational, never written) }
 *   Cell    = { blocks: Para[], span?: number (gridSpan), fill?: hex (cell shading),
 *               vmerge?: 'restart'|'continue' (a vertically merged cell: 'continue' keeps its grid
 *               slot, with no blocks, in every row below the 'restart'),
 *               borders?: { top?, left?, bottom?, right?: { sz: eighths of a pt, c: hex } } (absent
 *               side = no border),
 *               mar?: { t, l, b, r } (pt, cell margins), vAlign?: 'top'|'center'|'bottom' }
 *   Anchor  = any object with a `kind` the writer has an anchor writer for ('img'
 *             built in; docx/color.js registers 'shape'). They ride in the page's
 *             first paragraph, cost the text flow nothing, and stack in array order.
 *   Shape   = { kind:'shape', x, y, wPt, hPt (page pt), fill?: hex, stroke?: {c, wPt} }
 *             (the contract for vector art / backgrounds; owned by docx/color.js)
 *
 * THE PAGE CONTEXT (`ctx`, one per PDF page, built and threaded by convert.js)
 *
 *   Set by extract.readPage():
 *     pdfjs, page, pageNumber, vp (scale 1), widthPt, heightPt,
 *     tc (getTextContent result), ops (page.getOperatorList() result),
 *     fontInfo: Map(fontName -> {family,bold,italic}),
 *     hasTextItems, kind: 'text'|'searchable-scan'|'empty' (convert may refine to 'scan'|'ocr-scan'),
 *     runs: Run*[]  (pdf.js runs, geometry in page px == pt, top-left origin; see
 *                   core/text-run-geometry.js; plus .style {family,bold,italic} and .dir)
 *   Set by images.extractImages():   ctx.images: [{ kind:'img', bytes, ext, box:{x0,y0,x1,y1}, z }]
 *   Set by color.analyzeColor():     ctx.color = ColorInfo (see color.js); also sets run.color (hex|null)
 *   Set by extract.groupLines():     ctx.lines (core/text-lines.js Line[]), ctx.words (lazy, see extract.js)
 *   Set by tables.detectTables():    ctx.tables: TableClaim[]  (see tables.js)
 *   ctx.shared = { fflate, imageCache: Map }   state that lives across pages
 *   ctx.options = what the caller of convertPdfToDocx passed in `options`
 *
 *   Coordinates everywhere below the writer: PAGE points, y grows DOWN, origin top-left.
 *
 * WHO WRITES WHAT (so lanes do not collide):
 *   extract.js  text -> runs -> lines -> words, fonts, OCR runs
 *   layout.js   reading order, columns, rows, paragraphs  (text only)
 *   tables.js   table detection + the 'tbl' writer
 *   color.js    colour: text, fills, backgrounds, vector shapes + the 'shape' writer
 *   images.js   image decode/encode + placement (Page.anchors) + the 'img' placement policy
 *   writer.js   OOXML + the registry other modules extend; never knows about pdf.js
 *   convert.js  the page loop, progress, cancel, assembling the Doc
 */

export const median = (a) => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
};

export const percentile = (a, p) => {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

// A4 with the spike's fallback margins: used for an empty document and for a
// page whose conversion threw (the page still occupies its slot in the output).
export const A4 = Object.freeze({ widthPt: 595, heightPt: 842 });

export function makeSegment(over) {
  return { cols: 1, space: 0, marginPt: { top: 36, right: 36, bottom: 0, left: 36 }, blocks: [], ...over };
}

export function makePage(over) {
  return { widthPt: A4.widthPt, heightPt: A4.heightPt, kind: 'text', segments: [makeSegment()], anchors: [], ...over };
}

export const makeDoc = (pages = [], title = '') => ({ title, pages });

export const makePara = (text, over) => ({ kind: 'p', runs: text === '' ? [] : [{ t: String(text) }], ...over });

const HEX = /^[0-9a-f]{6}$/i;
const num = (v) => typeof v === 'number' && Number.isFinite(v);

// Structural validator: returns a list of problems (empty = fine). The writer
// never validates (hot path); tests and the gate call this so a lane that emits
// NaN / a bad colour / a table with ragged rows fails loudly at the model, not as
// a Word "unreadable content" dialog three steps later.
export function validateModel(doc) {
  const bad = [];
  const at = (path, msg) => bad.push(`${path}: ${msg}`);
  const checkRun = (r, path) => {
    if (typeof r.t !== 'string' && typeof r.xml !== 'string') at(path, 'run needs t or xml');
    if (r.c !== undefined && !(typeof r.c === 'string' && HEX.test(r.c))) at(path, `bad colour ${r.c}`);
    if (r.bg !== undefined && !(typeof r.bg === 'string' && HEX.test(r.bg))) at(path, `bad shading ${r.bg}`);
    if (r.sz !== undefined && !(num(r.sz) && r.sz > 0)) at(path, `bad size ${r.sz}`);
  };
  const checkPara = (p, path) => {
    if (p.kind !== 'p') at(path, `expected paragraph, got ${p.kind}`);
    if (!Array.isArray(p.runs)) at(path, 'runs must be an array');
    else p.runs.forEach((r, i) => checkRun(r, `${path}.runs[${i}]`));
    for (const k of ['indentLeft', 'indentRight', 'indentFirst', 'spaceBefore', 'lineExact']) {
      if (p[k] !== undefined && !num(p[k])) at(path, `${k} is not a finite number (${p[k]})`);
    }
    if (p.shd !== undefined && !HEX.test(String(p.shd))) at(path, `bad paragraph shading ${p.shd}`);
  };
  const checkImg = (b, path) => {
    if (!(b.bytes instanceof Uint8Array) || !b.bytes.length) at(path, 'image has no bytes');
    if (b.ext !== 'png' && b.ext !== 'jpeg') at(path, `image ext ${b.ext}`);
    if (!(num(b.wPt) && b.wPt > 0 && num(b.hPt) && b.hPt > 0)) at(path, 'image size must be positive finite');
    if (b.anchor && !(num(b.anchor.x) && num(b.anchor.y))) at(path, 'anchor needs finite x,y');
  };
  const checkBlock = (b, path) => {
    if (b.kind === 'p') checkPara(b, path);
    else if (b.kind === 'img') checkImg(b, path);
    else if (b.kind === 'tbl') {
      if (!Array.isArray(b.colsPt) || !b.colsPt.length || !b.colsPt.every((c) => num(c) && c > 0)) at(path, 'table colsPt must be positive numbers');
      if (b.rowsH !== undefined && !(Array.isArray(b.rowsH) && b.rowsH.length === (b.rows || []).length && b.rowsH.every((h) => num(h) && h >= 0))) at(path, 'table rowsH must be one finite height per row');
      (b.rows || []).forEach((row, ri) => {
        const span = row.reduce((a, c) => a + (c.span > 1 ? c.span : 1), 0);
        if (b.colsPt && span !== b.colsPt.length) at(`${path}.rows[${ri}]`, `row spans ${span} columns, grid has ${b.colsPt.length}`);
        row.forEach((c, ci) => {
          const CP = `${path}.rows[${ri}][${ci}]`;
          if (c.fill !== undefined && !HEX.test(String(c.fill))) at(CP, `bad fill ${c.fill}`);
          if (c.vmerge !== undefined && c.vmerge !== 'restart' && c.vmerge !== 'continue') at(CP, `bad vmerge ${c.vmerge}`);
          if (c.vAlign !== undefined && !['top', 'center', 'bottom'].includes(c.vAlign)) at(CP, `bad vAlign ${c.vAlign}`);
          for (const [side, bd] of Object.entries(c.borders || {})) {
            if (!['top', 'left', 'bottom', 'right'].includes(side)) at(CP, `bad border side ${side}`);
            else if (!(bd && num(bd.sz) && bd.sz > 0 && HEX.test(String(bd.c)))) at(CP, `bad border ${side}`);
          }
          for (const [side, v] of Object.entries(c.mar || {})) if (!['t', 'l', 'b', 'r'].includes(side) || !num(v) || v < 0) at(CP, `bad cell margin ${side}=${v}`);
          (c.blocks || []).forEach((p, pi) => checkPara(p, `${path}.rows[${ri}][${ci}].blocks[${pi}]`));
        });
      });
    } else if (typeof b.kind !== 'string') at(path, 'block without kind');
  };
  if (!doc || !Array.isArray(doc.pages)) return ['doc.pages must be an array'];
  doc.pages.forEach((page, pi) => {
    const P = `pages[${pi}]`;
    if (!(num(page.widthPt) && page.widthPt > 0 && num(page.heightPt) && page.heightPt > 0)) at(P, 'page size must be positive finite');
    (page.segments || []).forEach((seg, si) => {
      const S = `${P}.segments[${si}]`;
      if (!(seg.cols >= 1)) at(S, 'cols must be >= 1');
      const m = seg.marginPt || {};
      for (const k of ['top', 'right', 'bottom', 'left']) if (!num(m[k]) || m[k] < 0) at(S, `marginPt.${k} must be a finite number >= 0`);
      (seg.blocks || []).forEach((b, bi) => checkBlock(b, `${S}.blocks[${bi}]`));
    });
    (page.anchors || []).forEach((a, ai) => {
      if (a.kind === 'img') checkImg(a, `${P}.anchors[${ai}]`);
      else if (typeof a.kind !== 'string') at(`${P}.anchors[${ai}]`, 'anchor without kind');
    });
  });
  return bad;
}
