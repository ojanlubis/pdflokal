/*
 * docx/writer.js: the OOXML writer and its registry. No pdf.js here: models in, bytes out.
 * Every package is checked by two witnesses that do not share the writer's code
 * (scripts/lib/docx-xml.mjs: well-formedness + package integrity), and those witnesses are
 * themselves shown to go red on a broken package.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDocx, registerBlock, registerAnchor, registerPart, registerStyle, registerNumbering, registerMediaType, xmlText } from '../../js/docx/writer.js';
import '../../js/docx/tables.js';
import '../../js/docx/color.js';
import { makeDoc, makePage, makePara, makeSegment, validateModel } from '../../js/docx/model.js';
import { encodePng } from '../../js/docx/png.js';
import { loadLibs, unzip, packageIsClean, paragraphsOf, docText } from './docx-helpers.mjs';
import { xmlProblems, packageProblems } from '../../scripts/lib/docx-xml.mjs';

const { fflate } = loadLibs();
const build = (doc) => {
  assert.deepEqual(validateModel(doc), [], 'the test model itself must be valid');
  const files = unzip(buildDocx(doc, { fflate }));
  assert.deepEqual(packageIsClean(files), [], 'package must be clean');
  return { files, xml: fflate.strFromU8(files['word/document.xml']), str: (n) => fflate.strFromU8(files[n]) };
};
const onePage = (blocks, over) => makePage({ segments: [makeSegment({ blocks })], ...over });
const png = (n = 200) => encodePng(fflate, 2, 2, 3, new Uint8Array(12).fill(n));

test('writer: text is escaped and XML-illegal characters are dropped, not written', () => {
  const { xml } = build(makeDoc([onePage([makePara('a < b & c > d \u0001\u000B end')])]));
  assert.match(xml, /a &lt; b &amp; c &gt; d  end/);
  assert.equal(xmlText('x￾y\uD800z'), 'xyz');
});

test('writer: run formatting lands in rPr in schema order; tabs are elements, not characters', () => {
  const { xml } = build(makeDoc([onePage([{ kind: 'p', runs: [{ t: 'A\tB', f: 'Arial', b: true, i: true, c: 'FF8800', sz: 10.5, u: true, bg: 'FFFF00' }] }])]));
  const rpr = xml.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/)[1];
  const order = ['<w:rFonts', '<w:b/>', '<w:i/>', '<w:color w:val="FF8800"/>', '<w:sz w:val="21"/>', '<w:u ', '<w:shd '].map((t) => rpr.indexOf(t));
  assert.ok(order.every((x) => x >= 0), `all present: ${order}`);
  assert.deepEqual(order, order.slice().sort((a, b) => a - b), 'schema order');
  assert.match(xml, /<w:t xml:space="preserve">A<\/w:t><w:tab\/><w:t xml:space="preserve">B<\/w:t>/);
});

test('writer: an invalid colour is ignored rather than written into the XML', () => {
  // validateModel would flag this; the writer is the hot path and must still not emit it
  const files = unzip(buildDocx(makeDoc([onePage([{ kind: 'p', runs: [{ t: 'x', c: 'red' }] }])]), { fflate }));
  assert.doesNotMatch(fflate.strFromU8(files['word/document.xml']), /w:color/);
});

test('writer: paragraph properties: bullet, indent, hanging, alignment, shading, exact line height', () => {
  const { xml } = build(makeDoc([onePage([
    makePara('item', { list: 'bullet', indentLeft: 18, indentFirst: -18 }),
    makePara('mid', { align: 'center', shd: 'DDEEFF', lineExact: 14, spaceBefore: 6 }),
  ])]));
  assert.match(xml, /<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="1"\/><\/w:numPr>/);
  assert.match(xml, /<w:ind w:left="360" w:hanging="360"\/>/);
  assert.match(xml, /<w:jc w:val="center"\/>/);
  assert.match(xml, /<w:shd w:val="clear" w:color="auto" w:fill="DDEEFF"\/>/);
  assert.match(xml, /w:before="120" w:after="0" w:line="280" w:lineRule="exact"/);
});

test('writer: one section per page carries that page\'s own size; the last is the body\'s', () => {
  const { xml } = build(makeDoc([
    onePage([makePara('a4')], { widthPt: 595, heightPt: 842 }),
    onePage([makePara('letter')], { widthPt: 612, heightPt: 792 }),
  ]));
  assert.equal((xml.match(/<w:sectPr>/g) || []).length, 2);
  assert.match(xml, /<w:pgSz w:w="11900" w:h="16840"\/>/);
  assert.match(xml, /<w:type w:val="nextPage"\/><w:pgSz w:w="12240" w:h="15840"\/>/);
  assert.ok(xml.endsWith('</w:sectPr></w:body></w:document>'), 'final sectPr is a child of w:body');
  assert.doesNotMatch(xml.slice(0, xml.lastIndexOf('<w:sectPr>')).slice(-400), /w:sectPr><\/w:body>/);
});

test('writer: a column band is a continuous section with equal columns', () => {
  const { xml } = build(makeDoc([makePage({ segments: [
    makeSegment({ blocks: [makePara('title')] }),
    makeSegment({ cols: 2, space: 18, blocks: [makePara('left', { colBreakAfter: true }), makePara('right')] }),
  ] })]));
  assert.match(xml, /<w:type w:val="continuous"\/>/);
  assert.match(xml, /<w:cols w:num="2" w:space="360" w:equalWidth="1"\/>/);
  assert.match(xml, /<w:br w:type="column"\/>/);
});

test('writer: inline and anchored images share one media part when the bytes are the same object', () => {
  const bytes = png();
  const { files, xml } = build(makeDoc([onePage([{ kind: 'img', bytes, ext: 'png', wPt: 40, hPt: 30 }], {
    anchors: [{ kind: 'img', bytes, ext: 'png', wPt: 20, hPt: 20, anchor: { x: 10, y: 12 }, crop: { l: 0.1, t: 0, r: 0, b: 0.2 } }],
  })]));
  assert.deepEqual(Object.keys(files).filter((n) => n.startsWith('word/media/')), ['word/media/image1.png']);
  assert.match(xml, /<wp:inline /);
  assert.match(xml, /<wp:anchor [^>]*behindDoc="1"/);
  assert.match(xml, /<wp:posOffset>127000<\/wp:posOffset>/); // x = 10pt
  assert.match(xml, /<a:srcRect l="10000" t="0" r="0" b="20000"\/>/);
});

test('writer: different image bytes are different media; a jpeg gets its own content type', () => {
  const { files, str } = build(makeDoc([onePage([
    { kind: 'img', bytes: png(10), ext: 'png', wPt: 10, hPt: 10 },
    { kind: 'img', bytes: png(20), ext: 'jpeg', wPt: 10, hPt: 10 },
  ])]));
  assert.deepEqual(Object.keys(files).filter((n) => n.startsWith('word/media/')).sort(), ['word/media/image1.png', 'word/media/image2.jpeg']);
  assert.match(str('[Content_Types].xml'), /Extension="jpeg" ContentType="image\/jpeg"/);
});

test('writer: no pages still gives a valid one-section document', () => {
  const { xml } = build({ title: 'kosong', pages: [] });
  assert.equal((xml.match(/<w:sectPr>/g) || []).length, 1);
});

test('writer: the title lands in core properties, escaped', () => {
  const { str } = build({ title: 'A & B', pages: [makePage()] });
  assert.match(str('docProps/core.xml'), /<dc:title>A &amp; B<\/dc:title>/);
});

test('writer: a table is a w:tbl with a grid, spans and cell shading; a segment ending in a table gets a carrier paragraph', () => {
  const t = { kind: 'tbl', colsPt: [100, 50, 50], border: true, spaceBefore: 8, rows: [
    [{ blocks: [makePara('Nama')], fill: 'D9E2F3' }, { blocks: [makePara('Qty')] }, { blocks: [makePara('Harga')] }],
    [{ blocks: [makePara('total')], span: 2 }, { blocks: [makePara('9')] }],
  ] };
  const { xml } = build(makeDoc([onePage([t])]));
  assert.match(xml, /<w:tblGrid><w:gridCol w:w="2000"\/><w:gridCol w:w="1000"\/><w:gridCol w:w="1000"\/><\/w:tblGrid>/);
  assert.match(xml, /<w:gridSpan w:val="2"\/>/);
  assert.match(xml, /<w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"\/>/);
  assert.match(xml, /<w:tblBorders>/);
  assert.ok(xml.indexOf('</w:tbl>') < xml.indexOf('<w:sectPr>') || xml.endsWith('</w:sectPr></w:body></w:document>'));
  assert.ok(paragraphsOf(xml).length >= 7, 'five cell paragraphs plus the spacer and the carrier');
  assert.deepEqual(docText(xml).filter(Boolean), ['Nama', 'Qty', 'Harga', 'total', '9']);
});

test('writer registry: a module can add a block kind, an anchor kind, a part, a style, a numbering and a media type without touching the writer', () => {
  registerBlock('test-note', (b, w) => w.paraXml({ kind: 'p', runs: [{ t: `NOTE:${b.text}` }] }), { carriesSect: false });
  registerAnchor('test-badge', (a, w) => `<w:r><w:t>${w.esc(`badge ${w.nextId()}`)}</w:t></w:r>`);
  registerStyle('<w:style w:type="paragraph" w:styleId="TestStyle"><w:name w:val="TestStyle"/></w:style>');
  registerNumbering({ abstractNum: '<w:abstractNum w:abstractNumId="7"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum>', num: '<w:num w:numId="7"><w:abstractNumId w:val="7"/></w:num>' });
  registerMediaType('gif', 'image/gif');
  registerPart({
    path: 'word/settings.xml',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml',
    rel: { type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings' },
    build: (w) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:zoom w:percent="${w.ext.zoom || 100}"/></w:settings>`,
  });
  const { xml, str } = build({ pages: [onePage([{ kind: 'test-note', text: 'hi' }], { anchors: [{ kind: 'test-badge' }] })] });
  assert.ok(docText(xml).some((t) => t.includes('NOTE:hi')));
  assert.match(xml, /badge 1/);
  assert.match(str('word/styles.xml'), /TestStyle/);
  const num = str('word/numbering.xml');
  assert.ok(num.indexOf('abstractNumId="7"') < num.indexOf('<w:num w:numId="1">'), 'abstractNum elements precede num elements');
  assert.match(str('word/settings.xml'), /w:percent="100"/);
  assert.match(str('[Content_Types].xml'), /PartName="\/word\/settings.xml"/);
  assert.match(str('[Content_Types].xml'), /Extension="gif"/);
  assert.match(str('word/_rels/document.xml.rels'), /Target="settings.xml"/);
});

test('writer registry: a part can opt out by returning null; an unregistered kind is a loud error, not a silent drop', () => {
  registerPart({ path: 'word/never.xml', contentType: 'application/xml', rel: { type: 'urn:never' }, build: () => null });
  const { files } = build(makeDoc([onePage([makePara('x')])]));
  assert.ok(!files['word/never.xml']);
  assert.throws(() => buildDocx({ pages: [onePage([{ kind: 'no-such-kind' }])] }, { fflate }), /no writer registered for block kind "no-such-kind"/);
  assert.throws(() => buildDocx({ pages: [onePage([], { anchors: [{ kind: 'no-such-anchor' }] })] }, { fflate }), /no anchor writer registered/);
});

test('writer: shapes (colour lane) declare their namespace only in documents that use one', () => {
  const plain = build(makeDoc([onePage([makePara('x')])]));
  assert.doesNotMatch(plain.xml, /xmlns:wps/);
  const shaped = build(makeDoc([onePage([makePara('x')], { anchors: [{ kind: 'shape', x: 0, y: 0, wPt: 595, hPt: 842, fill: 'FFF2CC' }, { kind: 'shape', x: 10, y: 10, wPt: 50, hPt: 20, fill: '123456', stroke: { c: '000000', wPt: 1 } }] })]));
  assert.match(shaped.xml, /xmlns:wps="http:\/\/schemas.microsoft.com\/office\/word\/2010\/wordprocessingShape"/);
  assert.match(shaped.xml, /<a:srgbClr val="FFF2CC"\/>/);
  assert.equal((shaped.xml.match(/<wps:wsp>/g) || []).length, 2);
});

test('writer: ids are unique across drawings (Word rejects a repeated docPr id)', () => {
  const { xml } = build(makeDoc([onePage([{ kind: 'img', bytes: png(1), ext: 'png', wPt: 5, hPt: 5 }], { anchors: [
    { kind: 'img', bytes: png(2), ext: 'png', wPt: 5, hPt: 5, anchor: { x: 0, y: 0 } },
    { kind: 'shape', x: 0, y: 0, wPt: 5, hPt: 5, fill: '000000' },
  ] })]));
  const ids = [...xml.matchAll(/<wp:docPr id="(\d+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3);
});

// ---- the witnesses themselves --------------------------------------------------
test('witnesses: the package checker goes red on a missing media part, a missing relationship target and a missing content type', () => {
  const good = unzip(buildDocx(makeDoc([onePage([{ kind: 'img', bytes: png(5), ext: 'png', wPt: 5, hPt: 5 }])]), { fflate }));
  assert.deepEqual(packageProblems(good), []);
  const noMedia = { ...good }; delete noMedia['word/media/image1.png'];
  assert.match(packageProblems(noMedia).join('\n'), /missing part word\/media\/image1.png/);
  const noCt = { ...good, 'word/stray.bin': new Uint8Array([1]) };
  assert.match(packageProblems(noCt).join('\n'), /stray.bin has no content type/);
  const badRid = { ...good, 'word/document.xml': new TextEncoder().encode(fflate.strFromU8(good['word/document.xml']).replace('r:embed="rIdImg1"', 'r:embed="rIdNope"')) };
  assert.match(packageProblems(badRid).join('\n'), /unknown relationship rIdNope/);
});

test('witnesses: the XML checker goes red on what the writer must never produce', () => {
  for (const bad of ['<w:p><w:r></w:p>', '<a x=1/>', '<a>&nbsp;</a>', '<a>\u0003</a>', '<w:p xmlns:w="u"></w:p><w:p xmlns:w="u"></w:p>', '<x:a/>']) {
    assert.ok(xmlProblems(bad).length > 0, `should flag ${JSON.stringify(bad)}`);
  }
});
