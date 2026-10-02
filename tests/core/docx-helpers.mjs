/*
 * Shared helpers for tests/core/docx-*.test.mjs (not a test itself: node --test only runs *.test.mjs).
 * The vendored libraries are loaded the way the product ships them (UMD files, in-realm), pdf-lib
 * builds the synthetic PDFs, pdf.js reads them back: the same pair the browser uses.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { xmlProblems, packageProblems } from '../../scripts/lib/docx-xml.mjs';

export const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const loadUmd = (p) => {
  const module = { exports: {} };
  new Function('module', 'exports', 'self', 'window', 'global', 'define',
    fs.readFileSync(path.join(root, p), 'utf8'))(module, module.exports, globalThis, undefined, globalThis, undefined);
  return module.exports;
};

let libs = null;
export function loadLibs() {
  if (!libs) {
    globalThis.pdfjsWorker = loadUmd('js/vendor/pdf.worker.min.js');
    libs = { PDFLib: loadUmd('js/vendor/pdf-lib.min.js'), pdfjs: loadUmd('js/vendor/pdf.min.js'), fflate: loadUmd('js/vendor/fflate.min.js') };
  }
  return libs;
}

// build(page, ctx) draws on page 1 of a fresh doc; pass `pages` for several. ctx = { doc, fonts, PDFLib, rgb }.
export async function makePdf(build, { pages = [[595, 842]] } = {}) {
  const { PDFLib } = loadLibs();
  const doc = await PDFLib.PDFDocument.create();
  const fonts = {
    reg: await doc.embedFont(PDFLib.StandardFonts.Helvetica),
    bold: await doc.embedFont(PDFLib.StandardFonts.HelveticaBold),
    mono: await doc.embedFont(PDFLib.StandardFonts.Courier),
  };
  const added = pages.map(([w, h]) => doc.addPage([w, h]));
  await build(added, { doc, fonts, PDFLib, rgb: PDFLib.rgb });
  return new Uint8Array(await doc.save());
}

export async function convertBytes(bytes, extra = {}) {
  const { pdfjs, fflate } = loadLibs();
  const { convertPdfToDocx } = await import('../../js/docx/convert.js');
  const r = await convertPdfToDocx({ pdfjs, fflate, data: bytes, ...extra });
  const files = fflate.unzipSync(r.docx);
  const str = (n) => fflate.strFromU8(files[n]);
  return { ...r, files, documentXml: str('word/document.xml'), str };
}

export const unzip = (docx) => loadLibs().fflate.unzipSync(docx);

// The two independent checks every produced package must pass.
export function packageIsClean(files) {
  const xml = Object.keys(files).filter((n) => /\.(xml|rels)$/.test(n)).flatMap((n) => xmlProblems(files[n]).map((m) => `${n}: ${m}`));
  return xml.concat(packageProblems(files));
}

const decodeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
export const paragraphsOf = (xml) => (xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []);
export const textOf = (xmlFragment) => decodeXml([...xmlFragment.matchAll(/<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>/g)].map((m) => (m[1] !== undefined ? m[1] : '\t')).join(''));
export const docText = (xml) => paragraphsOf(xml).map(textOf).filter((t) => t.trim());
