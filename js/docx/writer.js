/*
 * PDFLokal — docx/writer.js  (the OOXML WRITER + the registry other modules extend)
 * ============================================================================
 * Pure: a document model in (js/docx/model.js), the bytes of a valid .docx out.
 * No DOM, no pdf.js, no network. The zip comes from the vendored fflate, INJECTED
 * as `deps.fflate` (the same convention as core/export-images.js): the browser
 * passes window.fflate from ensureFflate(), node passes the same file loaded as
 * UMD. fflate is already shipped for the images-ZIP path, so this adds ZERO new
 * dependency and no hand-rolled zip.
 *
 * THE REGISTRY (so six lanes add XML without editing each other's files).
 * A module registers at import time; buildDocx reads the registry. Built in:
 * paragraphs, runs, sections, the 'img' block and the 'img' anchor, and the
 * parts every .docx needs (content types, rels, document, styles, numbering, core).
 *
 *   registerBlock(kind, (block, w, sect) => xml, { carriesSect })
 *       a new Block kind. Output is block-level XML (<w:p>, <w:tbl>, ...). A kind
 *       that ends in a <w:p> may set carriesSect: it is then allowed to be the
 *       last block of a segment and MUST embed `sect` (a <w:sectPr> string, or
 *       '') in that paragraph's pPr. Any other kind gets a 1pt carrier paragraph
 *       after it automatically.
 *   registerAnchor(kind, (anchor, w) => '<w:r>...</w:r>')
 *       a page-level object (Page.anchors). Anchors ride in the page's first
 *       paragraph, stack in array order.
 *   registerPart({ path, contentType, rel?: {type, root?}, build(w) => string|Uint8Array|null })
 *       an extra file in the package (settings.xml, theme, footnotes, ...). The
 *       writer adds the content-type Override and the relationship (document.xml.rels,
 *       or the package's _rels/.rels with rel.root). build returning null skips it.
 *   registerStyle(xml) / registerNumbering({ abstractNum, num })
 *       append a <w:style> to styles.xml / an abstractNum + num to numbering.xml.
 *   registerMediaType(ext, contentType)
 *       a <Default Extension> for media the writer does not know (gif, emf ...).
 *
 * THE WRITE CONTEXT `w` handed to every callback (per buildDocx call):
 *   w.fflate, w.doc, w.ext (a scratch object: namespace your keys, e.g. w.ext.myModule),
 *   w.esc(text) / w.attr(text) escapers, w.twip(pt) / w.emu(pt) / w.halfPt(pt),
 *   w.paraXml(para, sect), w.runXml(run), w.pPrXml(para, sect)
 *   w.addMedia(bytes, ext) -> { name, rid }   (deduped by byte-array identity)
 *   w.nextId() -> unique drawing id (docPr / relativeHeight)
 *   w.addRel(type, target) -> rId             (a relationship in document.xml.rels)
 *   w.useNamespace(prefix, uri)               (an extra xmlns on <w:document>: wps, mc, w14 ...;
 *                                              declared only in documents that use it)
 *
 * The extraction half (pdf.js -> the model) is js/docx/{extract,layout,images,...}.js.
 */

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" '
  + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" '
  + 'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
  + 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
  + 'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

const twip = (pt) => Math.round(pt * 20);
const emu = (pt) => Math.max(1, Math.round(pt * 12700));
const halfPt = (pt) => Math.max(2, Math.min(1638, Math.round(pt * 2)));

