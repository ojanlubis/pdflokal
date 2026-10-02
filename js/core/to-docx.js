/*
 * PDFLokal — core/to-docx.js  (SPIKE 2026-10-02: PDF -> .docx, the WRITER half)
 * ============================================================================
 * Pure: a neutral document model in, the bytes of a valid .docx out. No DOM, no
 * pdf.js, no network. The zip comes from the vendored fflate, INJECTED as
 * `deps.fflate` (the same convention as core/export-images.js): the browser
 * passes window.fflate from ensureFflate(), node passes the same file loaded as
 * UMD. fflate is already shipped for the images-ZIP path, so this adds ZERO new
 * dependency and no hand-rolled zip.
 *
 * The extraction half (pdf.js text/images -> this model) is core/pdf-to-docx.js.
 *
 * MODEL
 *   doc   = { title?, pages: Page[] }
 *   Page  = { widthPt, heightPt, marginPt: {top,right,bottom,left}, blocks: Block[] }
 *   Block = Para | Img | Table
 *   Para  = { kind:'p', runs: Run[], align?: 'left'|'center'|'right'|'both',
 *             indentLeft?, indentFirst? (pt, negative = hanging), spaceBefore?,
 *             lineExact? (pt), list?: 'bullet', rtl?, tabs?: number[] (pt from
 *             the left margin) }
 *   Run   = { t: string ('\t' = tab), b?, i?, u?, sz? (pt), f? (family), c? (hex) }
 *   Img   = { kind:'img', bytes: Uint8Array, ext: 'png'|'jpeg', wPt, hPt,
 *             align?, indentLeft?, spaceBefore? }
 *   Table = { kind:'tbl', colsPt: number[], rows: Cell[][], border?: boolean }
 *   Cell  = { blocks: Para[] }
 *
 * One section per PDF page: that is what carries each page's own size and
 * margins and gives the page break between PDF pages.
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
// eslint-disable-next-line no-control-regex -- stripping XML-illegal control characters is the point
const BAD_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export function xmlText(s) {
  return String(s).replace(BAD_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const xmlAttr = (s) => xmlText(s).replace(/"/g, '&quot;');

function runXml(run) {
  let rpr = '';
  if (run.f) rpr += `<w:rFonts w:ascii="${xmlAttr(run.f)}" w:hAnsi="${xmlAttr(run.f)}" w:cs="${xmlAttr(run.f)}" w:eastAsia="${xmlAttr(run.f)}"/>`;
  if (run.b) rpr += '<w:b/><w:bCs/>';
  if (run.i) rpr += '<w:i/><w:iCs/>';
  if (run.c && /^[0-9a-f]{6}$/i.test(run.c)) rpr += `<w:color w:val="${run.c}"/>`;
  if (run.sz) rpr += `<w:sz w:val="${halfPt(run.sz)}"/><w:szCs w:val="${halfPt(run.sz)}"/>`;
  if (run.u) rpr += '<w:u w:val="single"/>';
  if (run.rtl) rpr += '<w:rtl/>';
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
  if (sect) x += sect;
  return x ? `<w:pPr>${x}</w:pPr>` : '';
}

function paraXml(p, sect) {
  return `<w:p>${pPrXml(p, sect)}${(p.runs || []).map(runXml).join('')}</w:p>`;
}

function sectXml(page) {
  const m = page.marginPt;
  return `<w:sectPr><w:pgSz w:w="${twip(page.widthPt)}" w:h="${twip(page.heightPt)}"/>`
    + `<w:pgMar w:top="${twip(m.top)}" w:right="${twip(m.right)}" w:bottom="${twip(m.bottom)}" w:left="${twip(m.left)}" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>`;
}

function tableXml(t) {
  const border = t.border
    ? '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="808080"/>`).join('') + '</w:tblBorders>'
    : '';
  let x = `<w:tbl><w:tblPr><w:tblW w:w="${twip(t.colsPt.reduce((a, b) => a + b, 0))}" w:type="dxa"/>${border}<w:tblLayout w:type="fixed"/>`
    + '<w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="40" w:type="dxa"/></w:tblCellMar></w:tblPr>';
  x += `<w:tblGrid>${t.colsPt.map((c) => `<w:gridCol w:w="${twip(c)}"/>`).join('')}</w:tblGrid>`;
  for (const row of t.rows) {
    x += '<w:tr>';
    row.forEach((cell, k) => {
      const paras = cell.blocks && cell.blocks.length ? cell.blocks : [{ kind: 'p', runs: [] }];
      x += `<w:tc><w:tcPr><w:tcW w:w="${twip(t.colsPt[k] || 0)}" w:type="dxa"/>${cell.span > 1 ? `<w:gridSpan w:val="${cell.span}"/>` : ''}</w:tcPr>${paras.map((p) => paraXml(p)).join('')}</w:tc>`;
    });
    x += '</w:tr>';
  }
  return x + '</w:tbl>';
}

export function buildDocx(doc, deps) {
  const { fflate } = deps;
  const media = []; // { name, bytes, rid }
  let docPrId = 1;

  const mediaByBytes = new Map();
  const imgParaXml = (b, sect) => {
    let m = mediaByBytes.get(b.bytes);
    if (!m) {
      const n = media.length + 1;
      const ext = b.ext === 'jpeg' ? 'jpeg' : 'png';
      m = { name: `image${n}.${ext}`, bytes: b.bytes, rid: `rIdImg${n}` };
      media.push(m);
      mediaByBytes.set(b.bytes, m);
    }
    const cx = emu(b.wPt);
    const cy = emu(b.hPt);
    const id = docPrId++;
    const graphic = '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
      + `<pic:nvPicPr><pic:cNvPr id="${id}" name="${m.name}"/><pic:cNvPicPr/></pic:nvPicPr>`
      + `<pic:blipFill><a:blip r:embed="${m.rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
      + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>`
      + '</pic:pic></a:graphicData></a:graphic>';
    let drawing;
    if (b.anchor) {
      // Behind the text, absolute on the page: used for images the text sits on.
      drawing = `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="${id}" behindDoc="1" locked="0" layoutInCell="1" allowOverlap="1">`
        + '<wp:simplePos x="0" y="0"/>'
        + `<wp:positionH relativeFrom="page"><wp:posOffset>${emu(b.anchor.x)}</wp:posOffset></wp:positionH>`
        + `<wp:positionV relativeFrom="page"><wp:posOffset>${emu(b.anchor.y)}</wp:posOffset></wp:positionV>`
        + `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>`
        + `<wp:docPr id="${id}" name="Picture ${id}"/><wp:cNvGraphicFramePr/>${graphic}</wp:anchor></w:drawing></w:r>`;
      return `<w:p>${pPrXml({ lineExact: 1 }, sect)}${drawing}</w:p>`;
    }
    drawing = `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>`
      + `<wp:docPr id="${id}" name="Picture ${id}"/><wp:cNvGraphicFramePr/>${graphic}</wp:inline></w:drawing></w:r>`;
    return `<w:p>${pPrXml({ align: b.align, indentLeft: b.indentLeft, spaceBefore: b.spaceBefore }, sect)}${drawing}</w:p>`;
  };

  let body = '';
  const pages = doc.pages.length ? doc.pages : [{ widthPt: 595, heightPt: 842, marginPt: { top: 56, right: 56, bottom: 56, left: 56 }, blocks: [] }];
  for (const page of pages) {
    const sect = sectXml(page);
    const blocks = page.blocks.slice();
    // The section break lives in the LAST paragraph of the page. A page that
    // ends in a table (or is empty) gets a 1pt carrier paragraph.
    const last = blocks[blocks.length - 1];
    if (!last || last.kind === 'tbl') blocks.push({ kind: 'p', runs: [], lineExact: 1 });
    blocks.forEach((b, k) => {
      const s = k === blocks.length - 1 ? sect : '';
      if (b.kind === 'img') body += imgParaXml(b, s);
      else if (b.kind === 'tbl') body += tableXml(b);
      else body += paraXml(b, s);
    });
  }
  // The last page's section properties must be the body's own sectPr, not a
  // paragraph's: swap the final paragraph-level one for a body-level one.
  const lastSect = sectXml(pages[pages.length - 1]);
  const at = body.lastIndexOf(lastSect);
  body = body.slice(0, at) + body.slice(at + lastSect.length);
  body = body.replace(/<w:pPr><\/w:pPr>/g, '');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}${lastSect}</w:body></w:document>`;

  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${NS}>`
    + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="id-ID"/></w:rPr></w:rPrDefault>'
    + '<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>';

  const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${NS}>`
    + '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/><w:lvlJc w:val="left"/>'
    + '<w:pPr><w:ind w:left="360" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/></w:rPr></w:lvl></w:abstractNum>'
    + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>';

  const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '</Types>';

  const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>';

  const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rIdSt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '<Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
    + media.map((m) => `<Relationship Id="${m.rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${m.name}"/>`).join('')
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
  for (const m of media) files[`word/media/${m.name}`] = [m.bytes, { level: 0 }];
  return fflate.zipSync(files);
}

// ---------------------------------------------------------------------------
// PNG encoder (no canvas, so it runs headless and in a worker). RGBA/RGB/gray
// 8-bit, one IDAT, filter 0. In a browser the caller can swap in a canvas JPEG
// encoder through the extractor's `encodeImage` hook; this is the portable
// default and the one the node harness measures.
// ---------------------------------------------------------------------------
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export function encodePng(fflate, width, height, channels, data) {
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = fflate.zlibSync(raw, { level: 6 });
  const colorType = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  const chunk = (type, payload) => {
    const out = new Uint8Array(12 + payload.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, payload.length);
    for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
    out.set(payload, 8);
    dv.setUint32(8 + payload.length, crc32(out.subarray(4, 8 + payload.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const png = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { png.set(p, off); off += p.length; }
  return png;
}
