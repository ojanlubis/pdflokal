/*
 * PDFLokal — lab-docx.js  (DEV-ONLY test page for the PDF -> .docx converter)
 * ============================================================================
 * Served at /lab-docx.html (noindex, not linked, not in the sitemap, not in the service
 * worker's precache). It is the converter's only caller until the product UI exists, and
 * it is what tests/docx-browser.spec.js drives. The page shows the converter's whole
 * surface: pick a file, progress, cancel, the worker/main path, and the result.
 *
 * window.labDocx is the test hook:
 *   labDocx.convertUrl(url, opts)  fetch a fixture, convert, return { size, mode, ms, stats, writer, inspect }
 *   labDocx.last                   the last { blob, ... } (so a test can save it)
 *   labDocx.inspect(blob)          unzip + XML-parse every part, return { entries, problems, text, sections, media }
 */
/* global ImageBitmap */
import { ensureFflate } from './core/vendor.js';

const $ = (id) => document.getElementById(id);
const log = (s) => { $('log').textContent += `${s}\n`; };

let controller = null;

async function ocrWithTesseract({ source, scale }) {
  const [{ recognizeCanvas }, { ocrLinesToPageLines }] = await Promise.all([import('./v2/ocr-engine.js'), import('./core/ocr-lines.js')]);
  let canvas = source;
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) {
    canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    canvas.getContext('2d').drawImage(source, 0, 0);
  }
  const data = await recognizeCanvas(canvas);
  return ocrLinesToPageLines(data, scale);
}

async function inspect(blob) {
  const fflate = await ensureFflate();
  const files = fflate.unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const problems = [];
  const entries = Object.keys(files);
  const dom = new DOMParser();
  for (const name of entries) {
    if (!/\.(xml|rels)$/.test(name)) continue;
    const doc = dom.parseFromString(fflate.strFromU8(files[name]), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) problems.push(`${name}: not well-formed`);
  }
  const xml = files['word/document.xml'] ? dom.parseFromString(fflate.strFromU8(files['word/document.xml']), 'application/xml') : null;
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const paras = xml ? [...xml.getElementsByTagNameNS(W, 'p')].map((p) => [...p.getElementsByTagNameNS(W, 't')].map((t) => t.textContent).join('')).filter((t) => t.trim()) : [];
  return {
    entries,
    problems,
    text: paras.join('\n'),
    sections: xml ? xml.getElementsByTagNameNS(W, 'sectPr').length : 0,
    tables: xml ? xml.getElementsByTagNameNS(W, 'tbl').length : 0,
    media: entries.filter((n) => n.startsWith('word/media/')).length,
  };
}

async function convert(source, opts = {}) {
  const { convertPdfFile } = await import('./docx/client.js');
  const ocr = opts.ocr ? ocrWithTesseract : undefined;
  const r = await convertPdfFile(source, { ...opts, ocr });
  return r;
}

window.labDocx = {
  last: null,
  inspect,
  async convertUrl(url, opts = {}) {
    const buf = await (await fetch(url)).arrayBuffer();
    const r = await convert(buf, opts);
    this.last = r;
    return { size: r.blob.size, mode: r.mode, ms: r.ms, stats: r.stats, writer: r.writer, inspect: opts.inspect === false ? null : await inspect(r.blob) };
  },
  convert,
};

let chosen = null;
$('file').addEventListener('change', (e) => {
  chosen = e.target.files[0] || null;
  $('go').disabled = !chosen;
  $('status').textContent = chosen ? `${chosen.name}, ${(chosen.size / 1048576).toFixed(1)} MB` : 'menunggu berkas';
});
$('go').addEventListener('click', async () => {
  if (!chosen) return;
  controller = new AbortController();
  $('go').disabled = true;
  $('cancel').disabled = false;
  $('save').hidden = true;
  $('log').textContent = '';
  $('status').className = '';
  const t0 = performance.now();
  try {
    const r = await convert(chosen, {
      signal: controller.signal,
      maxPages: Number($('maxpages').value) || undefined,
      mode: $('mode').value,
      ocr: $('useocr').checked,
      onProgress: (done, total) => { $('bar').max = total; $('bar').value = done; $('status').textContent = `halaman ${done} dari ${total}`; },
    });
    window.labDocx.last = r;
    $('save').href = URL.createObjectURL(r.blob);
    $('save').hidden = false;
    $('status').className = 'ok';
    $('status').textContent = `selesai, ${(r.blob.size / 1048576).toFixed(2)} MB, ${Math.round(performance.now() - t0)} ms, jalur ${r.mode}`;
    log(JSON.stringify({ stats: r.stats, writer: r.writer }, null, 1));
  } catch (e) {
    $('status').className = 'err';
    $('status').textContent = e.name === 'AbortError' ? 'dibatalkan' : `gagal: ${e.code || e.name}: ${e.message}`;
  } finally {
    $('go').disabled = false;
    $('cancel').disabled = true;
    controller = null;
  }
});
$('cancel').addEventListener('click', () => { if (controller) controller.abort(); });