// XML 1.0 forbids most C0 controls and the two non-characters; a PDF text layer
// carries them routinely (form feeds, NULs). Lone surrogates are dropped too.
const BAD_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g; // eslint-disable-line no-control-regex
export function xmlText(s) {
  return String(s).replace(BAD_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const xmlAttr = (s) => xmlText(s).replace(/"/g, '&quot;');

function runXml(run) {
  if (run.xml) return run.xml;
  let rpr = '';
  if (run.f) rpr += `<w:rFonts w:ascii="${xmlAttr(run.f)}" w:hAnsi="${xmlAttr(run.f)}" w:cs="${xmlAttr(run.f)}" w:eastAsia="${xmlAttr(run.f)}"/>`;
  if (run.b) rpr += '<w:b/><w:bCs/>';
  if (run.i) rpr += '<w:i/><w:iCs/>';
  if (run.c && /^[0-9a-f]{6}$/i.test(run.c)) rpr += `<w:color w:val="${run.c}"/>`;
  if (run.sz) rpr += `<w:sz w:val="${halfPt(run.sz)}"/><w:szCs w:val="${halfPt(run.sz)}"/>`;
  if (run.u) rpr += '<w:u w:val="single"/>';
  if (run.bg && /^[0-9a-f]{6}$/i.test(run.bg)) rpr += `<w:shd w:val="clear" w:color="auto" w:fill="${run.bg}"/>`;
  if (run.rtl) rpr += '<w:rtl/>';
  if (run.extraRPr) rpr += run.extraRPr;
  // Split on tabs: a tab is its own element, never inside <w:t>.
  const parts = String(run.t).split('\t');
  let body = '';
  parts.forEach((part, k) => {
    if (k > 0) body += '<w:tab/>';
    if (part) body += `<w:t xml:space="preserve">${xmlText(part)}</w:t>`;
  });
  if (!body) return '';
  return `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}${body}</w:r>`;
}

// pPr children in the schema's order (Word is strict about it).
function pPrXml(p, sect) {
  let x = '';
  if (p.list === 'bullet') x += '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>';
  if (p.shd && /^[0-9a-f]{6}$/i.test(p.shd)) x += `<w:shd w:val="clear" w:color="auto" w:fill="${p.shd}"/>`;
  if (p.tabs && p.tabs.length) x += `<w:tabs>${p.tabs.map((t) => `<w:tab w:val="left" w:pos="${twip(t)}"/>`).join('')}</w:tabs>`;
  if (p.rtl) x += '<w:bidi/>';
  const sp = [];
  if (p.spaceBefore) sp.push(`w:before="${twip(p.spaceBefore)}"`);
  sp.push('w:after="0"');
  if (p.lineExact) sp.push(`w:line="${twip(p.lineExact)}" w:lineRule="exact"`);
  else sp.push('w:line="240" w:lineRule="auto"');
  x += `<w:spacing ${sp.join(' ')}/>`;
  const ind = [];
  if (p.indentLeft) ind.push(`w:left="${twip(Math.max(0, p.indentLeft))}"`);
  if (p.indentRight) ind.push(`w:right="${twip(Math.max(0, p.indentRight))}"`);
  if (p.indentFirst) {
    if (p.indentFirst < 0) ind.push(`w:hanging="${twip(-p.indentFirst)}"`);
    else ind.push(`w:firstLine="${twip(p.indentFirst)}"`);
  }
  if (ind.length) x += `<w:ind ${ind.join(' ')}/>`;
  if (p.align && p.align !== 'left') x += `<w:jc w:val="${p.align}"/>`;
  if (p.extraPPr) x += p.extraPPr;
  if (sect) x += sect;
  return x ? `<w:pPr>${x}</w:pPr>` : '';
}

function paraXml(p, sect) {
  const brk = p.colBreakAfter ? '<w:r><w:br w:type="column"/></w:r>' : '';
  return `<w:p>${pPrXml(p, sect)}${(p.runs || []).map(runXml).join('')}${brk}</w:p>`;
}

function sectXml(page, seg, type) {
  const m = seg.marginPt;
  const cols = seg.cols > 1 ? `<w:cols w:num="${seg.cols}" w:space="${twip(seg.space || 18)}" w:equalWidth="1"/>` : '';
  return `<w:sectPr>${type ? `<w:type w:val="${type}"/>` : ''}<w:pgSz w:w="${twip(page.widthPt)}" w:h="${twip(page.heightPt)}"/>`
    + `<w:pgMar w:top="${twip(m.top)}" w:right="${twip(m.right)}" w:bottom="${twip(m.bottom)}" w:left="${twip(m.left)}" w:header="0" w:footer="0" w:gutter="0"/>${cols}</w:sectPr>`;
}

// ------------------------------------------------------------- registry ----
const blockWriters = new Map(); // kind -> { fn, carriesSect }
const anchorWriters = new Map(); // kind -> fn
const extraParts = [];
const extraStyles = [];
const extraNumbering = [];
const extraMediaTypes = new Map();

export function registerBlock(kind, fn, opts) { blockWriters.set(kind, { fn, carriesSect: !!(opts && opts.carriesSect) }); }
export function registerAnchor(kind, fn) { anchorWriters.set(kind, fn); }
export function registerPart(part) {
  const at = extraParts.findIndex((p) => p.path === part.path);
  if (at >= 0) extraParts[at] = part; else extraParts.push(part);
}
export function registerStyle(xml) { if (!extraStyles.includes(xml)) extraStyles.push(xml); }
export function registerNumbering(n) { if (!extraNumbering.some((e) => e.abstractNum === n.abstractNum)) extraNumbering.push(n); }
export function registerMediaType(ext, contentType) { extraMediaTypes.set(ext, contentType); }

const MEDIA_EXT = { png: 'png', jpeg: 'jpeg', jpg: 'jpeg' };

// ------------------------------------------------------ the built-in 'img' ----
// Anchored (b.anchor): a <w:r> absolute on the page, behind the text. Block-level:
// a <w:p> with an inline picture.
function imgXml(b, w, sect) {
  const m = w.addMedia(b.bytes, b.ext);
  const cx = emu(b.wPt);
  const cy = emu(b.hPt);
  const id = w.nextId();
  const crop = b.crop ? `<a:srcRect l="${Math.round(b.crop.l * 100000)}" t="${Math.round(b.crop.t * 100000)}" r="${Math.round(b.crop.r * 100000)}" b="${Math.round(b.crop.b * 100000)}"/>` : '';
  const graphic = '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
    + `<pic:nvPicPr><pic:cNvPr id="${id}" name="${m.name}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${m.rid}"/>${crop}<a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
    + '</pic:pic></a:graphicData></a:graphic>';
  if (b.anchor) {
    // Absolute on the page, behind the text.
    return `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${id}" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">`
      + '<wp:simplePos x="0" y="0"/>'
      + `<wp:positionH relativeFrom="page"><wp:posOffset>${emu(b.anchor.x)}</wp:posOffset></wp:positionH>`
      + `<wp:positionV relativeFrom="page"><wp:posOffset>${emu(b.anchor.y)}</wp:posOffset></wp:positionV>`
      + `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>`
      + `<wp:docPr id="${id}" name="Picture ${id}"/><wp:cNvGraphicFramePr/>${graphic}</wp:anchor></w:drawing></w:r>`;
  }
  const drawing = `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>`
    + `<wp:docPr id="${id}" name="Picture ${id}"/><wp:cNvGraphicFramePr/>${graphic}</wp:inline></w:drawing></w:r>`;
  return `<w:p>${pPrXml({ align: b.align, indentLeft: b.indentLeft, spaceBefore: b.spaceBefore }, sect)}${drawing}</w:p>`;
}
registerBlock('p', (b, w, sect) => paraXml(b, sect), { carriesSect: true });
registerBlock('img', imgXml, { carriesSect: true });
registerAnchor('img', imgXml);

export function buildDocx(doc, deps) {
  const { fflate } = deps;
  const media = []; // { name, bytes, rid }
  const mediaByBytes = new Map();
  const rels = []; // { id, type, target } beyond styles/numbering/media
  let docPrId = 1;
  const extraNs = new Map();

  const w = {
    fflate,
    doc,
    ext: {},
    esc: xmlText,
    attr: xmlAttr,
    twip,
    emu,
    halfPt,
    paraXml,
    runXml,
    pPrXml,
    nextId: () => docPrId++,
    useNamespace: (prefix, uri) => { extraNs.set(prefix, uri); },
    addMedia(bytes, extIn) {
      let m = mediaByBytes.get(bytes);
      if (!m) {
        const n = media.length + 1;
        const ext = MEDIA_EXT[extIn] || (extraMediaTypes.has(extIn) ? extIn : 'png');
        m = { name: `image${n}.${ext}`, bytes, rid: `rIdImg${n}` };
        media.push(m);
        mediaByBytes.set(bytes, m);
      }
      return m;
    },
    addRel(type, target) {
      const id = `rIdX${rels.length + 1}`;
      rels.push({ id, type, target });
      return id;
    },
  };

  const blockXml = (b, sect) => {
    const bw = blockWriters.get(b.kind);
    if (!bw) throw new Error(`docx writer: no writer registered for block kind "${b.kind}" (import the module that registers it)`);
    return bw.fn(b, w, sect);
  };

  let body = '';
  const fallbackSeg = { cols: 1, space: 0, marginPt: { top: 56, right: 56, bottom: 56, left: 56 }, blocks: [] };
  const pages = doc.pages.length ? doc.pages : [{ widthPt: 595, heightPt: 842, segments: [fallbackSeg], anchors: [] }];
  let lastSect = '';
  pages.forEach((page, pi) => {
    const segments = page.segments && page.segments.length ? page.segments : [fallbackSeg];
    // Absolute (page-anchored) objects ride in the page's first paragraph, so
    // they cost no vertical space.
    const anchorRuns = (page.anchors || []).map((b) => {
      const aw = anchorWriters.get(b.kind);
      if (!aw) throw new Error(`docx writer: no anchor writer registered for kind "${b.kind}" (import the module that registers it)`);
      return { xml: aw(b, w) };
    });
    segments.forEach((seg, si) => {
      const type = si === 0 ? (pi > 0 ? 'nextPage' : null) : 'continuous';
      const sect = sectXml(page, seg, type);
      lastSect = sect;
      const blocks = seg.blocks.slice();
      if (si === 0 && anchorRuns.length) {
        if (blocks.length && blocks[0].kind === 'p') blocks[0] = { ...blocks[0], runs: anchorRuns.concat(blocks[0].runs || []) };
        else blocks.unshift({ kind: 'p', runs: anchorRuns, lineExact: 1 });
      }
      // The section break lives in the LAST paragraph of the segment. A segment
      // that ends in a block that cannot carry it (a table, or nothing) gets a
      // 1pt carrier paragraph.
      const last = blocks[blocks.length - 1];
      const lw = last && blockWriters.get(last.kind);
      if (!last || !(lw && lw.carriesSect)) blocks.push({ kind: 'p', runs: [], lineExact: 1 });
      blocks.forEach((b, k) => {
        body += blockXml(b, k === blocks.length - 1 ? sect : '');
      });
    });
  });
  // The last section's properties must be the body's own sectPr, not a
  // paragraph's: swap the final paragraph-level one for a body-level one.
  const at = body.lastIndexOf(lastSect);
  body = body.slice(0, at) + body.slice(at + lastSect.length);
  body = body.replace(/<w:pPr><\/w:pPr>/g, '');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}${[...extraNs].map(([p, u]) => ` xmlns:${p}="${u}"`).join('')}><w:body>${body}${lastSect}</w:body></w:document>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}>`
    + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="id-ID"/></w:rPr></w:rPrDefault>'
    + '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    + `${extraStyles.join('')}</w:styles>`;

  // abstractNum elements must all precede the num elements (schema order).
  const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${NS}>`
    + '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/><w:lvlJc w:val="left"/>'
    + '<w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/></w:rPr></w:lvl></w:abstractNum>'
    + `${extraNumbering.map((n) => n.abstractNum).join('')}`
    + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
    + `${extraNumbering.map((n) => n.num).join('')}</w:numbering>`;

  // Extra parts last: they may read state the body pass left in w.ext.
  const parts = [];
  for (const p of extraParts) {
    const content = p.build(w);
    if (content === null || content === undefined) continue;
    const entry = { path: p.path, contentType: p.contentType, content, rel: p.rel };
    if (p.rel) entry.rid = p.rel.root ? `rIdP${parts.length + 3}` : w.addRel(p.rel.type, p.path.replace(/^word\//, ''));
    parts.push(entry);
  }

  const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>'
    + [...extraMediaTypes].map(([e, t]) => `<Default Extension="${e}" ContentType="${t}"/>`).join('')
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + parts.map((p) => `<Override PartName="/${p.path}" ContentType="${p.contentType}"/>`).join('')
    + '</Types>';

  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    + parts.filter((p) => p.rel && p.rel.root).map((p) => `<Relationship Id="${p.rid}" Type="${p.rel.type}" Target="${p.path}"/>`).join('')
    + '</Relationships>';

  const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rIdSt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '<Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
    + media.map((m) => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join('')
    + rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`).join('')
    + '</Relationships>';

  const core = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
    + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + `<dc:title>${xmlText(doc.title || '')}</dc:title><dc:creator>PDFLokal</dc:creator></cp:coreProperties>`;

  const enc = fflate.strToU8;
  // [Content_Types].xml first, as Word expects. Media are already compressed
  // (PNG/JPEG): store them (level 0) and deflate the XML.
  const files = {
    '[Content_Types].xml': [enc(types), { level: 6 }],
    '_rels/.rels': [enc(rootRels), { level: 6 }],
    'word/document.xml': [enc(documentXml), { level: 6 }],
    'word/_rels/document.xml.rels': [enc(docRels), { level: 6 }],
    'word/styles.xml': [enc(stylesXml), { level: 6 }],
    'word/numbering.xml': [enc(numberingXml), { level: 6 }],
    'docProps/core.xml': [enc(core), { level: 6 }],
  };
  for (const p of parts) files[p.path] = [typeof p.content === 'string' ? enc(p.content) : p.content, { level: 6 }];
  for (const m of media) files[`word/media/${m.name}`] = [m.bytes, { level: 0 }];
  return fflate.zipSync(files);
}
