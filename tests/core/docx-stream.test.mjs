/*
 * docx/stream.js, docx/policy.js and the streaming half of docx/writer.js, in node (the browser
 * shell itself, worker + client + lab page, is tests/docx-browser.spec.js).
 *
 * The properties that matter, each with a mutation that breaks it:
 *   - the streamed .docx is entry-for-entry the .docx convertPdfToDocx builds (same bytes, same order);
 *   - nothing holds the document model: pages go to the writer one by one and model.pages stays empty;
 *   - the byte-capped image cache really caps and really evicts the OLDEST first;
 *   - every limit stops the run with its own code, and a cancelled run never writes the final chunk;
 *   - media that spill early still make a valid package, and a small document keeps the canonical order.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePng } from '../../js/docx/png.js';
import { pdfToDocModel } from '../../js/docx/convert.js';
import { convertPdfToDocxStream, ByteCappedCache, LimitError, DEFAULT_LIMITS } from '../../js/docx/stream.js';
import { createDocxStream, buildDocx } from '../../js/docx/writer.js';
import { assessDevice, limitsFor, CLASSES } from '../../js/docx/policy.js';
import { loadLibs, makePdf, convertBytes, packageIsClean } from './docx-helpers.mjs';

const { fflate, pdfjs } = loadLibs();

const text = (pages, { fonts }, tag) => pages.forEach((p, k) => p.drawText(`${tag} halaman ${k + 1}`, { x: 72, y: 700, size: 12, font: fonts.reg }));

// A PDF whose pages each carry a DIFFERENT picture (distinct image objects, distinct bytes).
async function picturesPdf(n) {
  return makePdf(async (pages, { doc, fonts }) => {
    for (let k = 0; k < n; k += 1) {
      const px = new Uint8Array(16 * 16 * 3);
      for (let i = 0; i < px.length; i += 1) px[i] = (i * (k + 3) + k * 31) % 256;
      pages[k].drawImage(await doc.embedPng(encodePng(fflate, 16, 16, 3, px)), { x: 72, y: 500, width: 100, height: 100 });
      pages[k].drawText(`gambar ${k + 1}`, { x: 72, y: 700, size: 12, font: fonts.reg });
    }
  }, { pages: Array.from({ length: n }, () => [595, 842]) });
}

async function stream(bytes, extra = {}) {
  const chunks = [];
  const finals = [];
  const r = await convertPdfToDocxStream({ pdfjs, fflate, data: bytes, onChunk: (c, final) => { chunks.push(c.slice()); finals.push(final); }, ...extra });
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return { ...r, chunks, finals, out, files: fflate.unzipSync(out) };
}

// ---- the stream equals the batch --------------------------------------------------------------
test('stream: the .docx it emits has the same entries, byte for byte and in the same order, as the whole-model build', async () => {
  const bytes = await picturesPdf(3);
  const batch = await convertBytes(bytes);
  const s = await stream(bytes);
  assert.deepEqual(Object.keys(s.files), Object.keys(batch.files));
  for (const k of Object.keys(batch.files)) assert.equal(Buffer.compare(Buffer.from(s.files[k]), Buffer.from(batch.files[k])), 0, `${k} differs`);
  assert.deepEqual(packageIsClean(s.files), []);
  assert.equal(s.stats.pages, 3);
  assert.equal(s.writer.pages, 3);
  assert.equal(s.writer.mediaCount, 3);
  assert.equal(s.writer.outBytes, s.out.length, 'the writer counts exactly the bytes it handed over');
});

// LibreOffice cannot read a STORED entry whose sizes live in a trailing data descriptor ("source file could
// not be loaded"); Word can. A stream cannot know an entry's size up front, so every entry must be a DEFLATE
// entry (level 0 = stored blocks inside deflate is fine). Found by the gate: 83 of 104 corpus files with pictures
// failed to render when media were written with fflate's ZipPassThrough. Nothing in node loads the file in an
// office suite, so the property is checked on the bytes: walk the local file headers.
test('stream: no entry is STORED with a data descriptor (LibreOffice refuses those); pictures included', async () => {
  const s = await stream(await picturesPdf(3), { limits: { spoolBytes: 0 } }); // spoolBytes 0: media written as they appear
  const dv = new DataView(s.out.buffer, s.out.byteOffset, s.out.byteLength);
  let at = 0;
  let seen = 0;
  const bad = [];
  // walk the central directory (end-of-central-directory record is the last 22 bytes: no comment is written)
  const eocd = s.out.length - 22;
  assert.equal(dv.getUint32(eocd, true), 0x06054b50);
  const entries = dv.getUint16(eocd + 10, true);
  at = dv.getUint32(eocd + 16, true);
  for (let i = 0; i < entries; i += 1) {
    assert.equal(dv.getUint32(at, true), 0x02014b50);
    const flag = dv.getUint16(at + 8, true);
    const method = dv.getUint16(at + 10, true);
    const nameLen = dv.getUint16(at + 28, true);
    const extraLen = dv.getUint16(at + 30, true);
    const commentLen = dv.getUint16(at + 32, true);
    const name = Buffer.from(s.out.subarray(at + 46, at + 46 + nameLen)).toString();
    if (method === 0 && (flag & 8)) bad.push(name);
    seen += 1;
    at += 46 + nameLen + extraLen + commentLen;
  }
  assert.equal(seen, entries);
  assert.ok(Object.keys(s.files).some((k) => k.startsWith('word/media/')), 'the document has pictures, or this proves nothing');
  assert.deepEqual(bad, []);
});

test('stream: the zip is handed over in pieces and only the last one is final', async () => {
  const s = await stream(await picturesPdf(2));
  assert.ok(s.chunks.length > 3, `pieces: ${s.chunks.length}`);
  assert.equal(s.finals.filter(Boolean).length, 1);
  assert.equal(s.finals[s.finals.length - 1], true);
});

test('stream: a page is serialised and dropped: model.pages stays empty and the sink sees every page once, in order', async () => {
  const bytes = await makePdf((pages, ctx) => text(pages, ctx, 'a'), { pages: [[595, 842], [595, 842], [400, 600]] });
  const seen = [];
  const { model, stats } = await pdfToDocModel({ pdfjs, fflate, data: bytes, onPage: (pg, i) => { seen.push([i, pg.widthPt]); } });
  assert.deepEqual(model.pages, []);
  assert.deepEqual(seen.map((s) => s[0]), [1, 2, 3]);
  assert.equal(seen[2][1], 400);
  assert.equal(stats.pages, 3);
});

test('stream: a sink that throws is the caller\'s failure, not a quiet "page error"', async () => {
  const bytes = await makePdf((pages, ctx) => text(pages, ctx, 'a'), { pages: [[595, 842], [595, 842]] });
  await assert.rejects(pdfToDocModel({ pdfjs, fflate, data: bytes, onPage: () => { throw new Error('disk full'); } }), /disk full/);
});

// ---- the byte-capped cache --------------------------------------------------------------------
test('ByteCappedCache: holds at most maxBytes, evicts the least recently USED first, and a get refreshes', () => {
  const v = (n) => ({ bytes: new Uint8Array(n) });
  const c = new ByteCappedCache(100);
  c.set('a', v(40)); c.set('b', v(40));
  assert.equal(c.get('a') !== undefined, true); // a is now the freshest
  c.set('c', v(40)); // 120 > 100: evict the stalest, which is b
  assert.deepEqual([c.has('a'), c.has('b'), c.has('c')], [true, false, true]);
  assert.equal(c.bytes, 80);
  assert.equal(c.evictions, 1);
  c.set('a', v(10)); // replacing an entry replaces its bytes, it does not add
  assert.equal(c.bytes, 50);
  c.set('big', v(500)); // an entry larger than the cap is kept alone, never an empty cache that re-encodes forever
  assert.equal(c.size, 1);
  assert.equal(c.has('big'), true);
});

test('stream: a cache too small to keep anything evicts constantly and the document is still whole (every picture present, package clean)', async () => {
  const s = await stream(await picturesPdf(4), { limits: { imageCacheBytes: 1 } });
  assert.equal(s.writer.mediaCount, 4);
  assert.ok(s.stats.imageCacheEvictions >= 3, `evictions: ${s.stats.imageCacheEvictions}`);
  assert.deepEqual(packageIsClean(s.files), []);
});

// ---- limits -----------------------------------------------------------------------------------
test('limits: input too large, too many pages (refuse and truncate), output too large: each its own code', async () => {
  const bytes = await picturesPdf(4);
  await assert.rejects(stream(bytes, { limits: { maxInputBytes: 100 } }), (e) => e instanceof LimitError && e.code === 'input-too-large' && e.detail.bytes === bytes.length);
  await assert.rejects(stream(bytes, { limits: { maxPages: 2 } }), (e) => e.code === 'too-many-pages' && e.detail.pages === 4 && e.detail.max === 2);
  const t = await stream(bytes, { limits: { maxPages: 2, overPages: 'truncate' } });
  assert.equal(t.writer.pages, 2);
  assert.equal(t.stats.truncated, 2);
  assert.deepEqual(packageIsClean(t.files), []);
  const whole = await stream(bytes);
  assert.ok(whole.writer.mediaBytes < whole.writer.outBytes);
  // the pictures alone are over the cap: stopped while the pages are still being read
  await assert.rejects(stream(bytes, { limits: { maxOutputBytes: whole.writer.mediaBytes - 1 } }), (e) => e.code === 'output-too-large' && /pictures alone/.test(e.message));
  // the pictures fit but the finished zip does not: stopped when the bytes leave the writer
  await assert.rejects(stream(bytes, { limits: { maxOutputBytes: whole.writer.mediaBytes + 1 } }), (e) => e.code === 'output-too-large' && !/pictures alone/.test(e.message));
  const ok = await stream(bytes, { limits: { maxPages: 4, maxInputBytes: bytes.length, maxOutputBytes: 1e9 } });
  assert.equal(ok.stats.truncated, 0, 'at the cap is allowed');
});

test('limits: the per-call maxPages narrows the run and the policy cap narrows it further', async () => {
  const bytes = await picturesPdf(4);
  const r = await stream(bytes, { maxPages: 3, limits: { maxPages: 2, overPages: 'truncate' } });
  assert.equal(r.writer.pages, 2);
});

test('limits: the defaults stop nothing', () => {
  assert.equal(DEFAULT_LIMITS.maxInputBytes, Infinity);
  assert.equal(DEFAULT_LIMITS.maxPages, Infinity);
  assert.equal(DEFAULT_LIMITS.maxOutputBytes, Infinity);
});

// ---- cancel -----------------------------------------------------------------------------------
test('cancel: aborting between pages rejects with AbortError and the zip is never finished', async () => {
  const bytes = await picturesPdf(5);
  const ctl = new AbortController();
  const finals = [];
  await assert.rejects(
    convertPdfToDocxStream({ pdfjs, fflate, data: bytes, signal: ctl.signal, onChunk: (c, f) => { finals.push(f); }, onProgress: (i) => { if (i === 2) ctl.abort(); } }),
    (e) => e.name === 'AbortError',
  );
  assert.equal(finals.includes(true), false, 'no final chunk: nobody can mistake a half document for a whole one');
});

test('cancel: an abort that lands during the LAST page still rejects and still finishes nothing', async () => {
  const bytes = await picturesPdf(3);
  const ctl = new AbortController();
  const finals = [];
  await assert.rejects(
    convertPdfToDocxStream({ pdfjs, fflate, data: bytes, signal: ctl.signal, onChunk: (c, f) => { finals.push(f); }, onProgress: (i, n) => { if (i === n) ctl.abort(); } }),
    (e) => e.name === 'AbortError',
  );
  assert.equal(finals.includes(true), false);
});

// ---- the writer's spill behaviour -------------------------------------------------------------
function twoPictureDoc() {
  const mk = (seed) => ({ kind: 'img', bytes: new Uint8Array(2000).fill(seed), ext: 'jpeg', widthPt: 10, heightPt: 10 });
  const img = (bytes) => ({ kind: 'img', bytes, ext: 'jpeg', box: { x0: 10, y0: 10, x1: 50, y1: 50 } });
  const a = mk(1); const b = mk(2);
  const page = (bytes) => ({ widthPt: 595, heightPt: 842, segments: [{ cols: 1, space: 0, marginPt: { top: 36, right: 36, bottom: 36, left: 36 }, blocks: [] }], anchors: [img(bytes.bytes)] });
  return { title: 't', pages: [page(a), page(b)] };
}

test('writer stream: a small document keeps the canonical order (content types first, media last); a big one spills its media first and is still a clean package', () => {
  const run = (spoolBytes) => {
    const chunks = [];
    const s = createDocxStream({ fflate, spoolBytes, onChunk: (c) => { chunks.push(c.slice()); } });
    for (const p of twoPictureDoc().pages) s.addPage(p);
    s.finish();
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0; for (const c of chunks) { out.set(c, at); at += c.length; }
    return { names: Object.keys(fflate.unzipSync(out)), files: fflate.unzipSync(out), stats: s.stats };
  };
  const small = run(1e9);
  assert.equal(small.names[0], '[Content_Types].xml');
  assert.deepEqual(small.names.slice(-2), ['word/media/image1.jpeg', 'word/media/image2.jpeg']);
  assert.equal(small.stats.spilled, false);
  const big = run(1);
  assert.equal(big.stats.spilled, true);
  assert.deepEqual(big.names.filter((n) => n.startsWith('word/media/')).sort(), ['word/media/image1.jpeg', 'word/media/image2.jpeg']);
  assert.ok(big.names.includes('[Content_Types].xml') && big.names.includes('word/document.xml'));
  assert.deepEqual(packageIsClean(big.files), []);
  assert.deepEqual(packageIsClean(small.files), []);
  assert.equal(big.files['word/media/image2.jpeg'].length, 2000, 'a spilled picture keeps all its bytes');
});

test('writer: buildDocx still equals itself run twice (fixed zip timestamps: equal input, equal bytes)', () => {
  const doc = twoPictureDoc();
  const a = buildDocx(doc, { fflate });
  const b = buildDocx(doc, { fflate });
  assert.equal(Buffer.compare(Buffer.from(a), Buffer.from(b)), 0);
});

// ---- the device policy ------------------------------------------------------------------------
test('policy: phones and low-memory devices get the phone class, a desktop gets the desktop class; force wins', () => {
  const ua = (s) => ({ userAgent: s });
  assert.equal(assessDevice({ nav: ua('Mozilla/5.0 (Linux; Android 13; Pixel 7) Mobile Safari') }).class, 'phone');
  assert.equal(assessDevice({ nav: ua('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)') }).class, 'phone');
  assert.equal(assessDevice({ nav: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)', deviceMemory: 2 } }).class, 'phone');
  assert.equal(assessDevice({ nav: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', deviceMemory: 8 } }).class, 'desktop');
  assert.equal(assessDevice({ nav: ua('Mozilla/5.0 (Macintosh)') }).class, 'desktop', 'no deviceMemory (Safari, Firefox) is not "low memory"');
  assert.equal(assessDevice({ nav: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', maxTouchPoints: 5 } }).class, 'phone', 'an iPad that claims to be a Mac');
  assert.equal(assessDevice({ nav: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari', maxTouchPoints: 0 } }).class, 'desktop');
  assert.equal(assessDevice({ force: 'phone', nav: ua('Macintosh') }).class, 'phone');
});

test('policy: limitsFor returns exactly the keys stream.js reads, and the phone class is the stricter one on every cap', () => {
  const l = limitsFor(assessDevice({ force: 'phone' }));
  assert.deepEqual(Object.keys(l).sort(), ['imageCacheBytes', 'maxInputBytes', 'maxOutputBytes', 'maxPages', 'overPages', 'spoolBytes']);
  for (const k of ['maxInputBytes', 'maxPages', 'maxOutputBytes', 'imageCacheBytes', 'spoolBytes']) assert.ok(CLASSES.phone[k] < CLASSES.desktop[k], k);
  assert.ok(['refuse', 'truncate'].includes(l.overPages));
});
