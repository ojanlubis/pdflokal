/*
 * PDFLokal — v2/download-sheet.js  (the Unduh sheet: the OUTPUT pipeline)
 * ============================================================================
 * Founder-approved design (simulated first, Jul 2): conversions and
 * compression are OUTPUT FORMATS, not editing verbs — so they live here, on
 * the way out, and the toolbar stays pure. Axes: Format (PDF | Gambar) ×
 * Ukuran × Halaman. Decisions locked: ONE compress preset · JPG default (no
 * AVIF — canvas can't encode it, old devices can't read it) · many images =
 * one ZIP · "Pilih halaman" reuses Kelola Halaman, never a second picker.
 *
 * The 90% path stays 2 taps: defaults are already right (PDF·Asli·Semua) and
 * the big button is always armed. Opening the sheet starts building the real
 * PDF in the background, so the size on the button is TRUE — and by the time
 * most people tap, the bytes are ready: the sheet is a perf win in disguise.
 */

import { buildPdfBytes } from '../core/export.js';
import { ensurePdfJs, ensurePdfLib, ensureFflate } from '../core/vendor.js';
import { track } from '../lib/analytics.js';
import { tel } from './telemetry.js';
import { failureReason } from '../core/failure-reason.js';
import { durationBucket } from '../core/telemetry-schema.js';
import { showStamp } from './celebrate.js';

// WHAT TO SAY WHEN IT FAILS, AND WHEN NOT TO SAY "TRY AGAIN".
// Founder ruling via PM, 2026-07-29: advice that cannot work is worse than no
// advice, because it converts OUR failure into THEIR wasted effort. On
// 2026-07-28 one user pressed Unduh 41 times against a document that could
// never export, because the toast told them to try again every single time.
// Retry survives only where a retry can genuinely change the outcome.
// COPY IS PLACEHOLDER - client-facing words are Fauzan's, per the seat.
// Exported for tests: the rule is "which failures can a retry actually change",
// and it has to be checkable, not just commented.
export const RETRYABLE = new Set(['unknown', 'timeout', 'out-of-memory']);
export function failMessage(reason) {
  // The retry sentence is gated on the SET, never on a default branch, so a new
  // reason added to the schema cannot quietly inherit "try again".
  if (RETRYABLE.has(reason)) return 'Waduh, gagal membuat file. Coba sekali lagi ya'; // TODO(copy)
  switch (reason) {
    case 'encrypted': return 'PDF ini terkunci, jadi nggak bisa disimpan ulang'; // TODO(copy)
    case 'corrupt': return 'File PDF ini rusak, jadi nggak bisa dibuat ulang'; // TODO(copy)
    case 'unsupported': return 'Ada huruf yang nggak bisa disimpan. Cek teks yang kamu tulis ya'; // TODO(copy)
    default: return 'Waduh, gagal membuat file'; // TODO(copy) - no retry advice for an unknown-to-us reason
  }
}

const COMPRESS_QUALITY = 0.72; // the "Otomatis" preset — one sane default, still
const COMPRESS_MAXDIM = 1600;  // the right answer when the user has no hard cap.

// The founder call used to be "the ONE preset, no levels until data asks."
// The data asked. Every long-tail query under "kompres pdf" in Indonesia is a
// SIZE: "kompres pdf 500kb", "kompres pdf 1mb", "kompres pdf 100kb" — because
// CPNS, SNBP and e-filing portals reject a berkas over a hard cap. These are the
// caps people actually type. See compressToTargetBytes() in js/core/compress.js.
const TARGETS = [
  { v: null, label: 'Otomatis' },
  { v: 2 * 1024 * 1024, label: '2 MB' },
  { v: 1024 * 1024, label: '1 MB' },
  { v: 500 * 1024, label: '500 KB' },
  { v: 200 * 1024, label: '200 KB' },
  { v: 100 * 1024, label: '100 KB' },
];
const IMG_DIMS = { asli: null, sedang: 1500, kecil: 800 };

