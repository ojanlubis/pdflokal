/*
 * ooxml-schemas.mjs — fetch, pin and assemble the schemas the .docx validator checks against.
 * ============================================================================
 *   import { ensureSchemas } from './lib/ooxml-schemas.mjs';
 *   const s = await ensureSchemas();   // { dir, wrapper, catalog }  or throws with the reason
 *   CLI:  node scripts/lib/ooxml-schemas.mjs [--dir DIR] [--force]
 *
 * WHY FETCHED AND NOT COMMITTED (same convention as scripts/fetch-ocr-engine.sh): ~1.9 MB of
 * third-party specification files (Ecma, W3C, Dublin Core, Microsoft) whose redistribution terms
 * are not ours to settle in an AGPL repo. Every source below is pinned by sha256, so the check is
 * reproducible byte for byte; a changed source is a loud failure, never a silently different gate.
 * Committing them is a one-line decision for the founder (see the lane report); the code does not change.
 *
 * SOURCES (fetched 2026-10-02, all official, none GitHub):
 *   ECMA-376 5th edition Part 4 (Transitional Migration Features), December 2016
 *       https://ecma-international.org/wp-content/uploads/ECMA-376-4_5th_edition_december_2016.zip
 *       -> OfficeOpenXML-XMLSchema-Transitional.zip: wml, dml-*, shared-*, vml-*, sml, pml (the schemas Word 2007+ writes)
 *   ECMA-376 5th edition Part 2 (Open Packaging Conventions), December 2021
 *       https://ecma-international.org/wp-content/uploads/ECMA-376-2_5th_edition_december_2021.zip
 *       -> OpenPackagingConventions-XMLSchema.zip: [Content_Types].xml, .rels, core properties
 *   W3C xml.xsd (xml:space, xml:lang), imported by wml.xsd without a schemaLocation
 *       https://www.w3.org/2001/xml.xsd
 *   Dublin Core dc / dcterms / dcmitype, imported by the OPC core-properties schema
 *       https://www.dublincore.org/schemas/xmls/qdc/2003/04/02/{dc,dcterms,dcmitype}.xsd
 *   [MS-ODRAWXML] 5.2 wordprocessingShape (the wps: namespace, Word 2010+, NOT part of Ecma-376)
 *       https://learn.microsoft.com/en-us/openspecs/office_standards/ms-odrawxml/f73ea06d-4749-4611-b20b-755df087eb21
 *       (scraped from the page; the extracted text is what is pinned)
 *
 * WHAT IS ASSEMBLED, and the only edits (none to a downloaded file's meaning):
 *   - the Ecma/OPC/DC/W3C files are written to the schema directory UNCHANGED;
 *   - catalog.xml maps the absolute URLs the DC and OPC files import (w3.org, dublincore.org) to the
 *     local copies, so xmllint runs with --nonet;
 *   - wps.xsd is the Microsoft schema with its `import` lines re-pointed at the Ecma files (the originals
 *     name Microsoft-internal files, oart*.xsd) and the one reference to the non-Ecma wne:txbxContent
 *     removed (a text box is not something this converter writes);
 *   - wrapper.xsd imports every namespace a .docx part can have, so ONE xmllint run validates every part.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const VERSION = 'v1';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const SOURCES = {
  p4: { url: 'https://ecma-international.org/wp-content/uploads/ECMA-376-4_5th_edition_december_2016.zip', sha256: 'bd25da1109f73762356596918bf5ff8b74a1331642dba5f1c1d1dfc6bed34ecd' },
  p2: { url: 'https://ecma-international.org/wp-content/uploads/ECMA-376-2_5th_edition_december_2021.zip', sha256: '1d489dc491168ea1f9e9a59063acc8dd5f02b4ad1d21aa7ec19ba9a58d020c70' },
  xml: { url: 'https://www.w3.org/2001/xml.xsd', sha256: '61960fb3131e38022caad5360e2f33a3382578ab3c80cd58bd74320ede61b20c' },
  dc: { url: 'https://www.dublincore.org/schemas/xmls/qdc/2003/04/02/dc.xsd', sha256: 'bc1d454db1bb20dfb1867a3fe0cf007775fc4afa33a5df425c12d854f049f1f6' },
  dcterms: { url: 'https://www.dublincore.org/schemas/xmls/qdc/2003/04/02/dcterms.xsd', sha256: '6328c8b574c166f8ebc28d07231e6ee47121e9791689b70c3afa665f22099fed' },
  dcmitype: { url: 'https://www.dublincore.org/schemas/xmls/qdc/2003/04/02/dcmitype.xsd', sha256: '4980845d0bedcf45e707fa64eb47492ae4f95ac4ae42f5c3c68b58c0bc9e8e49' },
  wps: { url: 'https://learn.microsoft.com/en-us/openspecs/office_standards/ms-odrawxml/f73ea06d-4749-4611-b20b-755df087eb21', sha256: 'ffe3229c8596a2e2589ad166a339a50389c87dea469534fb8c1cf8db72197be4', extracted: true },
};

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function get(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// The XSD text out of the Microsoft Learn page (HTML -> text, the xsd:schema block, blank lines dropped).
export function extractWps(html) {
  const ent = { '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' };
  const text = html.replace(/<[^>]+>/g, '\n').replace(/&(?:nbsp|lt|gt|quot|#39|amp);/g, (m) => ent[m]).replace(/\u00a0/g, ' ');
  const i = text.indexOf('<xsd:schema');
  const j = text.indexOf('</xsd:schema>');
  if (i < 0 || j < 0) throw new Error('wps schema not found on the Microsoft Learn page (the page changed)');
  return `${text.slice(i, j + '</xsd:schema>'.length).split('\n').map((l) => l.trimEnd()).filter((l) => l.trim()).join('\n')}\n`;
}

// Import lines re-pointed at the Ecma schemas; the one non-Ecma reference dropped. See the header.
export function patchWps(raw) {
  let x = raw.replace(/<xsd:import schemaLocation="oart(?:docprop|spproperties|stylesheet)\.xsd"/g, '<xsd:import schemaLocation="dml-main.xsd"');
  x = x.replace('<xsd:import schemaLocation="oartWordShapeTextbox.xsd"', '<xsd:import schemaLocation="wml.xsd"');
  x = x.replace(/\s*<xsd:import schemaLocation="orel\.xsd"[^>]*\/>/, '');
  x = x.replace(/\s*<xsd:import schemaLocation="oartWordNonEcmaShapeTextbox\.xsd"[^>]*\/>/, '');
  x = x.replace(/\s*<xsd:element ref="wne:txbxContent"[^>]*\/>/, '');
  // three imports of dml-main collapse into one (libxml2 skips repeats with a warning; keep stderr quiet)
  const seen = new Set();
  x = x.split('\n').filter((l) => { const m = l.match(/<xsd:import schemaLocation="([^"]+)"/); if (!m) return true; if (seen.has(m[1])) return false; seen.add(m[1]); return true; }).join('\n');
  return x;
}

const CATALOG = `<?xml version="1.0"?>
<catalog xmlns="urn:oasis:names:tc:entity:xmlns:xml:catalog">
${[['http://www.w3.org/2001/03/xml.xsd', 'xml.xsd'], ['http://dublincore.org/schemas/xmls/qdc/2003/04/02/dc.xsd', 'dc.xsd'], ['http://dublincore.org/schemas/xmls/qdc/2003/04/02/dcterms.xsd', 'dcterms.xsd'], ['http://dublincore.org/schemas/xmls/qdc/2003/04/02/dcmitype.xsd', 'dcmitype.xsd']]
    .map(([u, f]) => `  <system systemId="${u}" uri="${f}"/>\n  <uri name="${u}" uri="${f}"/>`).join('\n')}
</catalog>
`;

const WRAPPER = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:pdflokal:docx-validate-wrapper">
  <xs:import namespace="http://www.w3.org/XML/1998/namespace" schemaLocation="xml.xsd"/>
  <xs:import namespace="http://schemas.openxmlformats.org/wordprocessingml/2006/main" schemaLocation="wml.xsd"/>
  <xs:import namespace="http://schemas.openxmlformats.org/drawingml/2006/main" schemaLocation="dml-main.xsd"/>
  <xs:import namespace="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" schemaLocation="wps.xsd"/>
  <xs:import namespace="http://schemas.openxmlformats.org/package/2006/content-types" schemaLocation="opc-contentTypes.xsd"/>
  <xs:import namespace="http://schemas.openxmlformats.org/package/2006/relationships" schemaLocation="opc-relationships.xsd"/>
  <xs:import namespace="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" schemaLocation="opc-coreProperties.xsd"/>
  <xs:import namespace="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" schemaLocation="shared-documentPropertiesExtended.xsd"/>
</xs:schema>
`;

export const defaultDir = () => process.env.OOXML_XSD_DIR || path.join(os.tmpdir(), 'docx-gate-cache', `ooxml-xsd-${VERSION}`);
const ready = (dir) => fs.existsSync(path.join(dir, '.ready')) && fs.existsSync(path.join(dir, 'wrapper.xsd'));
const describe = (dir) => ({ dir, wrapper: path.join(dir, 'wrapper.xsd'), catalog: path.join(dir, 'catalog.xml') });

function fflateLib() {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global', 'define', fs.readFileSync(path.join(root, 'js/vendor/fflate.min.js'), 'utf8'))(module, module.exports, globalThis, undefined, globalThis, undefined);
  return module.exports;
}

export async function ensureSchemas({ dir = defaultDir(), force = false, log = () => {} } = {}) {
  if (!force && ready(dir)) return describe(dir);
  const fflate = fflateLib();
  const bytes = {};
  for (const [k, src] of Object.entries(SOURCES)) {
    log(`fetching ${src.url}`);
    let buf = await get(src.url);
    if (src.extracted) buf = Buffer.from(extractWps(buf.toString('utf8')), 'utf8');
    const got = sha(buf);
    if (got !== src.sha256) throw new Error(`schema source changed: ${src.url}\n  pinned ${src.sha256}\n  got    ${got}\n  (re-verify the source, then update SOURCES in scripts/lib/ooxml-schemas.mjs)`);
    bytes[k] = buf;
  }
  const tmp = `${dir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  const unzipInner = (outer, innerName) => {
    const inner = fflate.unzipSync(new Uint8Array(outer))[innerName];
    if (!inner) throw new Error(`${innerName} missing from its Ecma zip`);
    return fflate.unzipSync(inner);
  };
  for (const [name, data] of Object.entries(unzipInner(bytes.p4, 'OfficeOpenXML-XMLSchema-Transitional.zip'))) if (name.endsWith('.xsd')) fs.writeFileSync(path.join(tmp, path.basename(name)), data);
  for (const [name, data] of Object.entries(unzipInner(bytes.p2, 'OpenPackagingConventions-XMLSchema.zip'))) if (name.endsWith('.xsd')) fs.writeFileSync(path.join(tmp, path.basename(name)), data);
  for (const k of ['xml', 'dc', 'dcterms', 'dcmitype']) fs.writeFileSync(path.join(tmp, `${k}.xsd`), bytes[k]);
  fs.writeFileSync(path.join(tmp, 'wps.xsd'), patchWps(bytes.wps.toString('utf8')));
  fs.writeFileSync(path.join(tmp, 'catalog.xml'), CATALOG);
  fs.writeFileSync(path.join(tmp, 'wrapper.xsd'), WRAPPER);
  fs.writeFileSync(path.join(tmp, '.ready'), `${JSON.stringify({ version: VERSION, fetched: new Date().toISOString().slice(0, 10), sources: Object.fromEntries(Object.entries(SOURCES).map(([k, s]) => [k, { url: s.url, sha256: s.sha256 }])) }, null, 1)}\n`);
  fs.rmSync(dir, { recursive: true, force: true });
  try { fs.renameSync(tmp, dir); } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); if (!ready(dir)) throw e; /* another process got there first */ }
  return describe(dir);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const di = a.indexOf('--dir');
  ensureSchemas({ dir: di >= 0 ? a[di + 1] : defaultDir(), force: a.includes('--force'), log: (m) => console.log(m) })
    .then((s) => console.log(`schemas ready: ${s.dir}`))
    .catch((e) => { console.error(String(e.message || e)); process.exit(2); });
}
