/*
 * scripts/lib/docx-validate.mjs: the validator proves it can go red.
 * A known-good package (built by the writer, every feature the checks look at) is broken one way at a time. Each
 * mutation states which layer must catch it: STRICT (pure JS, always runs) and XSD (xmllint + the pinned Ecma/OPC/wps
 * schemas, runs when they can be fetched). The table is also the honest map of what each layer can NOT see: an
 * `xsd: false` row is a measured gap in the schema (rPr order is an unordered choice in the transitional XSD; a cell ending
 * in a table, a grid/gridSpan mismatch, a repeated docPr id are all schema-valid), covered by the strict layer instead.
 * Without the schemas the XSD rows are skipped LOUDLY; set DOCX_REQUIRE_XSD=1 (or CI) to make that a failure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { loadLibs } from './docx-helpers.mjs';
import { buildFixtureDocx, validateDocx, structureProblems, xsdProblems, zipProblems, xmllintAvailable, parseXml, crc32 } from '../../scripts/lib/docx-validate.mjs';
import { ensureSchemas } from '../../scripts/lib/ooxml-schemas.mjs';

const { fflate } = loadLibs();
const enc = (s) => fflate.strToU8(s);
const dec = (u) => fflate.strFromU8(u);
const requireXsd = !!(process.env.DOCX_REQUIRE_XSD || process.env.CI);

let schema = null;
let schemaWhy = '';
if (!xmllintAvailable()) schemaWhy = 'xmllint is not installed';
else { try { schema = await ensureSchemas(); } catch (e) { schemaWhy = String(e.message).split('\n')[0]; } }
if (!schema) {
  console.log(`# SKIP (loud): XSD validation rows not run: ${schemaWhy}`);
  if (requireXsd) throw new Error(`XSD validation required (CI / DOCX_REQUIRE_XSD) but unavailable: ${schemaWhy}`);
}
const scratch = path.join(os.tmpdir(), `docx-validate-test-${process.pid}`);

const fixture = await buildFixtureDocx(fflate);
const base = fflate.unzipSync(fixture);
const doc0 = dec(base['word/document.xml']);

const variant = (edit) => { const f = { ...base }; edit(f); return f; };
const edit = (part, from, to) => (f) => {
  const t = dec(f[part]);
  assert.ok(t.includes(from), `fixture no longer contains ${from.slice(0, 60)}: update the mutation`);
  f[part] = enc(t.replace(from, to));
};
const strictOf = (files) => structureProblems(files).problems;

test('validate: the known-good fixture passes every layer, and contains what the mutations need', () => {
  for (const needle of ['<w:tbl>', '<wps:wsp>', '<wp:inline', '<w:numPr>', '<w:cols ', 'w:gridSpan', 'w:fill="D9E2F3"']) assert.ok(doc0.includes(needle), needle);
  assert.deepEqual(zipProblems(fixture), []);
  assert.deepEqual(strictOf(base), []);
  if (schema) assert.deepEqual(xsdProblems(base, schema, scratch), []);
  const v = validateDocx(fixture, { fflate, schema, scratch });
  assert.deepEqual([v.problems, v.xsdProblems || []], [[], []]);
});

const D = 'word/document.xml';
const CASES = [
  // [name, mutation, strict goes red, xsd goes red]
  ['rPr children swapped (the schema treats rPr as an unordered choice: a measured gap)', edit(D, '<w:rPr><w:b/><w:bCs/><w:color w:val="C00000"/>', '<w:rPr><w:color w:val="C00000"/><w:b/><w:bCs/>'), true, false],
  ['rPr repeats a child', edit(D, '<w:b/><w:bCs/><w:color', '<w:b/><w:b/><w:bCs/><w:color'), true, false],
  ['pPr: jc before spacing', edit(D, '<w:spacing w:before="120" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/>', '<w:jc w:val="center"/><w:spacing w:before="120" w:after="0" w:line="240" w:lineRule="auto"/>'), true, true],
  ['tcPr: shd before tcW', edit(D, '<w:tcW w:w="3000" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/>', '<w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/><w:tcW w:w="3000" w:type="dxa"/>'), true, true],
  ['tblPr: tblLayout before tblBorders', edit(D, '<w:tblLayout w:type="fixed"/>', '<w:tblLayoutX/>'), true, true],
  ['sectPr: pgMar before pgSz', edit(D, '<w:pgSz w:w="11900" w:h="16840"/><w:pgMar w:top="720" w:right="720" w:bottom="0" w:left="720" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body>', '<w:pgMar w:top="720" w:right="720" w:bottom="0" w:left="720" w:header="0" w:footer="0" w:gutter="0"/><w:pgSz w:w="11900" w:h="16840"/></w:sectPr></w:body>'), true, true],
  ['a stray element in w:body (schema-only: the strict layer does not list body children)', edit(D, '<w:body>', '<w:body><w:bogus/>'), false, true],
  ['a cell ends with a nested table (valid per the schema, corrupt in Word)', edit(D, 'Gabungan</w:t></w:r></w:p></w:tc>', 'Gabungan</w:t></w:r></w:p><w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="100"/></w:tblGrid><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl></w:tc>'), true, false],
  ['a cell with no paragraph (the schema allows it: EG_BlockLevelElts is a choice that can match nothing)', edit(D, '<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>', '<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr></w:tc><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>'), true, false],
  ['a table with no tblGrid', edit(D, '<w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>', ''), true, true],
  ['a row wider than the grid (gridSpan 3 of 2)', edit(D, '<w:gridSpan w:val="2"/>', '<w:gridSpan w:val="3"/>'), true, false],
  ['a row narrower than the grid', edit(D, '<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:gridSpan w:val="2"/></w:tcPr>', '<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>'), true, false],
  ['wp:docPr id reused', edit(D, '<wp:docPr id="2" name="Picture 2"/>', '<wp:docPr id="1" name="Picture 2"/>'), true, false],
  ['wp:extent of zero', edit(D, '<wp:extent cx="508000" cy="508000"/>', '<wp:extent cx="0" cy="508000"/>'), true, false],
  ['a paragraph after the body sectPr', edit(D, '</w:sectPr></w:body>', '</w:sectPr><w:p/></w:body>'), true, true],
  ['the body ends with a table before its sectPr', edit(D, '<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:t xml:space="preserve">halaman dua</w:t></w:r></w:p>', '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="100"/></w:tblGrid><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>'), true, false],
  ['r:embed names a relationship that does not exist', edit(D, 'r:embed="rIdImg1"', 'r:embed="rIdNope"'), true, false],
  ['a numId with no w:num', edit(D, '<w:numId w:val="1"/>', '<w:numId w:val="7"/>'), true, false],
  ['a pStyle with no definition', edit(D, '<w:pPr><w:tabs>', '<w:pPr><w:pStyle w:val="Nope"/><w:tabs>'), true, false],
  ['w:t with edge whitespace and no xml:space', edit(D, '<w:t xml:space="preserve"> butuh preserve </w:t>', '<w:t> butuh preserve </w:t>'), true, false],
  ['mc:Ignorable names an undeclared prefix', edit(D, '<w:document ', '<w:document xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w14" '), true, false],
  ['a page wider than Word allows', edit(D, '<w:pgSz w:w="11900" w:h="16840"/><w:pgMar w:top="720" w:right="720" w:bottom="0" w:left="720" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body>', '<w:pgSz w:w="40000" w:h="16840"/><w:pgMar w:top="720" w:right="720" w:bottom="0" w:left="720" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body>'), true, false],
  ['wps:wsp without bodyPr', edit(D, '<wps:bodyPr/>', ''), false, true],
  ['wps:wsp children out of order', edit(D, '<wps:cNvSpPr/><wps:spPr>', '<wps:spPr>'), false, true],
  ['wps:spPr: fill before geometry', edit(D, '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="FFF2CC"/></a:solidFill>', '<a:solidFill><a:srgbClr val="FFF2CC"/></a:solidFill><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'), false, true],
  ['pic:pic: spPr before blipFill', edit(D, '<pic:blipFill><a:blip r:embed="rIdImg1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr>', '<pic:spPr>'), false, true],
  ['pic:pic children reversed', (f) => { const t = dec(f[D]); const m = t.match(/(<pic:blipFill>.*?<\/pic:blipFill>)(<pic:spPr>.*?<\/pic:spPr>)/); assert.ok(m); f[D] = enc(t.replace(m[0], m[2] + m[1])); }, true, true],
  ['a relationship id used twice', edit('word/_rels/document.xml.rels', 'Id="rIdNum"', 'Id="rIdSt"'), true, true],
  ['a relationship id that is not an xsd:ID', (f) => { const t = dec(f['word/_rels/document.xml.rels']).replace(/rIdImg1/g, '1img'); f['word/_rels/document.xml.rels'] = enc(t); f[D] = enc(dec(f[D]).replace('rIdImg1', '1img')); }, true, true],
  ['a relationship target that is not in the package', (f) => { delete f['word/media/image1.png']; }, true, false],
  ['a media file nothing references', (f) => { f['word/media/extra.png'] = f['word/media/image1.png']; }, true, false],
  ['the main part has the wrong content type', edit('[Content_Types].xml', 'wordprocessingml.document.main+xml', 'wordprocessingml.document+xml'), true, false],
  ['[Content_Types].xml lists a part twice', edit('[Content_Types].xml', '<Override PartName="/word/styles.xml"', '<Override PartName="/word/document.xml" ContentType="x/y"/><Override PartName="/word/styles.xml"'), true, false],
  ['a part with no content type', (f) => { f['word/extra.bin'] = enc('x'); }, true, false],
  ['a PNG whose chunk fails its CRC', (f) => { const b = f['word/media/image1.png'].slice(); b[b.length - 20] ^= 0xFF; f['word/media/image1.png'] = b; }, true, false],
  ['a PNG that is not a PNG', (f) => { f['word/media/image1.png'] = enc('GIF89a....'); }, true, false],
  ['a JPEG with no frame header', (f) => { f['word/media/image1.jpeg'] = new Uint8Array([0xFF, 0xD8, 0xFF, 0xD9]); f['word/_rels/document.xml.rels'] = enc(dec(f['word/_rels/document.xml.rels']).replace('</Relationships>', '<Relationship Id="rIdJ" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.jpeg"/></Relationships>')); }, true, false],
  ['styles.xml is not UTF-8', (f) => { const b = enc(dec(f['word/styles.xml']).replace('Normal', 'Norm__')); const i = b.indexOf(0x5F); b[i] = 0xE9; b[i + 1] = 0x20; f['word/styles.xml'] = b; }, true, true],
  ['a style referencing a missing basedOn', edit('word/styles.xml', '<w:name w:val="Normal"/>', '<w:name w:val="Normal"/><w:basedOn w:val="Gone"/>'), true, false],
  ['numbering with a num before its abstractNum', (f) => { const t = dec(f['word/numbering.xml']); const m = t.match(/<w:num [\s\S]*<\/w:num>/); f['word/numbering.xml'] = enc(t.replace(m[0], '').replace('<w:abstractNum ', `${m[0]}<w:abstractNum `)); }, true, true],
  ['no [Content_Types].xml', (f) => { delete f['[Content_Types].xml']; }, true, false],
];

for (const [name, mutate, strictRed, xsdRed] of CASES) {
  test(`validate: ${name}: strict ${strictRed ? 'RED' : 'green'}, schema ${xsdRed ? 'RED' : 'green'}`, (t) => {
    const files = variant(mutate);
    const s = strictOf(files);
    assert.equal(s.length > 0, strictRed, `strict layer: ${s.slice(0, 3).join(' | ') || 'no problem reported'}`);
    if (!schema) { t.diagnostic('XSD half skipped'); return; }
    const x = xsdProblems(files, schema, scratch);
    assert.equal(x.length > 0, xsdRed, `schema layer: ${x.slice(0, 3).join(' | ') || 'no problem reported'}`);
  });
}

test('validate: the schema layer is what catches the strict layer\'s blind spots (and each layer alone is not enough)', () => {
  const strictOnly = CASES.filter(([, , s, x]) => s && !x).length;
  const xsdOnly = CASES.filter(([, , s, x]) => !s && x).length;
  assert.ok(strictOnly >= 8 && xsdOnly >= 3, `${strictOnly} strict-only, ${xsdOnly} schema-only rows: both layers earn their place`);
});

test('validate: the zip layer flags an unsupported compression method and a missing [Content_Types].xml entry', () => {
  const b = fixture.slice();
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = b.length - 22;
  while (dv.getUint32(eocd, true) !== 0x06054b50) eocd -= 1;
  const cd = dv.getUint32(eocd + 16, true);
  dv.setUint16(cd + 10, 99, true);
  assert.ok(zipProblems(b).some((m) => /compression method 99/.test(m)));
  const small = fflate.zipSync({ 'a.xml': enc('<a/>') });
  assert.ok(zipProblems(small).some((m) => /no \[Content_Types\]\.xml/.test(m)));
  assert.deepEqual(zipProblems(fixture), []);
});

test('validate: crc32 and the tiny DOM agree with known values (the instruments themselves)', () => {
  assert.equal(crc32(enc('123456789')), 0xCBF43926);
  const t = parseXml('<a xmlns="u" xmlns:p="v"><p:b p:x="1">t&amp;u</p:b><c/></a>');
  assert.equal(t.uri, 'u');
  assert.equal(t.children[0].uri, 'v');
  assert.equal(t.children[0].text, 't&u');
  assert.equal(t.children[0].attrs[0].uri, 'v');
  assert.equal(t.children[1].uri, 'u');
});

test('validate: a real conversion output passes both layers (the writer, tables and colour modules together)', async () => {
  const { makePdf, convertBytes } = await import('./docx-helpers.mjs');
  const layoutMod = await import('../../js/docx/layout.js');
  const bytes = await makePdf((pages, { fonts }) => {
    pages[0].drawText('Nama', { x: 72, y: 600, size: 11, font: fonts.reg });
    pages[0].drawText('Jumlah', { x: 300, y: 600, size: 11, font: fonts.reg });
    pages[0].drawText('Merah', { x: 72, y: 700, size: 12, font: fonts.reg });
  });
  const r = await convertBytes(bytes, { modules: {
    color: { analyzeColor(ctx) { for (const x of ctx.runs) if (x.str === 'Merah') x.color = 'FF0000'; return { fillAt: () => null, background: 'FFF2CC', anchors: [{ kind: 'shape', x: 0, y: 0, wPt: ctx.widthPt, hPt: ctx.heightPt, fill: 'FFF2CC', z: 1 }] }; } },
    tables: { detectTables(ctx) {
      const own = ctx.lines.filter((l) => ['Nama', 'Jumlah'].includes(l.str.trim()));
      const cell = (line) => ({ blocks: layoutMod.paragraphsOfLines([line], ctx, { left: line.x, right: line.x + line.w }), fill: 'D9E2F3' });
      return [{ x0: 70, y0: Math.min(...own.map((l) => l.y)), x1: 400, y1: Math.max(...own.map((l) => l.y + l.h)), lines: own, block: { kind: 'tbl', colsPt: [228, 80], border: true, rows: [own.map(cell)] } }];
    } },
  } });
  const v = validateDocx(r.docx, { fflate, schema, scratch });
  assert.deepEqual(v.problems, []);
  assert.deepEqual(v.xsdProblems || [], []);
  assert.match(r.documentXml, /<w:tbl>/);
  assert.match(r.documentXml, /<wps:wsp>/);
});
