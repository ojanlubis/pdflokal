/*
 * docx-validate.mjs — is this .docx valid, beyond "LibreOffice rendered it"?
 * ============================================================================
 *   validateDocx(bytes, { fflate, schema?, scratch? }) -> { problems: string[] (zip + structure), xsdProblems: string[], notes: string[], xsd: 'ran'|'skipped', parts: n }
 *   structureProblems(files)  (files = { path: Uint8Array })   pure JS, no xmllint, no network: what CI always runs
 *   zipProblems(bytes)        the container itself (names, methods, local vs central directory)
 *   xsdProblems(files, schema, scratch)   every XML part against the ECMA-376 / OPC / MS-ODRAWXML schemas via xmllint
 *   CLI: node scripts/lib/docx-validate.mjs file.docx [--no-schema]    prints every problem, exit 1 if any
 *
 * THREE LAYERS, because each catches what the others cannot (and none is "Word opened it"):
 *   1. XSD (xmllint + the pinned schemas of scripts/lib/ooxml-schemas.mjs): element order and
 *      presence in every sequence, attribute types and ranges, unknown elements. MEASURED to go red on a
 *      mis-ordered w:pPr, a stray element in w:body, a wps shape without bodyPr, a wrong a:spPr order.
 *   2. Structure (this file, pure JS): what the XSD cannot say or does not enforce.
 *        - w:rPr: the transitional schema makes its children an unordered xsd:choice (MEASURED: a swapped
 *          rPr validates), but Word writes and reads the spec's sequence order, so it is checked here.
 *          The same table covers pPr, tblPr, tcPr, sectPr, the border/margin containers, wp:inline/anchor,
 *          pic:pic, wps:wsp: with xmllint absent these are the order checks that still run.
 *        - a w:tc must end with a w:p (Word calls the file corrupt otherwise); a w:tbl needs tblPr,
 *          tblGrid and rows; every row's gridSpan sum must equal the grid width; docPr ids unique;
 *          body-level sectPr last; the last block before it a paragraph; every r:embed resolves to an
 *          image relationship; every numId / pStyle / rStyle / tblStyle resolves; styleIds and numIds unique;
 *          w:t with edge whitespace carries xml:space="preserve"; mc:Ignorable / Requires name declared prefixes;
 *          numeric limits Word enforces (page size, font size).
 *   3. Package: content types, relationships (unique valid ids, targets present, one officeDocument,
 *      its content type), reachability (no orphan part), part-name rules, image bytes (PNG signature,
 *      IHDR and every chunk CRC; JPEG SOI/SOF/EOI) matching their extension, UTF-8 validity, and the zip itself.
 *
 * WORD-ONLY RISKS NO LOCAL TOOL CAN PROVE (for the first run on a machine with Word; INFERRED, never measured here):
 *   W1  The wps shape is a bare <a:graphicData uri=".../wordprocessingShape"> inside w:drawing, with no
 *       mc:AlternateContent wrapper and no VML fallback. Word 2010+ reads wps natively; Word 2007 and
 *       Word for the web in some modes would drop it. Check: open in Word desktop AND Word online.
 *   W2  A page-sized behind-text rectangle anchored in the first paragraph (the background): Word may
 *       push the anchor paragraph to a new page when the anchor's page differs from its host page;
 *       LibreOffice does not. Check: page count of a designed 1-page PDF.
 *   W3  relativeHeight stacking (see the KNOWN GAP in writer.js): LibreOffice is erratic with small values;
 *       Word's behaviour with them is unverified. Check: two overlapping behind-text shapes.
 *   W4  Fonts: w:rFonts names the PDF's font (often a subset name or one Word lacks): Word substitutes
 *       silently; line breaks, hence pagination, move. LibreOffice substitutes differently. Check: pageRatio in Word.
 *   W5  w:lineRule="exact" paragraphs clip tall glyphs in Word (descenders, superscripts); LibreOffice does not.
 *   W6  Tables: w:tblLayout fixed + gridCol widths: Word honours tcW over gridCol in some versions when they
 *       disagree; autofit-from-content only when layout is autofit. Rows that carry gridSpan with different
 *       tcW sums render raggedly. Check: a table-heavy PDF, columns visually aligned.
 *   W7  Continuous section breaks with w:cols inside one page (the column segments): Word balances columns
 *       differently from LibreOffice and may start the continuous section on the next page when the page
 *       holds a column break. Check: a two-column paper.
 *   W8  Protected View / "repair" prompts: Word shows a repair dialog for things XSD cannot see (a docPr id
 *       reused across headers, a bookmark id collision, an image part that deflates but is not an image).
 *       Only opening the file in Word proves its absence. Check: open all 104 outputs, count the prompts.
 *   W9  Document size: a 766-page file as one section list: Word's open time and memory, not ours.
 *   W10 Language: w:lang id-ID in docDefaults sets the proofing language; Word flags every word of a
 *       non-Indonesian document as a spelling error until the language is changed. Cosmetic, user-visible.
 *   W11 No settings.xml / theme / fontTable: Word opens such a package and writes them on save; Word for Mac
 *       and the mobile apps are less forgiving than desktop Windows. Check on a Mac and on a phone.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  wps: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
};
const REL_IMAGE = `${NS.r}/image`;

// ------------------------------------------------------------ tiny XML DOM --
const NAME = '[A-Za-z_][\\w.-]*(?::[A-Za-z_][\\w.-]*)?';
const TOKEN = new RegExp(`<!--[\\s\\S]*?-->|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>|<\\?[\\s\\S]*?\\?>|<(/?)(${NAME})((?:\\s+${NAME}\\s*=\\s*(?:"[^"<]*"|'[^'<]*'))*)\\s*(/?)>|<|[^<]+`, 'g');
const ATTR = new RegExp(`(${NAME})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`, 'g');
const unent = (s) => (s.includes('&') ? s.replace(/&(?:amp|lt|gt|quot|apos|#(\d+)|#x([0-9a-fA-F]+));/g, (m, d, h) => (d ? String.fromCodePoint(+d) : h ? String.fromCodePoint(parseInt(h, 16)) : ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[m])) : s);

// Parses what xmlProblems() already accepted. Node: { name, uri, local, attrs: [{ name, uri, local, value }], children, text, parent }.
// Returns null on a document it cannot parse (the well-formedness checks report that).
export function parseXml(text) {
  const root = { name: '#doc', uri: '', local: '#doc', attrs: [], children: [], text: '', nsDecl: [], parent: null };
  let cur = root;
  const scopes = [new Map([['xml', 'http://www.w3.org/XML/1998/namespace']])];
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(text))) {
    const tok = m[0];
    if (tok[0] !== '<') { cur.text += unent(tok); continue; }
    if (tok === '<' || tok.startsWith('<!--') || tok.startsWith('<![CDATA[') || tok.startsWith('<?')) { if (tok.startsWith('<![CDATA[')) cur.text += tok.slice(9, -3); continue; }
    const [, closing, name, attrText, selfClose] = m;
    if (closing) { if (cur.name !== name) return null; cur = cur.parent; scopes.pop(); continue; }
    const raw = [];
    const nsDecl = [];
    for (const a of attrText.matchAll(ATTR)) {
      const value = unent(a[2] !== undefined ? a[2] : a[3]);
      if (a[1] === 'xmlns') nsDecl.push(['', value]);
      else if (a[1].startsWith('xmlns:')) nsDecl.push([a[1].slice(6), value]);
      raw.push([a[1], value]);
    }
    let scope = scopes[scopes.length - 1];
    if (nsDecl.length) { scope = new Map(scope); for (const [p, u] of nsDecl) scope.set(p, u); }
    const split = (n, isAttr) => { const i = n.indexOf(':'); if (i < 0) return [isAttr ? '' : (scope.get('') || ''), n]; return [scope.get(n.slice(0, i)) || '', n.slice(i + 1)]; };
    const [uri, local] = split(name, false);
    const node = { name, uri, local, attrs: raw.filter(([n]) => n !== 'xmlns' && !n.startsWith('xmlns:')).map(([n, value]) => { const [u, l] = split(n, true); return { name: n, uri: u, local: l, value }; }), nsDecl, scope, children: [], text: '', parent: cur };
    cur.children.push(node);
    if (!selfClose) { cur = node; scopes.push(scope); }
  }
  return cur === root && root.children.length === 1 ? root.children[0] : null;
}
export const attrOf = (n, local, uri = NS.w) => { const a = n.attrs.find((x) => x.local === local && (x.uri === uri || (uri === NS.w && x.uri === ''))); return a ? a.value : undefined; };
const kids = (n, uri, local) => n.children.filter((c) => c.uri === uri && (local === undefined || c.local === local));
const is = (n, uri, local) => n.uri === uri && n.local === local;

function serialize(n) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const escA = (s) => esc(s).replace(/"/g, '&quot;');
  const decl = n.nsDecl.map(([p, u]) => ` xmlns${p ? `:${p}` : ''}="${escA(u)}"`).join('');
  const at = n.attrs.map((a) => ` ${a.name}="${escA(a.value)}"`).join('');
  return `<${n.name}${decl}${at}>${esc(n.text)}${n.children.map(serialize).join('')}</${n.name}>`;
}

// Markup Compatibility, as a consumer that understands wps but not Ignorable namespaces sees it:
// mc:AlternateContent -> its mc:Choice (or the Fallback when there is no Choice); elements and attributes in a
// namespace named by mc:Ignorable are dropped. XSD input only; the original is what gets shipped.
function mceResolve(node) {
  const ignorable = new Set();
  const ig = node.attrs.find((a) => a.uri === NS.mc && a.local === 'Ignorable');
  if (ig) for (const p of ig.value.split(/\s+/).filter(Boolean)) { const u = node.scope.get(p); if (u) ignorable.add(u); }
  const walk = (n) => {
    n.attrs = n.attrs.filter((a) => !(a.uri === NS.mc) && !ignorable.has(a.uri));
    const out = [];
    for (const c of n.children) {
      if (ignorable.has(c.uri)) continue;
      if (is(c, NS.mc, 'AlternateContent')) {
        const pick = kids(c, NS.mc, 'Choice')[0] || kids(c, NS.mc, 'Fallback')[0];
        if (pick) for (const g of pick.children) { g.parent = n; g.nsDecl = c.nsDecl.concat(pick.nsDecl, g.nsDecl); out.push(g); }
        continue;
      }
      out.push(c);
    }
    n.children = out;
    n.children.forEach(walk);
  };
  walk(node);
  return node;
}

// ------------------------------------------------------------- order tables --
// Local names in the spec's sequence order. 'a|b' = equal rank (left/start). Source: wml.xsd CT_PPrBase,
// CT_TblPrBase, CT_TcPrBase, EG_SectPrContents, EG_RPrBase (a choice in the XSD, a sequence in the spec text and
// in everything Word writes), the border containers; wordprocessingDrawing.xsd inline/anchor; picture.xsd; [MS-ODRAWXML] 5.2.
const ORDER = {
  [`${NS.w}|pPr`]: 'pStyle keepNext keepLines pageBreakBefore framePr widowControl numPr suppressLineNumbers pBdr shd tabs suppressAutoHyphens kinsoku wordWrap overflowPunct topLinePunct autoSpaceDE autoSpaceDN bidi adjustRightInd snapToGrid spacing ind contextualSpacing mirrorIndents suppressOverlap jc textDirection textAlignment textboxTightWrap outlineLvl divId cnfStyle rPr sectPr pPrChange',
  [`${NS.w}|rPr`]: 'rStyle rFonts b bCs i iCs caps smallCaps strike dstrike outline shadow emboss imprint noProof snapToGrid vanish webHidden color spacing w kern position sz szCs highlight u effect bdr shd fitText vertAlign rtl cs em lang eastAsianLayout specVanish oMath rPrChange',
  [`${NS.w}|tblPr`]: 'tblStyle tblpPr tblOverlap bidiVisual tblStyleRowBandSize tblStyleColBandSize tblW jc tblCellSpacing tblInd tblBorders shd tblLayout tblCellMar tblLook tblCaption tblDescription tblPrChange',
  [`${NS.w}|tcPr`]: 'cnfStyle tcW gridSpan hMerge vMerge tcBorders shd noWrap tcMar textDirection tcFitText vAlign hideMark headers cellIns cellDel cellMerge tcPrChange',
  [`${NS.w}|sectPr`]: 'headerReference|footerReference footnotePr endnotePr type pgSz pgMar paperSrc pgBorders lnNumType pgNumType cols formProt vAlign noEndnote titlePg textDirection bidi rtlGutter docGrid printerSettings sectPrChange',
  [`${NS.w}|tblBorders`]: 'top left|start bottom right|end insideH insideV',
  [`${NS.w}|tcBorders`]: 'top left|start bottom right|end insideH insideV tl2br tr2bl',
  [`${NS.w}|tblCellMar`]: 'top left|start bottom right|end',
  [`${NS.w}|tcMar`]: 'top left|start bottom right|end',
  [`${NS.w}|pBdr`]: 'top left bottom right between bar',
  [`${NS.w}|tbl`]: 'bookmarkStart|bookmarkEnd tblPr tblGrid tr',
  [`${NS.w}|tr`]: 'tblPrEx trPr tc',
  [`${NS.wp}|inline`]: 'extent effectExtent docPr cNvGraphicFramePr graphic',
  [`${NS.wp}|anchor`]: 'simplePos positionH positionV extent effectExtent wrapNone|wrapSquare|wrapTight|wrapThrough|wrapTopAndBottom docPr cNvGraphicFramePr graphic',
  [`${NS.pic}|pic`]: 'nvPicPr blipFill spPr style',
  [`${NS.wps}|wsp`]: 'cNvPr cNvSpPr|cNvCnPr spPr style extLst txbx|linkedTxbx bodyPr',
};
const RANK = Object.fromEntries(Object.entries(ORDER).map(([k, v]) => [k, new Map(v.split(' ').flatMap((g, i) => g.split('|').map((n) => [n, i])))]));
// Containers whose children must not repeat (a repeated w:sz in one w:rPr is the kind of thing Word "repairs").
const NO_REPEAT = new Set([`${NS.w}|pPr`, `${NS.w}|rPr`, `${NS.w}|tblPr`, `${NS.w}|tcPr`, `${NS.w}|tblBorders`, `${NS.w}|tcBorders`, `${NS.w}|tblCellMar`, `${NS.w}|tcMar`, `${NS.w}|pBdr`]);
const KNOWN_URIS = new Set([NS.w, NS.wp, NS.a, NS.pic, NS.wps]);

// Numeric limits: [element local, attribute local, max, hard?]. 31680 twips = 22 in = Word's own maximum.
// hard = a file past it is known to be reported corrupt (INFERRED from Word's UI limits and its documented 1584 pt page limit).
const LIMITS = [['pgSz', 'w', 31680, true], ['pgSz', 'h', 31680, true], ['sz', 'val', 3276, false], ['szCs', 'val', 3276, false],
  ['spacing', 'before', 31680, false], ['spacing', 'after', 31680, false], ['ind', 'left', 31680, false], ['ind', 'right', 31680, false], ['ind', 'firstLine', 31680, false], ['ind', 'hanging', 31680, false],
  ['gridCol', 'w', 31680, false], ['tcW', 'w', 31680, false], ['tab', 'pos', 31680, false]];

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
function resolveTarget(fromPart, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = dirOf(fromPart).split('/').filter(Boolean);
  for (const seg of target.split('/')) { if (seg === '..') parts.pop(); else if (seg !== '.') parts.push(seg); }
  return parts.join('/');
}
const relsPathOf = (part) => `${dirOf(part) ? `${dirOf(part)}/` : ''}_rels/${part.slice(part.lastIndexOf('/') + 1)}.rels`;
const utf8 = (u8) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); } catch { return null; } };
const asText = (v) => (typeof v === 'string' ? v : utf8(v));

// ------------------------------------------------------------ container --
export function crc32(u8) {
  let c; let crc = 0xFFFFFFFF;
  if (!crc32.table) { crc32.table = new Uint32Array(256); for (let n = 0; n < 256; n += 1) { c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crc32.table[n] = c >>> 0; } }
  for (let i = 0; i < u8.length; i += 1) crc = crc32.table[(crc ^ u8[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// The zip as bytes: names, methods, flags, local header vs central directory.
export function zipProblems(bytes) {
  const bad = [];
  const note = (m) => { if (bad.length < 30) bad.push(m); };
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i -= 1) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return ['zip: no end-of-central-directory record'];
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  if (count === 0xFFFF || p === 0xFFFFFFFF) note('zip: zip64 (Word reads it, but nothing here should need it)');
  const names = new Set();
  const lower = new Set();
  for (let k = 0; k < count; k += 1) {
    if (dv.getUint32(p, true) !== 0x02014b50) { note(`zip: bad central directory entry ${k}`); break; }
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localAt = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (flags & 1) note(`zip: ${name} is encrypted`);
    if (method !== 0 && method !== 8) note(`zip: ${name} uses compression method ${method} (Word reads only stored and deflate)`);
    if (names.has(name)) note(`zip: duplicate entry ${name}`);
    names.add(name);
    if (lower.has(name.toLowerCase()) && !names.has(name.toLowerCase())) note(`zip: ${name} differs from another entry only by case`);
    lower.add(name.toLowerCase());
    if (name.endsWith('/')) note(`zip: directory entry ${name} (OPC packages hold parts only)`);
    if (name.includes('\\') || name.startsWith('/')) note(`zip: entry name ${name} has a backslash or a leading slash`);
    if (dv.getUint32(localAt, true) !== 0x04034b50) note(`zip: ${name} local header missing`);
    else {
      const ln = dv.getUint16(localAt + 26, true);
      const lname = new TextDecoder().decode(bytes.subarray(localAt + 30, localAt + 30 + ln));
      if (lname !== name) note(`zip: ${name} local header names ${lname}`);
      if (dv.getUint16(localAt + 8, true) !== method) note(`zip: ${name} local and central compression methods differ`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!names.has('[Content_Types].xml')) note('zip: no [Content_Types].xml entry');
  return bad;
}

function imageProblems(name, u8) {
  const bad = [];
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'png') {
    const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    if (u8.length < 33 || sig.some((b, i) => u8[i] !== b)) return [`${name}: not a PNG (signature)`];
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let p = 8;
    let first = true;
    let sawEnd = false;
    let sawData = false;
    while (p + 12 <= u8.length) {
      const len = dv.getUint32(p);
      const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
      if (p + 12 + len > u8.length) { bad.push(`${name}: PNG chunk ${type} runs past the end`); break; }
      if (first && (type !== 'IHDR' || len !== 13)) { bad.push(`${name}: PNG does not start with IHDR`); break; }
      if (first) { const w = dv.getUint32(p + 8); const h = dv.getUint32(p + 12); if (!w || !h) bad.push(`${name}: PNG has a zero dimension`); }
      first = false;
      if (crc32(u8.subarray(p + 4, p + 8 + len)) !== dv.getUint32(p + 8 + len)) { bad.push(`${name}: PNG chunk ${type} fails its CRC`); break; }
      if (type === 'IDAT') sawData = true;
      p += 12 + len;
      if (type === 'IEND') { sawEnd = true; break; }
    }
    if (!sawEnd && !bad.length) bad.push(`${name}: PNG has no IEND`);
    if (!sawData && !bad.length) bad.push(`${name}: PNG has no IDAT`);
  } else if (ext === 'jpeg' || ext === 'jpg') {
    if (u8.length < 4 || u8[0] !== 0xFF || u8[1] !== 0xD8) return [`${name}: not a JPEG (SOI)`];
    let p = 2;
    let sof = false;
    while (p + 4 <= u8.length) {
      if (u8[p] !== 0xFF) { p += 1; continue; }
      const mk = u8[p + 1];
      if (mk === 0xFF) { p += 1; continue; }
      if (mk === 0xD9 || mk === 0xDA) break;
      if (mk === 0x01 || (mk >= 0xD0 && mk <= 0xD7)) { p += 2; continue; }
      const len = (u8[p + 2] << 8) | u8[p + 3];
      if (mk >= 0xC0 && mk <= 0xCF && mk !== 0xC4 && mk !== 0xC8 && mk !== 0xCC) { sof = true; if (!((u8[p + 5] << 8) | u8[p + 6]) || !((u8[p + 7] << 8) | u8[p + 8])) bad.push(`${name}: JPEG has a zero dimension`); }
      p += 2 + len;
    }
    if (!sof) bad.push(`${name}: JPEG has no frame header`);
    let e = u8.length;
    while (e > 2 && u8[e - 1] === 0) e -= 1;
    if (!(u8[e - 2] === 0xFF && u8[e - 1] === 0xD9)) bad.push(`${name}: JPEG has no EOI (truncated)`);
  }
  return bad;
}

// ------------------------------------------------------------ the package --
function packageStrict(files, trees, note) {
  const names = Object.keys(files);
  const has = (p) => Object.prototype.hasOwnProperty.call(files, p);
  const ctTree = trees.get('[Content_Types].xml');
  if (!ctTree) return;
  const defaults = new Map();
  const overrides = new Map();
  for (const c of ctTree.children) {
    if (is(c, NS.ct, 'Default')) {
      const e = (attrOf(c, 'Extension', '') || '').toLowerCase();
      if (defaults.has(e)) note(`[Content_Types].xml: Default for .${e} twice`);
      defaults.set(e, attrOf(c, 'ContentType', ''));
    } else if (is(c, NS.ct, 'Override')) {
      const pn = attrOf(c, 'PartName', '');
      if (!pn.startsWith('/')) note(`[Content_Types].xml: Override PartName ${pn} must start with "/"`);
      if (overrides.has(pn)) note(`[Content_Types].xml: Override for ${pn} twice`);
      overrides.set(pn, attrOf(c, 'ContentType', ''));
    } else note(`[Content_Types].xml: unexpected element ${c.name}`);
  }
  const typeOf = (n) => overrides.get(`/${n}`) || defaults.get((n.includes('.') ? n.slice(n.lastIndexOf('.') + 1) : '').toLowerCase());
  const seenLower = new Map();
  for (const n of names) {
    if (n !== '[Content_Types].xml' && !/^[A-Za-z0-9._\-/]+$/.test(n)) note(`part name ${n}: only letters, digits . _ - / are used by Word-written packages`);
    if (n.split('/').some((s) => s === '' || s === '.' || s === '..')) note(`part name ${n}: empty or dot segment`);
    const low = n.toLowerCase();
    if (seenLower.has(low) && seenLower.get(low) !== n) note(`part names ${n} and ${seenLower.get(low)} differ only by case`);
    seenLower.set(low, n);
    if (files[n].length === 0) note(`part ${n} is empty`);
  }
  // relationships: ids, targets, types; and reachability from the package root
  const reach = new Set(['[Content_Types].xml']);
  const relsOf = new Map();
  const visit = (owner) => {
    const rp = owner === '' ? '_rels/.rels' : relsPathOf(owner);
    const t = trees.get(rp);
    const map = new Map();
    relsOf.set(owner, map);
    if (!t) return;
    reach.add(rp);
    for (const r of t.children) {
      if (!is(r, NS.rel, 'Relationship')) { note(`${rp}: unexpected element ${r.name}`); continue; }
      const id = attrOf(r, 'Id', '');
      const type = attrOf(r, 'Type', '');
      const target = attrOf(r, 'Target', '');
      const external = attrOf(r, 'TargetMode', '') === 'External';
      if (!/^[A-Za-z_][\w.-]*$/.test(id)) note(`${rp}: relationship id "${id}" is not a valid xsd:ID`);
      if (map.has(id)) note(`${rp}: relationship id ${id} used twice`);
      if (!/^[a-z][a-z0-9+.-]*:/i.test(type)) note(`${rp}: ${id} has a Type that is not an absolute URI`);
      if (!external) {
        if (/[\\\s]/.test(target)) note(`${rp}: ${id} target "${target}" has a backslash or whitespace`);
        const abs = resolveTarget(owner === '' ? 'x' : owner, target);
        map.set(id, { type, abs, external });
        if (!has(abs)) note(`${rp}: ${id} targets missing part ${abs}`);
        if (has(abs) && !reach.has(abs)) { reach.add(abs); if (/\.(xml|rels)$/.test(abs)) visit(abs); }
      } else map.set(id, { type, abs: target, external });
    }
  };
  visit('');
  const root = relsOf.get('');
  const docRels = [...root.values()].filter((r) => r.type === `${NS.r}/officeDocument`);
  if (docRels.length !== 1) note(`_rels/.rels: ${docRels.length} officeDocument relationships (need exactly one)`);
  else {
    const ct = typeOf(docRels[0].abs);
    if (!/^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document(\.main\+xml|\.macroEnabled\.main\+xml)$|^application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.template\.main\+xml$/.test(ct || '')) note(`${docRels[0].abs}: main document part has content type ${ct} (Word refuses it)`);
  }
  for (const n of names) {
    if (n === '[Content_Types].xml') continue;
    if (!reach.has(n)) note(`orphan part ${n}: no relationship reaches it`);
  }
  for (const n of names) {
    if (!n.startsWith('word/media/')) continue;
    const ext = n.slice(n.lastIndexOf('.') + 1).toLowerCase();
    if (!defaults.has(ext) && !overrides.has(`/${n}`)) continue;
    const ct = typeOf(n);
    if (ext === 'png' && ct !== 'image/png') note(`${n}: content type ${ct}, expected image/png`);
    if ((ext === 'jpeg' || ext === 'jpg') && ct !== 'image/jpeg') note(`${n}: content type ${ct}, expected image/jpeg`);
    for (const m of imageProblems(n, files[n])) note(m);
  }
  return relsOf;
}

// ------------------------------------------------------------ the parts --
function checkOrder(n, report) {
  const key = `${n.uri}|${n.local}`;
  const rank = RANK[key];
  if (!rank) return;
  let last = -1;
  let lastName = '';
  const seen = new Set();
  for (const c of n.children) {
    if (!KNOWN_URIS.has(c.uri)) continue;
    const r = rank.get(c.local);
    if (r === undefined) { report(`<${n.name}> has unexpected child <${c.name}>`); continue; }
    if (r < last) report(`<${n.name}> children out of order: <${c.name}> after <${lastName}>`);
    if (NO_REPEAT.has(key) && seen.has(c.local)) report(`<${n.name}> repeats <${c.name}>`);
    seen.add(c.local);
    if (r >= last) { last = r; lastName = c.name; }
  }
}

function wmlChecks(part, root, ctx, report) {
  const rels = ctx.relsOf.get(part) || new Map();
  const isDoc = is(root, NS.w, 'document');
  const docPrIds = new Map();
  const bookmarkIds = new Set();
  const used = { styles: new Set(), nums: new Set() };
  const walk = (n) => {
    checkOrder(n, (m) => report(m));
    for (const [el, at, max, hard] of LIMITS) {
      if (n.local === el && (n.uri === NS.w)) {
        const v = attrOf(n, at);
        if (v !== undefined && /^-?\d+$/.test(v) && Math.abs(Number(v)) > max) (hard ? report : ctx.note)(`<${n.name} ${at}="${v}"> exceeds ${max} (Word's limit)`);
      }
    }
    if (n.uri === NS.w) {
      switch (n.local) {
        case 'tc': {
          const blocks = n.children.filter((c) => c.uri === NS.w && c.local !== 'tcPr');
          if (!blocks.length) report('<w:tc> has no paragraph (a cell needs at least one)');
          else if (!is(blocks[blocks.length - 1], NS.w, 'p')) report(`<w:tc> ends with <${blocks[blocks.length - 1].name}>: a cell must end with a paragraph (Word calls the file corrupt)`);
          if (n.children.some((c, i) => is(c, NS.w, 'tcPr') && i > 0)) report('<w:tc>: tcPr is not first');
          break;
        }
        case 'tbl': {
          const grid = kids(n, NS.w, 'tblGrid')[0];
          const rows = kids(n, NS.w, 'tr');
          if (!kids(n, NS.w, 'tblPr').length) report('<w:tbl> has no tblPr');
          if (!grid) report('<w:tbl> has no tblGrid');
          if (!rows.length) report('<w:tbl> has no row');
          if (grid) {
            const cols = kids(grid, NS.w, 'gridCol').length;
            if (!cols) report('<w:tblGrid> has no gridCol');
            rows.forEach((tr, i) => {
              const cells = kids(tr, NS.w, 'tc');
              if (!cells.length) report(`<w:tbl> row ${i + 1} has no cell`);
              const pr = kids(tr, NS.w, 'trPr')[0];
              const extra = (nm) => { const e = pr && kids(pr, NS.w, nm)[0]; return e ? Number(attrOf(e, 'val')) || 0 : 0; };
              const span = cells.reduce((s, tc) => { const pp = kids(tc, NS.w, 'tcPr')[0]; const gs = pp && kids(pp, NS.w, 'gridSpan')[0]; return s + (gs ? Number(attrOf(gs, 'val')) || 1 : 1); }, 0) + extra('gridBefore') + extra('gridAfter');
              if (span !== cols) report(`<w:tbl> row ${i + 1} spans ${span} grid columns, the grid has ${cols}`);
            });
          }
          break;
        }
        case 'body':
          if (isDoc) {
            const sects = n.children.filter((c) => is(c, NS.w, 'sectPr'));
            if (sects.length > 1) report('<w:body> has more than one body-level sectPr');
            if (sects.length && n.children[n.children.length - 1] !== sects[0]) report('<w:body>: sectPr is not the last child');
            const blocks = n.children.filter((c) => c.uri === NS.w && c.local !== 'sectPr');
            if (blocks.length && !is(blocks[blocks.length - 1], NS.w, 'p')) report(`<w:body> ends with <${blocks[blocks.length - 1].name}> before sectPr: the last block must be a paragraph`);
          }
          break;
        case 'p':
          if (n.children.some((c, i) => is(c, NS.w, 'pPr') && i > 0)) report('<w:p>: pPr is not the first child');
          break;
        case 'r':
          if (n.children.some((c, i) => is(c, NS.w, 'rPr') && i > 0)) report('<w:r>: rPr is not the first child');
          break;
        case 't': {
          const preserve = n.attrs.some((a) => a.local === 'space' && a.value === 'preserve');
          if (!preserve && n.text !== n.text.trim()) report('<w:t> has edge whitespace without xml:space="preserve" (Word drops it)');
          break;
        }
        case 'pStyle': case 'rStyle': case 'tblStyle': { const v = attrOf(n, 'val'); if (v !== undefined) used.styles.add(v); break; }
        case 'numId': if (n.parent && n.parent.local === 'numPr') { const v = attrOf(n, 'val'); if (v !== undefined && v !== '0') used.nums.add(v); } break;
        case 'bookmarkStart': { const id = attrOf(n, 'id'); if (bookmarkIds.has(id)) report(`bookmark id ${id} used twice`); bookmarkIds.add(id); break; }
        default:
      }
    }
    if (n.uri === NS.wp && n.local === 'docPr') {
      const id = attrOf(n, 'id', '');
      if (docPrIds.has(id)) report(`wp:docPr id ${id} used twice (Word reports unreadable content)`);
      docPrIds.set(id, true);
    }
    if (n.uri === NS.wp && (n.local === 'extent')) {
      const cx = Number(attrOf(n, 'cx', '')); const cy = Number(attrOf(n, 'cy', ''));
      if (!(cx > 0) || !(cy > 0)) report(`<wp:extent cx="${cx}" cy="${cy}"> must be positive`);
      else if (cx > 51840000 || cy > 51840000) ctx.note(`<wp:extent> ${cx}x${cy} EMU is larger than Word's 51840000 limit`);
    }
    if (n.uri === NS.a && n.local === 'blip') {
      for (const a of n.attrs) {
        if (a.uri !== NS.r) continue;
        const rel = rels.get(a.value);
        if (!rel) report(`<a:blip r:${a.local}="${a.value}"> has no relationship`);
        else if (a.local === 'embed' && rel.type !== REL_IMAGE) report(`<a:blip r:embed="${a.value}"> points at a relationship of type ${rel.type}`);
      }
    }
    if (n.uri === NS.mc && n.local === 'AlternateContent' && !kids(n, NS.mc, 'Choice').length) report('<mc:AlternateContent> has no mc:Choice');
    if (n.uri === NS.mc && n.local === 'Choice') {
      const req = attrOf(n, 'Requires', '');
      for (const p of (req || '').split(/\s+/).filter(Boolean)) if (!n.scope.has(p)) report(`<mc:Choice Requires="${req}"> names undeclared prefix ${p}`);
    }
    n.children.forEach(walk);
  };
  const ig = root.attrs.find((a) => a.uri === NS.mc && a.local === 'Ignorable');
  if (ig) for (const p of ig.value.split(/\s+/).filter(Boolean)) if (!root.scope.has(p)) report(`mc:Ignorable names undeclared prefix ${p} (Word refuses the file)`);
  walk(root);
  return used;
}

function stylesChecks(root, report) {
  const ids = new Set();
  const defaults = new Map();
  for (const s of kids(root, NS.w, 'style')) {
    const id = attrOf(s, 'styleId');
    if (id === undefined) { report('<w:style> without w:styleId'); continue; }
    if (ids.has(id)) report(`styleId ${id} defined twice`);
    ids.add(id);
    if (attrOf(s, 'default') === '1' || attrOf(s, 'default') === 'true') { const t = attrOf(s, 'type'); if (defaults.has(t)) report(`two default ${t} styles`); defaults.set(t, id); }
  }
  for (const s of kids(root, NS.w, 'style')) for (const ref of ['basedOn', 'next', 'link']) { const e = kids(s, NS.w, ref)[0]; if (e && !ids.has(attrOf(e, 'val'))) report(`style ${attrOf(s, 'styleId')} ${ref} "${attrOf(e, 'val')}" does not exist`); }
  return ids;
}
function numberingChecks(root, report) {
  const abs = new Set();
  const nums = new Set();
  let sawNum = false;
  for (const c of root.children) {
    if (is(c, NS.w, 'abstractNum')) {
      if (sawNum) report('<w:abstractNum> after a <w:num> (all abstractNum come first)');
      const id = attrOf(c, 'abstractNumId');
      if (abs.has(id)) report(`abstractNumId ${id} defined twice`);
      abs.add(id);
      const lv = kids(c, NS.w, 'lvl');
      if (!lv.length) report(`abstractNum ${id} has no lvl`);
      const il = new Set();
      for (const l of lv) { const i = attrOf(l, 'ilvl'); if (il.has(i)) report(`abstractNum ${id}: ilvl ${i} twice`); il.add(i); }
    } else if (is(c, NS.w, 'num')) {
      sawNum = true;
      const id = attrOf(c, 'numId');
      if (nums.has(id)) report(`numId ${id} defined twice`);
      nums.add(id);
    }
  }
  for (const c of kids(root, NS.w, 'num')) { const a = kids(c, NS.w, 'abstractNumId')[0]; if (!a || !abs.has(attrOf(a, 'val'))) report(`num ${attrOf(c, 'numId')} points at a missing abstractNum`); }
  return nums;
}

// The pure-JS checks. files = { path: Uint8Array | string }. Returns { problems, notes }.
export function structureProblems(files) {
  const problems = [];
  const notes = [];
  const add = (where) => (m) => { if (problems.length < 60) problems.push(where ? `${where}: ${m}` : m); };
  const trees = new Map();
  for (const n of Object.keys(files)) {
    if (!/\.(xml|rels)$/.test(n)) continue;
    const text = asText(files[n]);
    if (text === null) { add(n)('not valid UTF-8'); continue; }
    if (!/^﻿?<\?xml\s[^>]*encoding="UTF-8"/i.test(text) && /^﻿?<\?xml/.test(text)) add(n)('XML declaration names an encoding other than UTF-8');
    const t = parseXml(text);
    if (!t) { add(n)('cannot be parsed (see the well-formedness check)'); continue; }
    trees.set(n, t);
  }
  const relsOf = packageStrict(files, trees, add('package')) || new Map();
  const ctx = { relsOf, note: (m) => { if (notes.length < 30) notes.push(m); } };
  let styleIds = null;
  let numIds = null;
  const used = { styles: new Set(), nums: new Set() };
  for (const [n, root] of trees) {
    if (root.uri !== NS.w) continue;
    const report = add(n);
    if (is(root, NS.w, 'styles')) styleIds = stylesChecks(root, report);
    if (is(root, NS.w, 'numbering')) numIds = numberingChecks(root, report);
    const u = wmlChecks(n, root, { ...ctx, note: (m) => ctx.note(`${n}: ${m}`) }, report);
    for (const s of u.styles) used.styles.add(s);
    for (const s of u.nums) used.nums.add(s);
  }
  if (styleIds) for (const s of used.styles) if (!styleIds.has(s)) add('word')(`a style reference "${s}" has no definition in styles.xml`);
  if (numIds) for (const s of used.nums) if (!numIds.has(s)) add('word')(`numId ${s} has no w:num in numbering.xml`);
  if (!styleIds && used.styles.size) add('word')('styles are referenced but there is no styles part');
  if (!numIds && used.nums.size) add('word')('numbering is referenced but there is no numbering part');
  return { problems, notes };
}

// ---------------------------------------------------------------- XSD --
let xmllintPresent;
export const xmllintAvailable = () => { if (xmllintPresent === undefined) { const v = spawnSync('xmllint', ['--version'], { encoding: 'utf8' }); xmllintPresent = !v.error; } return xmllintPresent; };

// Every XML part against the schemas. Returns string[] (empty = valid). Throws when the schema itself fails to
// compile (that is a broken harness, not a broken document).
export function xsdProblems(files, schema, scratch) {
  const names = Object.keys(files).filter((n) => /\.(xml|rels)$/.test(n));
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });
  const paths = names.map((n, i) => {
    const p = path.join(scratch, `p${i}.xml`);
    let text = asText(files[n]);
    if (text !== null && /<mc:|mc:Ignorable/.test(text)) { const t = parseXml(text); if (t) text = serialize(mceResolve(t)); }
    fs.writeFileSync(p, text === null ? files[n] : text);
    return p;
  });
  const r = spawnSync('xmllint', ['--nonet', '--catalogs', '--noout', '--huge', '--schema', schema.wrapper, ...paths], { encoding: 'utf8', maxBuffer: 1 << 27, env: { ...process.env, XML_CATALOG_FILES: schema.catalog } });
  fs.rmSync(scratch, { recursive: true, force: true });
  const err = String(r.stderr || '');
  if (/failed to compile|Schemas parser error/.test(err)) throw new Error(`the schema did not compile: ${err.split('\n').filter((l) => /parser error|failed to compile/.test(l)).slice(0, 2).join(' | ').slice(0, 300)}`);
  const bad = [];
  const byPath = new Map(paths.map((p, i) => [p, names[i]]));
  const ok = new Set();
  for (const line of err.split('\n')) {
    const v = line.match(/^(\S+) validates$/);
    if (v) { ok.add(v[1]); continue; }
    const e = line.match(/^(\S+?):\d+: (?:element (\S+): )?(?:Schemas validity error|Schemas parser error|parser error|error) : (.*)$/);
    if (e && byPath.has(e[1])) { if (bad.length < 40) bad.push(`${byPath.get(e[1])}: ${e[2] ? `${e[2]}: ` : ''}${e[3].replace(/\{[^}]*\}/g, (u) => `{${u.slice(1, -1).split('/').pop()}}`)}`.slice(0, 400)); }
  }
  for (const [p, n] of byPath) if (!ok.has(p) && !bad.some((b) => b.startsWith(`${n}:`))) bad.push(`${n}: did not validate (${err.split('\n').filter((l) => l.includes(p)).slice(0, 1).join('').slice(0, 200) || `xmllint exit ${r.status}`})`);
  return bad;
}

// Everything, on the bytes of a .docx.
export function validateDocx(bytes, { fflate, schema = null, scratch = path.join(os.tmpdir(), `docx-validate-${process.pid}`) } = {}) {
  const problems = zipProblems(bytes).map((m) => m);
  let files;
  try { files = fflate.unzipSync(bytes); } catch (e) { return { problems: problems.concat(`zip: cannot be read (${String(e.message).slice(0, 80)})`), notes: [], xsd: 'skipped', parts: 0 }; }
  const s = structureProblems(files);
  let xsd = 'skipped';
  const bad = [];
  if (schema) { bad.push(...xsdProblems(files, schema, scratch)); xsd = 'ran'; }
  return { problems: problems.concat(s.problems), xsdProblems: bad, notes: s.notes, xsd, parts: Object.keys(files).length };
}

// A small package that exercises every writer feature the checks look at (runs with colour and size, a bullet, a table with a
// span and a fill, an inline picture, a page-anchored shape, a two-column segment, two pages). Used by the gate's self-test and the
// unit tests as the known-good starting point that each mutation then breaks.
export async function buildFixtureDocx(fflate) {
  const model = await import('../../js/docx/model.js');
  const { buildDocx } = await import('../../js/docx/writer.js');
  await import('../../js/docx/tables.js');
  await import('../../js/docx/color.js');
  const { encodePng } = await import('../../js/docx/png.js');
  const { makeDoc, makePage, makeSegment, makePara } = model;
  const png = encodePng(fflate, 4, 4, 3, new Uint8Array(4 * 4 * 3).fill(90));
  const cell = (t, over) => ({ blocks: [makePara(t)], ...over });
  const page1 = makePage({
    anchors: [{ kind: 'shape', x: 0, y: 0, wPt: 595, hPt: 842, fill: 'FFF2CC', stroke: { c: '808080', wPt: 0.5 }, z: 0 }],
    segments: [
      makeSegment({ blocks: [
        { kind: 'p', runs: [{ t: 'Judul ', b: true, sz: 18, c: 'C00000' }, { t: 'biasa', i: true, f: 'Arial' }, { t: '\tsetelah tab', u: true }], align: 'center', spaceBefore: 6, tabs: [200] },
        { kind: 'p', runs: [{ t: ' butuh preserve ', bg: 'FFFF00' }], list: 'bullet', indentLeft: 18, indentFirst: -18 },
        { kind: 'tbl', colsPt: [150, 150], border: true, spaceBefore: 4, rows: [[cell('A', { fill: 'D9E2F3' }), cell('B')], [cell('Gabungan', { span: 2 })]] },
        { kind: 'img', bytes: png, ext: 'png', wPt: 40, hPt: 40, align: 'left', indentLeft: 0, spaceBefore: 2 },
      ] }),
      makeSegment({ cols: 2, space: 18, blocks: [makePara('kolom satu'), { ...makePara('kolom dua'), colBreakAfter: false }] }),
    ],
  });
  const page2 = makePage({ segments: [makeSegment({ blocks: [makePara('halaman dua')] })] });
  return buildDocx(makeDoc([page1, page2], 'fixture'), { fflate });
}

// ----------------------------------------------------------------- CLI --
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { ensureSchemas } = await import('./ooxml-schemas.mjs');
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) { console.error('usage: node scripts/lib/docx-validate.mjs file.docx [--no-schema]'); process.exit(2); }
  const module = { exports: {} };
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  new Function('module', 'exports', 'self', 'window', 'global', 'define', fs.readFileSync(path.join(root, 'js/vendor/fflate.min.js'), 'utf8'))(module, module.exports, globalThis, undefined, globalThis, undefined);
  const schema = args.includes('--no-schema') ? null : await ensureSchemas({ log: (m) => console.error(m) });
  const r = validateDocx(new Uint8Array(fs.readFileSync(file)), { fflate: module.exports, schema });
  for (const p of r.problems) console.log(`STRICT ${p}`);
  for (const p of r.xsdProblems || []) console.log(`XSD    ${p}`);
  for (const p of r.notes) console.log(`note   ${p}`);
  console.log(`${r.parts} parts, xsd ${r.xsd}: ${r.problems.length + (r.xsdProblems || []).length} problems, ${r.notes.length} notes`);
  process.exit(r.problems.length + (r.xsdProblems || []).length ? 1 : 0);
}