// Show KB right up to 1 MB, not just below 0.1 MB. The upload caps people fight
// with are quoted in KB ("maksimal 500KB"), so a result rendered "0,33 MB" makes
// the user do the conversion themselves at exactly the moment they're anxious
// about whether it fits. "335 KB" answers the question they actually have.
function fmtMB(bytes) {
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${mb.toFixed(1).replace('.', ',')} MB`;
}

// deps = {
//   modal, getDoc, getBaseName,
//   pickPages: () => Promise<pageIds[]|null>   — opens Kelola Halaman in pick mode
//   download: (blob, filename) => void
//   toast: (msg) => void
// }
export function createDownloadSheet(deps) {
  const { modal } = deps;
  const el = (id) => modal.querySelector(id);

  const state = {
    format: 'pdf', imgfmt: 'jpg', size: 'asli', target: null, picked: null, // null = semua / no cap
    base: null,        // { bytes, size } — the real built PDF for current selection
    compressed: null,  // { bytes, size, unchanged }
    buildError: null,  // the error that PREVENTED base — rethrown at the CTA so the
                       // rail reports the cause, not our own 'build missing' symptom

    building: false, compressing: false, exporting: false,
    seq: 0,            // invalidates in-flight builds when selection changes
  };

  // ---- real bytes (built lazily, cached per sheet-open + page selection) ------
  function selectedPages() {
    const doc = deps.getDoc();
    if (!state.picked) return doc.pages;
    return doc.pages.filter((p) => state.picked.includes(p.id));
  }

  // ---- the image path's fallback source (2026-08-09) ---------------------------
  //
  // THE BUG THIS EXISTS FOR. `buildBase()` runs pdf-lib's buildPdfBytes the
  // moment the sheet opens, whatever format is selected. pdf-lib throws on an
  // encrypted source and has no decrypt path anywhere in this stack, so
  // `state.base` stays null — and the IMAGE branch of doExport then threw
  // `state.buildError` before it ever reached renderPdfToImages, which is pure
  // PDF.js and contains no pdf-lib at all. PDF.js implements the standard
  // security handler, so it rasterizes these files perfectly: measured against
  // a plain control, an owner-locked RC4 file and an owner-locked AES-256
  // file, renderPdfToImages on the RAW BYTES returned byte-identical output for
  // all three. We were refusing an export we can perform, and saying "PDF ini
  // terkunci, jadi nggak bisa disimpan ulang" — true of the PDF format, false
  // of images.
  //
  // ⚠️ WHY THIS IS NOT SIMPLY "rasterize the source bytes on the image path".
  // The normal image export rasterizes the BUILT pdf, which carries every
  // annotation, signature and baked edit. Falling back to the source bytes
  // unconditionally would silently drop all of them from every image export —
  // trading a loud honest refusal for quiet data loss, which is the same trade
  // `ignoreEncryption` offers and the same one we refused there. So the
  // fallback is used ONLY when the build actually failed, and only when the
  // source bytes are provably the whole truth for the selected pages:
  //   - exactly ONE source, and it is a PDF (nothing to compose);
  //   - NO annotations on any selected page (nothing to lose);
  //   - NO user rotation on any selected page (renderPdfToImages honours the
  //     intrinsic /Rotate, and has no way to apply a further turn).
  // Anything else keeps throwing the real build error, which is the honest
  // answer. Returns { bytes, pageNumbers } or null.
  function imageFallbackSource() {
    const doc = deps.getDoc();
    if (!doc || doc.sources?.length !== 1) return null;
    const pages = selectedPages();
    if (!pages.length) return null;
    if (pages.some((p) => p.isFromImage || p.annotations?.length || (p.rotation || 0) !== 0)) return null;
    const bytes = doc.sources[0].bytes;
    if (!bytes?.length) return null;
    return { bytes, pageNumbers: pages.map((p) => p.sourcePageNum + 1) };
  }

  async function buildBase() {
    const seq = ++state.seq;
    state.base = null;
    state.compressed = null;
    state.buildError = null;
    state.building = true;
    render();
    try {
      const doc = deps.getDoc();
      const subset = { sources: doc.sources, pages: selectedPages(), selection: { pageId: null, annotationId: null } };
      // pdf-lib + fontkit are export-only, so they're fetched here rather than at
      // page load. Opening the sheet is what signals the intent to download.
      const { PDFLib, fontkit } = await ensurePdfLib();
      const bytes = await buildPdfBytes(subset, { PDFLib, fontkit });
      if (seq !== state.seq) return; // selection changed mid-build
      state.base = { bytes, size: bytes.length };
    } catch (err) {
      console.error(err);
      // ⚠️ KEEP THE ERROR. This is where an export ACTUALLY fails — the build,
      // not the download click. Until 2026-07-28 it died right here: logged to
      // the user's own console, toasted, and dropped. `doExport` later found
      // `state.base` empty and threw its own `new Error('build missing')`, so
      // the failure that reached the rail carried none of the original
      // identity. One user's 41 consecutive failures all recorded
      // `reason: 'unknown'` for that reason, and no classifier could have
      // rescued them — by the time anything asked "why", the why was gone.
      if (seq === state.seq) {
        state.buildError = err;
        // Classify HERE too: this toast fires when the sheet opens, which is
        // the first moment the user learns anything is wrong.
        //
        // ...but ONLY when the failure actually blocks the format in front of
        // the user. Arriving from /pdf-ke-gambar with a locked file opens this
        // sheet on Gambar, where the export will succeed from the source bytes
        // — telling them it "can't be saved" would be a lie about the very
        // thing they are about to do successfully.
        if (state.format === 'pdf' || !imageFallbackSource()) {
          deps.toast(failMessage(failureReason(err)));
        }
      }
    } finally {
      if (seq === state.seq) { state.building = false; render(); }
    }
    // Rebuilding invalidated any compressed bytes. If Compress is STILL the
    // selected size, re-run it now — otherwise the CTA would reach for bytes
    // that no longer exist (founder-caught: compress → re-pick pages → stuck).
    if (seq === state.seq && state.base && state.format === 'pdf' && state.size === 'kompres') {
      buildCompressed();
    }
  }

  async function buildCompressed() {
    if (state.compressed || state.compressing) return;
    const seq = state.seq;
    state.compressing = true;
    render();
    try {
      // Wait for the base build if it's still running.
      while (state.building && seq === state.seq) {
        await new Promise((r) => setTimeout(r, 120));
      }
      if (seq !== state.seq || !state.base) return;
      // compress.js rasterizes with pdf.js and rebuilds with pdf-lib, taking both
      // off globalThis. pdf-lib is already up (buildBase needed it), but pdf.js
      // may NOT be — a doc built from images alone never imported a PDF. Ensure
      // both; the already-loaded one resolves instantly.
      const [{ compressPdfBytes, compressToTargetBytes }] = await Promise.all([
        import('../core/compress.js'), ensurePdfJs(), ensurePdfLib(),
      ]);
      const target = state.target;
      const out = target
        // Hunt for the highest quality that fits under the user's hard cap. Costs
        // ~3 rebuild passes (binary search over the ladder), so narrate it.
        ? await compressToTargetBytes(state.base.bytes, {
          targetBytes: target,
          onProgress: ({ pass }) => {
            if (seq !== state.seq) return;
            const m = el('#ds-cta-main');
            if (m) m.textContent = `Mencari ukuran yang pas… (percobaan ${pass})`;
          },
        })
        : await compressPdfBytes(state.base.bytes, {
          quality: COMPRESS_QUALITY, maxDim: COMPRESS_MAXDIM,
        });
      if (seq !== state.seq) return;
      // reachedTarget is carried through so the UI can be HONEST when we couldn't
      // make the cap. A berkas the user believes is 500 KB but isn't gets silently
      // rejected by the portal — worse than one they know is too big. It is
      // `true` for the no-target path (there was no cap to miss).
      state.compressed = {
        bytes: out.bytes, size: out.size, unchanged: out.unchanged,
        target, reachedTarget: out.reachedTarget ?? true,
      };
      // SUDAH OPTIMAL: the honesty guard gets a face. The file was already as
      // small as it honestly gets — we say so with a stamp instead of faking
      // savings. Stamped INTO the dialog (top layer covers body-fixed elements).
      if (out.unchanged && modal.open) {
        showStamp('Sudah optimal', { duration: 1300, host: modal });
      }
    } catch (err) {
      console.error(err);
      if (seq === state.seq) { state.size = 'asli'; deps.toast('Kompres gagal, kami pakai ukuran asli ya'); }
    } finally {
      // Clear the flag UNCONDITIONALLY (review H1): a run superseded by ++seq
      // must not leave `compressing` wedged true — that blocked every future
      // buildCompressed via its own re-entry guard, and doExport's wait loop
      // never exited (Compress dead for the whole session). Single-flight
      // makes the unconditional clear safe: the guard prevents a second run
      // while this one is alive.
      state.compressing = false;
      if (seq === state.seq) {
        render();
      } else if (state.format === 'pdf' && state.size === 'kompres' && !state.compressed) {
        // Superseded while Compress is still what the user wants → restart
        // for the NEW selection (this run's result was for stale pages).
        buildCompressed();
      }
    }
  }

  // ---- render -------------------------------------------------------------------
  function segSync(rootId, val) {
    for (const b of el(rootId).querySelectorAll('button')) {
      b.classList.toggle('on', b.dataset.v === val);
    }
  }

  function render() {
    const doc = deps.getDoc();
    const nAll = doc.pages.length;
    const n = state.picked ? state.picked.length : nAll;

    el('#ds-meta').textContent = `${deps.getBaseName()}.pdf · ${nAll} hal` +
      (state.base ? ` · ${fmtMB(state.base.size)}` : '');

    segSync('#ds-format', state.format);
    el('#ds-row-imgfmt').hidden = state.format !== 'img';
    segSync('#ds-imgfmt', state.imgfmt);

    // Ukuran row depends on format.
    const sizeRow = el('#ds-size');
    sizeRow.innerHTML = '';
    const mkBtn = (v, label, subHtml) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.v = v;
      b.innerHTML = `${label}${subHtml ? `<small>${subHtml}</small>` : ''}`;
      if (state.size === v) b.classList.add('on');
      b.addEventListener('click', () => {
        state.size = v;
        if (state.format === 'pdf' && v === 'kompres') buildCompressed();
        render();
      });
      sizeRow.appendChild(b);
    };
    if (state.format === 'pdf') {
      if (!['asli', 'kompres'].includes(state.size)) state.size = 'asli';
      mkBtn('asli', 'Asli', state.base ? fmtMB(state.base.size) : '<span class="ds-spin"></span>');
      let sub = 'file lebih kecil';
      if (state.compressing) sub = '<span class="ds-spin"></span> menghitung…';
      else if (state.compressed) {
        sub = state.compressed.unchanged
          ? 'file sudah optimal'
          : `${fmtMB(state.compressed.size)} · <span class="ds-hemat">hemat ${Math.round((1 - state.compressed.size / state.base.size) * 100)}%</span>`;
      }
      mkBtn('kompres', 'Compress', sub);
    } else {
      state.target = null; // image export has its own size row; no PDF cap applies
      if (!['asli', 'sedang', 'kecil'].includes(state.size)) state.size = 'sedang';
      mkBtn('asli', 'Asli', '100%');
      mkBtn('sedang', 'Sedang', '1500px');
      mkBtn('kecil', 'Kecil', '800px');
    }

    // Target row: only meaningful when compressing a PDF.
    const showTarget = state.format === 'pdf' && state.size === 'kompres';
    el('#ds-row-target').hidden = !showTarget;
    if (showTarget) {
      const row = el('#ds-target');
      row.innerHTML = '';
      for (const t of TARGETS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = t.label;
        if (state.target === t.v) b.classList.add('on');
        b.addEventListener('click', () => {
          if (state.target === t.v) return;
          state.target = t.v;
          state.compressed = null; // the old result was for a different cap
          buildCompressed();
          render();
        });
        row.appendChild(b);
      }
    }

    segSync('#ds-pages', state.picked ? 'some' : 'all');
    el('#ds-all-sub').textContent = `${nAll} halaman`;
    el('#ds-some-sub').innerHTML = state.picked ? `${n} dipilih` : '&nbsp;';

    // CTA
    const main = el('#ds-cta-main');
    const sub = el('#ds-cta-sub');
    const halTxt = state.picked ? ` (${n} hal.)` : '';
    if (state.format === 'pdf') {
      const src = state.size === 'kompres' ? state.compressed : state.base;
      const busy = state.size === 'kompres' ? (state.compressing || state.building) : state.building;
      main.innerHTML = `Unduh PDF${halTxt}${busy ? ' · <span class="ds-spin ds-spin-lite"></span>' : (src ? ` · ${fmtMB(src.size)}` : '')}`;
      const c = state.compressed;
      if (state.size === 'kompres' && c && c.target && !c.reachedTarget) {
        // THE HONEST MISS. We could not get under the cap. Say so plainly and give
        // the user the one lever that actually works next (fewer pages) — never
        // imply the berkas will pass when it won't.
        const cap = TARGETS.find((t) => t.v === c.target)?.label ?? fmtMB(c.target);
        sub.textContent = `paling kecil yang bisa: ${fmtMB(c.size)}, belum masuk ${cap}. Coba buang halaman yang nggak perlu.`;
        sub.hidden = false;
      } else if (state.size === 'kompres' && c && c.target && c.reachedTarget) {
        const cap = TARGETS.find((t) => t.v === c.target)?.label ?? fmtMB(c.target);
        sub.textContent = `${fmtMB(c.size)}, muat di bawah ${cap}`;
        sub.hidden = false;
      } else if (state.size === 'kompres' && c && !c.unchanged) {
        sub.textContent = `hemat ${Math.round((1 - c.size / state.base.size) * 100)}% dari ${fmtMB(state.base.size)}`;
        sub.hidden = false;
      } else if (state.size === 'kompres' && c?.unchanged) {
        sub.textContent = 'udah paling kecil, nggak bisa dikompres lagi tanpa merusak';
        sub.hidden = false;
      } else {
        sub.hidden = true;
      }
    } else {
      main.textContent = n === 1 ? 'Unduh 1 Gambar' : `Unduh ${n} Gambar · ZIP`;
      sub.textContent = `${state.imgfmt.toUpperCase()} · ${state.size === 'asli' ? 'ukuran asli' : `${IMG_DIMS[state.size]}px`}`;
      sub.hidden = false;
    }
    el('#ds-cta').disabled = state.exporting;
  }

  // ---- interactions ----------------------------------------------------------------
  el('#ds-format').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.format = b.dataset.v;
    state.size = state.format === 'pdf' ? 'asli' : 'sedang';
    render();
  });
  el('#ds-imgfmt').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.imgfmt = b.dataset.v;
    render();
  });
  el('#ds-pages').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.v === 'all') {
      if (state.picked) { state.picked = null; buildBase(); }
      render();
      return;
    }
    const ids = await deps.pickPages(state.picked || []);
    if (ids && ids.length) {
      state.picked = ids;
      buildBase(); // subset PDF differs → rebuild + invalidate compress
    }
    render();
  });

  el('#ds-cta').addEventListener('click', doExport);
  el('#ds-close').addEventListener('click', () => modal.close());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.close(); });

  async function doExport() {
    if (state.exporting) return;
    state.exporting = true;
    render();
    const seq = state.seq;
    const t0 = performance.now(); // spec-telemetry.md §3 export.duration — tap to bytes-in-hand
    try {
      // Belt-and-braces: if Compress is selected but its bytes are missing and
      // nothing is computing them (any invalidation path), start it here.
      if (state.format === 'pdf' && state.size === 'kompres' && !state.compressed && !state.compressing) {
        buildCompressed();
      }
      // Any in-flight build: the tap means "when it's ready".
      while ((state.building || (state.format === 'pdf' && state.size === 'kompres' && (state.compressing || !state.compressed))) && seq === state.seq) {
        await new Promise((r) => setTimeout(r, 120));
      }
      if (seq !== state.seq) return;
      const baseName = deps.getBaseName();
      const n = state.picked ? state.picked.length : deps.getDoc().pages.length;

      if (state.format === 'pdf') {
        const src = state.size === 'kompres' ? state.compressed : state.base;
        // Rethrow the REAL build error when we have it. `build missing` is the
        // symptom (no bytes); state.buildError is the cause, and the cause is
        // what the rail needs. Without this the catch below can only ever
        // classify our own placeholder, which names nothing.
        if (!src) throw state.buildError || new Error('build missing');
        // No success toast: the BERES stamp (download chokepoint) is the one voice.
        deps.download(new Blob([src.bytes], { type: 'application/pdf' }), `${baseName}-pdflokal.pdf`);
      } else {
        // The built PDF when we have it (it carries the annotations); the raw
        // source otherwise, but only where that is provably the whole truth —
        // see imageFallbackSource's own WHY. A locked PDF lands here: pdf-lib
        // refused to build, PDF.js rasterizes it fine.
        const fallback = state.base ? null : imageFallbackSource();
        if (!state.base && !fallback) throw state.buildError || new Error('build missing');
        const imgBytes = state.base ? state.base.bytes : fallback.bytes;
        // renderPdfToImages rasterizes with pdf.js; zipFiles zips with fflate.
        // Both come off globalThis, so both must be up before we call in.
        const [{ renderPdfToImages, zipFiles }] = await Promise.all([
          import('../core/export-images.js'), ensurePdfJs(), ensureFflate(),
        ]);
        // Punch list #5: rendering N pages to images is real work — narrate it
        // on the CTA so "working" never looks like "hung". Surgical text update,
        // never a full render() mid-export.
        const main = el('#ds-cta-main');
        const files = await renderPdfToImages(imgBytes, {
          format: state.imgfmt, maxDim: IMG_DIMS[state.size], baseName: `${baseName}-hal`,
          // Only the fallback needs this: the built PDF already contains just
          // the selected pages, in order, so its own 1..n IS the selection.
          pageNumbers: fallback ? fallback.pageNumbers : null,
          onProgress: ({ done, total }) => {
            main.textContent = `Menyiapkan gambar ${done}/${total}…`;
          },
        });
        if (seq !== state.seq) return;
        // renderPdfToImages names each file after its page number in the
        // document it was handed. On the built-PDF path that is already the
        // display position; on the fallback it is the SOURCE page number, so
        // extracting pages 5 and 9 would hand the user "…-hal-5" and
        // "…-hal-9". Renumber so both paths produce identical filenames —
        // a fallback the user can SEE they were given is a fallback that
        // needs explaining.
        if (fallback) {
          files.forEach((f, i) => { f.name = f.name.replace(/-\d+(\.[a-z]+)$/, `-${i + 1}$1`); });
        }
        if (files.length === 1) {
          const mime = state.imgfmt === 'png' ? 'image/png' : 'image/jpeg';
          deps.download(new Blob([files[0].bytes], { type: mime }), files[0].name);
        } else {
          main.textContent = 'Membungkus jadi ZIP…';
          await new Promise((r) => setTimeout(r, 30)); // let the label paint before the sync zip
          const zip = zipFiles(files);
          deps.download(new Blob([zip], { type: 'application/zip' }), `${baseName}-gambar.zip`);
          deps.toast(`Selesai! ${n} gambar dibungkus jadi satu ZIP`);
        }
      }
      // Richer than the old event: the CHOICES are the product signal now.
      track('download', {
        tool: 'editor-v2',
        format: state.format === 'pdf' ? 'pdf' : state.imgfmt,
        size: state.size,
        pages: state.picked ? 'some' : 'all',
      });
      // surgery_used/fallback are DELIBERATE CONSTANTS, not placeholders: the
      // ladder (core/page-surgery.js) shipped long ago and its real per-edit
      // signal flows through the `surgery`/`insert` events instead. Deleting
      // these two fields is HELD by seat ruling (commit 7c2a064, refused
      // 2026-08-09): removing a prop from the shared SCHEMA blanks the whole
      // event for cached PWA clients — a silent data hole traded for a
      // cosmetic one. Until that trade changes, they ship as false/'none'.
      tel('export', {
        surgery_used: false,
        fallback: 'none',
        duration: durationBucket(performance.now() - t0),
        // The CHOICES — same values the GA4 event above carries, now first-party
        // too: what they came to DO (compress? to image? extract pages?) instead
        // of just "a download happened". format normalises img→png/jpg like GA4.
        format: state.format === 'pdf' ? 'pdf' : state.imgfmt,
        size: state.size,
        pages_scope: state.picked ? 'some' : 'all',
      });
      modal.close();
    } catch (err) {
      console.error(err);
      // WHY this branches: a protected PDF can NEVER be written back — pdf-lib
      // has no decryption — so "Coba sekali lagi ya" tells the user to retry
      // the one thing that cannot possibly work, after they may have edited a
      // 444-page document. The generic message stays for genuinely transient
      // failures, where retrying IS the right advice.
      //
      // The check is the SOURCE's own recorded fact (core/import.js read it
      // from the document at import), never the thrown error's message — an
      // error string can quote document content, and the rail is content-blind.
      const encrypted = (deps.getDoc()?.sources || []).some((s) => s.encrypted);
      // COPY IS PLACEHOLDER — client-facing words are Fauzan's, per the seat.
      const reason = encrypted ? 'encrypted' : failureReason(err);
      deps.toast(failMessage(reason));
      // The rail's failure event (spec: schema `failure`). Content-blind: the
      // stage and a bucketed reason, never the error text or the file name.
      //
      // ⚠️ `reason` USED TO BE THE LITERAL 'unknown' HERE. On 2026-07-28 one
      // user hit 41 consecutive export failures in 82 minutes and every single
      // one recorded 'unknown' — not because the classifier failed to name the
      // error, but because it was never asked. 41 samples of a constant.
      //
      // The document's OWN recorded fact still wins over anything derived from
      // the throw: core/import.js read `encrypted` off the document at import,
      // which is more reliable than matching a library's wording.
      // class:'none' — no character was refused here; the axis is the commit
      // path's. blocked:true — reaching this catch means no file was produced,
      // which is the definition of stopped. (Both props added 2026-08-09; see
      // the failure event in core/telemetry-schema.js.)
      tel('failure', { stage: 'export', reason, class: 'none', blocked: true });
    } finally {
      state.exporting = false;
      render();
    }
  }

  return {
    // preset: optional starting configuration from the intent hook (?buat=) —
    // e.g. { size: 'kompres' } for Kompres PDF, { format: 'img' } for PDF→Gambar.
    open(preset = {}) {
      if (modal.open) return; // double Ctrl+S / double-tap: showModal throws on open dialogs
      state.format = preset.format === 'img' ? 'img' : 'pdf';
      state.imgfmt = 'jpg';
      state.size = preset.size === 'kompres' && state.format === 'pdf' ? 'kompres' : 'asli';
      // A target cap arrives from /kompres-pdf-500kb and friends. Only honour one
      // we actually offer — never trust a number straight off a URL/attribute.
      state.target = state.size === 'kompres' && TARGETS.some((t) => t.v === preset.target)
        ? preset.target
        : null;
      state.picked = null;
      state.compressed = null;
      state.compressing = false; // belt-and-braces vs any historic flag leak
      state.exporting = false;
      modal.showModal();
      buildBase(); // truth on the button + pre-warmed bytes for the 90% path
      // buildBase's tail re-runs buildCompressed when size is already 'kompres'.
    },
  };
}
