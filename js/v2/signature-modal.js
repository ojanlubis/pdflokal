/*
 * PDFLokal — v2/signature-modal.js  (TTD: draw / upload / paraf)
 * ============================================================================
 * Produces ONE thing: { dataUrl, width, height, subtype } handed to the app
 * for tap-to-place. Two sources:
 *   - Gambar: SignaturePad canvas, auto-trimmed to ink bounds (an untrimmed
 *     460×180 pad placed at 150px wide looks comically small — trim first).
 *   - Upload: an image file; white background stripped to transparency by
 *     default (photos of wet-ink signatures — the dominant real-world case).
 * Paraf is the same signature type with subtype 'paraf' and a smaller default
 * placement width — zero extra branches downstream (render/export/undo).
 */

import { ensureSignaturePad } from '../core/vendor.js';

const WHITE_THRESHOLD = 235; // r,g,b all above this → transparent

export function createSignatureModal({ modal, onReady, toast }) {
  const canvas = modal.querySelector('#sig-canvas');
  const fileInput = modal.querySelector('#sig-file');
  const preview = modal.querySelector('#sig-preview');
  const parafCheck = modal.querySelector('#sig-paraf');
  const removeBgCheck = modal.querySelector('#sig-removebg');
  const tabs = modal.querySelectorAll('.sig-tab');
  let pad = null;
  let uploadedImg = null; // HTMLImageElement of the chosen file

  // ---- tabs -----------------------------------------------------------------
  function showTab(name) {
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      t.classList.toggle('on', on);
      t.setAttribute('aria-selected', String(on));
    }
    modal.querySelector('.sig-pane-draw').style.display = name === 'draw' ? '' : 'none';
    modal.querySelector('.sig-pane-upload').style.display = name === 'upload' ? '' : 'none';
  }
  for (const t of tabs) t.addEventListener('click', () => showTab(t.dataset.tab));

  // ---- draw pane ---------------------------------------------------------------
  // async now: SignaturePad (11 KB) is fetched when the sheet opens, not at page
  // load. Sizing the canvas stays synchronous so the pad is never constructed
  // against a zero-size canvas if the fetch is slow.
  async function initPad() {
    // Detach the previous pad's pointer listeners first (review M3): each
    // SignaturePad constructor adds its own set to the SAME canvas — without
    // off(), N modal opens = N pads all drawing every stroke N× thick.
    pad?.off();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = canvas.offsetWidth * dpr;
    canvas.height = canvas.offsetHeight * dpr;
    canvas.getContext('2d').scale(dpr, dpr);
    const SignaturePad = await ensureSignaturePad();
    pad = new SignaturePad(canvas, { minWidth: 1, maxWidth: 2.4 });
  }
  modal.querySelector('#sig-clear').addEventListener('click', () => pad?.clear());

  // ---- upload pane ---------------------------------------------------------------
  // SINGLE SOURCE OF TRUTH for "an image arrived, make it the signature".
  // Two roads reach it — the file picker and the clipboard — and they must land
  // in exactly the same place, including the background-removal step and the
  // ink trim. When these were separate code paths in the old wing, paste and
  // upload could disagree about what a signature was.
  function acceptImageFile(f, { switchTab = false } = {}) {
    if (!f || !f.type.startsWith('image/')) { toast('Pilih file gambar ya'); return; }
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(img.src); // decoded — the blob URL has done its job
      uploadedImg = img;
      if (switchTab) showTab('upload');
      renderUploadPreview();
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); toast('Gagal membaca gambar'); };
    img.src = URL.createObjectURL(f);
  }

  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    acceptImageFile(f);
  });
  removeBgCheck.addEventListener('change', renderUploadPreview);

  /*
   * ---- paste (Ctrl/Cmd+V) --------------------------------------------------
   * ⚠️ THIS IS A RESTORATION, NOT A NEW FEATURE. The changelog has promised it
   * to users: "Pas jendela tanda tangan kebuka, tinggal tempel (Ctrl/Cmd+V),
   * langsung masuk tanpa perlu simpan file dulu." v2 shipped with NO
   * ClipboardEvent handling anywhere in js/v2/, so the product has been claiming
   * a feature it does not have. docs/test-suite-audit.md found it from the other
   * end: signature-paste.spec.js reads as coverage but drives the dead old wing.
   *
   * Restoring is the honest option and the cheap one — retracting the claim
   * would mean rewriting client-facing copy, which is not ours to write.
   *
   * Listener is on `document` because the sheet's own elements are rarely
   * focused (the user has just come from another app with an image on the
   * clipboard), and a paste with nothing focused never reaches the dialog.
   */
  document.addEventListener('paste', (e) => {
    if (!modal.open) return; // only while the signature sheet is up
    for (const item of e.clipboardData?.items || []) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
      const f = item.getAsFile();
      if (!f) continue;
      e.preventDefault();
      acceptImageFile(f, { switchTab: true });
      return;
    }
    // No image on the clipboard: do NOT preventDefault, and do NOT toast.
    // Pasting text while the sheet happens to be open is not an error.
  });

  function processUpload() {
    if (!uploadedImg) return null;
    // Cap the working size — a 4000px camera photo would bloat the PDF.
    const scale = Math.min(1, 1200 / uploadedImg.naturalWidth);
    const c = document.createElement('canvas');
    c.width = Math.round(uploadedImg.naturalWidth * scale);
    c.height = Math.round(uploadedImg.naturalHeight * scale);
    const ctx = c.getContext('2d');
    ctx.drawImage(uploadedImg, 0, 0, c.width, c.height);
    if (removeBgCheck.checked) whiteToTransparent(c);
    return trimToInk(c);
  }

  function renderUploadPreview() {
    const c = processUpload();
    preview.innerHTML = '';
    if (c) preview.appendChild(c);
  }

  // ---- image processing ------------------------------------------------------------
  function whiteToTransparent(c) {
    const ctx = c.getContext('2d');
    const data = ctx.getImageData(0, 0, c.width, c.height);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] > WHITE_THRESHOLD && px[i + 1] > WHITE_THRESHOLD && px[i + 2] > WHITE_THRESHOLD) {
        px[i + 3] = 0;
      }
    }
    ctx.putImageData(data, 0, 0);
  }

  // Crop to the bounding box of non-transparent pixels (+ a small margin).
  function trimToInk(c) {
    const ctx = c.getContext('2d');
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let minX = c.width, minY = c.height, maxX = -1, maxY = -1;
    for (let y = 0; y < c.height; y += 1) {
      for (let x = 0; x < c.width; x += 1) {
        if (data[(y * c.width + x) * 4 + 3] > 10) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null; // fully transparent — nothing to place
    const pad2 = 4;
    minX = Math.max(0, minX - pad2); minY = Math.max(0, minY - pad2);
    maxX = Math.min(c.width - 1, maxX + pad2); maxY = Math.min(c.height - 1, maxY + pad2);
    const out = document.createElement('canvas');
    out.width = maxX - minX + 1;
    out.height = maxY - minY + 1;
    out.getContext('2d').drawImage(c, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }

  // ---- confirm -------------------------------------------------------------------
  modal.querySelector('#sig-use').addEventListener('click', () => {
    const drawVisible = modal.querySelector('.sig-pane-draw').style.display !== 'none';
    let source = null;
    if (drawVisible) {
      if (!pad || pad.isEmpty()) { toast('Gambar tanda tanganmu dulu ya'); return; }
      source = trimToInk(canvas);
    } else {
      source = processUpload();
      if (!source) { toast('Upload gambar tanda tanganmu dulu ya'); return; }
    }
    if (!source) { toast('Tanda tangan kosong'); return; }
    modal.close();
    onReady({
      dataUrl: source.toDataURL('image/png'),
      width: source.width,
      height: source.height,
      subtype: parafCheck.checked ? 'paraf' : null,
    });
  });
  modal.querySelector('#sig-cancel').addEventListener('click', () => modal.close());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.close(); });

  return {
    open() {
      modal.showModal();
      showTab('draw');
      initPad();
      uploadedImg = null;
      preview.innerHTML = '';
    },
  };
}
