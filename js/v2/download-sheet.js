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
import { track } from '../lib/analytics.js';

const COMPRESS_QUALITY = 0.72; // the ONE preset (founder call: no levels until data asks)
const COMPRESS_MAXDIM = 1600;
const IMG_DIMS = { asli: null, sedang: 1500, kecil: 800 };

function fmtMB(bytes) {
  const mb = bytes / (1024 * 1024);
  if (mb < 0.1) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(mb < 1 ? mb.toFixed(2) : mb.toFixed(1)).replace('.', ',')} MB`;
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
    format: 'pdf', imgfmt: 'jpg', size: 'asli', picked: null, // null = semua
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
      const bytes = await buildPdfBytes(subset, { PDFLib: window.PDFLib, fontkit: window.fontkit });
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
      const { compressPdfBytes } = await import('../core/compress.js');
      const out = await compressPdfBytes(state.base.bytes, {
        quality: COMPRESS_QUALITY, maxDim: COMPRESS_MAXDIM,
      });
      if (seq !== state.seq) return;
      state.compressed = { bytes: out.bytes, size: out.size, unchanged: out.unchanged };
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
      if (!['asli', 'sedang', 'kecil'].includes(state.size)) state.size = 'sedang';
      mkBtn('asli', 'Asli', '100%');
      mkBtn('sedang', 'Sedang', '1500px');
      mkBtn('kecil', 'Kecil', '800px');
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
      if (state.size === 'kompres' && state.compressed && !state.compressed.unchanged) {
        sub.textContent = `hemat ${Math.round((1 - state.compressed.size / state.base.size) * 100)}% dari ${fmtMB(state.base.size)}`;
        sub.hidden = false;
      } else if (state.size === 'kompres' && state.compressed?.unchanged) {
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
        deps.download(new Blob([src.bytes], { type: 'application/pdf' }), `${baseName}-pdflokal.pdf`);
        deps.toast(`Selesai! PDF-mu udah diunduh (${fmtMB(src.size)})`);
      } else {
        if (!state.base) throw new Error('build missing');
        const { renderPdfToImages, zipFiles } = await import('../core/export-images.js');
        const files = await renderPdfToImages(state.base.bytes, {
          format: state.imgfmt, maxDim: IMG_DIMS[state.size], baseName: `${baseName}-hal`,
        });
        if (files.length === 1) {
          const mime = state.imgfmt === 'png' ? 'image/png' : 'image/jpeg';
          deps.download(new Blob([files[0].bytes], { type: mime }), files[0].name);
          deps.toast('Selesai! Gambarmu udah diunduh');
        } else {
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
    open() {
      if (modal.open) return; // double Ctrl+S / double-tap: showModal throws on open dialogs
      state.format = 'pdf';
      state.imgfmt = 'jpg';
      state.size = 'asli';
      state.picked = null;
      state.compressed = null;
      state.compressing = false; // belt-and-braces vs any historic flag leak
      state.exporting = false;
      modal.showModal();
      buildBase(); // truth on the button + pre-warmed bytes for the 90% path
    },
  };
}
