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
import { showStamp } from './celebrate.js';

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
    building: false, compressing: false, exporting: false,
    seq: 0,            // invalidates in-flight builds when selection changes
  };

  // ---- real bytes (built lazily, cached per sheet-open + page selection) ------
  function selectedPages() {
    const doc = deps.getDoc();
    if (!state.picked) return doc.pages;
    return doc.pages.filter((p) => state.picked.includes(p.id));
  }

  async function buildBase() {
    const seq = ++state.seq;
    state.base = null;
    state.compressed = null;
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
      if (seq === state.seq) deps.toast('Waduh, gagal menyiapkan PDF. Coba lagi ya');
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
        sub.textContent = `paling kecil yang bisa: ${fmtMB(c.size)} — belum masuk ${cap}. Coba buang halaman yang nggak perlu.`;
        sub.hidden = false;
      } else if (state.size === 'kompres' && c && c.target && c.reachedTarget) {
        const cap = TARGETS.find((t) => t.v === c.target)?.label ?? fmtMB(c.target);
        sub.textContent = `${fmtMB(c.size)} — muat di bawah ${cap}`;
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
        if (!src) throw new Error('build missing');
        // No success toast: the BERES stamp (download chokepoint) is the one voice.
        deps.download(new Blob([src.bytes], { type: 'application/pdf' }), `${baseName}-pdflokal.pdf`);
      } else {
        if (!state.base) throw new Error('build missing');
        // renderPdfToImages rasterizes with pdf.js; zipFiles zips with fflate.
        // Both come off globalThis, so both must be up before we call in.
        const [{ renderPdfToImages, zipFiles }] = await Promise.all([
          import('../core/export-images.js'), ensurePdfJs(), ensureFflate(),
        ]);
        // Punch list #5: rendering N pages to images is real work — narrate it
        // on the CTA so "working" never looks like "hung". Surgical text update,
        // never a full render() mid-export.
        const main = el('#ds-cta-main');
        const files = await renderPdfToImages(state.base.bytes, {
          format: state.imgfmt, maxDim: IMG_DIMS[state.size], baseName: `${baseName}-hal`,
          onProgress: ({ done, total }) => {
            main.textContent = `Menyiapkan gambar ${done}/${total}…`;
          },
        });
        if (seq !== state.seq) return;
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
      modal.close();
    } catch (err) {
      console.error(err);
      deps.toast('Waduh, gagal membuat file. Coba sekali lagi ya');
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
