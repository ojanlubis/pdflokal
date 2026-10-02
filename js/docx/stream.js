/*
 * PDFLokal — docx/stream.js  (THE STREAMING CONVERTER: pages in, zip chunks out)
 * ============================================================================
 * The browser shell's entry point, and the one the worker, the main-thread fallback
 * and the node tests all call. Same pipeline as convert.js, but the document is
 * never assembled: every finished Page is serialised by the writer and dropped, and
 * the zip leaves in chunks as it is produced.
 *
 *   convertPdfToDocxStream({ pdfjs, fflate, data, onChunk, onProgress, signal, maxPages,
 *                            ocr, options, modules, limits }) -> { stats, writer }
 *
 *   onChunk(bytes: Uint8Array, final: boolean)   the .docx, in order, in pieces
 *   limits   { imageCacheBytes, spoolBytes, maxOutputBytes, maxInputBytes, maxPages, overPages }
 *            all optional, defaults below. A LimitError (err.code) says which one stopped the run:
 *            'input-too-large' (data.byteLength > maxInputBytes), 'too-many-pages' (the document has
 *            more than maxPages and overPages is 'refuse'; with 'truncate' the first maxPages are
 *            converted and stats.truncated is set), 'output-too-large' (maxOutputBytes)
 *   stats    convert.js's stats; writer = { pages, mediaCount, mediaBytes, docXmlBytes,
 *            spilled, outBytes }
 *
 * WHAT STAYS IN MEMORY, per page class (the numbers are in the shell lane's report):
 *   text page    its XML (20-50 KB) until the end; nothing else survives the page
 *   picture      encoded once per image object, held in a byte-capped LRU so a logo
 *                repeated on every page stays cached and a 700-photo document does not
 *   output       handed to onChunk as it is made; the worker transfers it to the page,
 *                the page keeps it as Blob parts
 */

import { pdfToDocModel } from './convert.js';
import { createDocxStream } from './writer.js';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export const DEFAULT_LIMITS = Object.freeze({
  imageCacheBytes: 24 * 1024 * 1024, // encoded pictures kept for reuse across pages
  spoolBytes: 16 * 1024 * 1024, // media held back so a small document gets the canonical zip order
  maxOutputBytes: Infinity, // the shell sets these from policy.js
  maxInputBytes: Infinity,
  maxPages: Infinity,
  overPages: 'refuse',
});

export class LimitError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = 'LimitError';
    this.code = code;
    this.detail = detail || {};
  }
}

// A Map-shaped cache bounded by the bytes it holds (least recently used out first).
// convert.js and images.js only use get / set / has; a Map iterates in insertion
// order, so re-inserting on get is the whole LRU.
export class ByteCappedCache {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.map = new Map();
    this.evictions = 0;
  }

  has(k) { return this.map.has(k); }

  get(k) {
    const v = this.map.get(k);
    if (v !== undefined) { this.map.delete(k); this.map.set(k, v); }
    return v;
  }

  set(k, v) {
    const size = (v && v.bytes && v.bytes.length) || 0;
    const old = this.map.get(k);
    if (old !== undefined) { this.bytes -= (old.bytes && old.bytes.length) || 0; this.map.delete(k); }
    this.map.set(k, v);
    this.bytes += size;
    while (this.bytes > this.maxBytes && this.map.size > 1) {
      const first = this.map.keys().next().value;
      const ev = this.map.get(first);
      this.bytes -= (ev && ev.bytes && ev.bytes.length) || 0;
      this.map.delete(first);
      this.evictions += 1;
    }
    return this;
  }

  get size() { return this.map.size; }
}

export async function convertPdfToDocxStream(args) {
  const { fflate, onChunk, signal } = args;
  const limits = { ...DEFAULT_LIMITS, ...(args.limits || {}) };
  const writer = createDocxStream({
    fflate,
    spoolBytes: limits.spoolBytes,
    onChunk: (bytes, final) => {
      if (writer.stats.outBytes > limits.maxOutputBytes) {
        throw new LimitError('output-too-large', 'the .docx is larger than this device allows', { outBytes: writer.stats.outBytes, max: limits.maxOutputBytes });
      }
      onChunk(bytes, final);
    },
  });
  const imageCache = new ByteCappedCache(limits.imageCacheBytes);
  const inBytes = args.data.byteLength;
  if (inBytes > limits.maxInputBytes) throw new LimitError('input-too-large', 'the PDF is larger than this device allows', { bytes: inBytes, max: limits.maxInputBytes });
  let truncatedAt = 0;
  const { stats } = await pdfToDocModel({
    pdfjs: args.pdfjs,
    fflate,
    data: args.data,
    onProgress: args.onProgress,
    onOpen: (pdf) => {
      if (pdf.numPages <= limits.maxPages) return null;
      if (limits.overPages !== 'truncate') throw new LimitError('too-many-pages', 'the PDF has more pages than this device allows', { pages: pdf.numPages, max: limits.maxPages });
      truncatedAt = limits.maxPages;
      return { maxPages: limits.maxPages };
    },
    onPage: (page) => {
      writer.addPage(page);
      // media are written (or held) by the writer on first sight; a page that pushes the
      // output past the cap stops the run here instead of at the end
      if (writer.stats.mediaBytes > limits.maxOutputBytes) {
        throw new LimitError('output-too-large', 'the pictures alone are larger than this device allows', { mediaBytes: writer.stats.mediaBytes, max: limits.maxOutputBytes });
      }
    },
    maxPages: args.maxPages,
    ocr: args.ocr,
    signal,
    options: args.options,
    modules: args.modules,
    imageCache,
  });
  if (signal && signal.aborted) throw signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' });
  writer.finish();
  stats.imageCacheEvictions = imageCache.evictions;
  stats.truncated = truncatedAt;
  return { stats, writer: { ...writer.stats } };
}
