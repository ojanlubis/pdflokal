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

/*
 * ---- opt-in device save (spec-signature-save.md, ruled 2026-08-13) ---------
 * ONE key, holding ONE trimmed PNG dataURL, overwritten. A collection of
 * signatures would walk into the ~5MB origin quota; one artifact cannot.
 * Underscore form matches `pdflokal_theme` (the codebase is already
 * inconsistent — `pdflokal-ps-voted` uses hyphens — do not sweep it here).
 *
 * WHY opt-in and off by default: the case that decides it is the shared
 * machine — warnet, kantor, a borrowed laptop. Saving automatically there puts
 * one person's signature on someone else's computer with no moment at which
 * they agreed to it. Documented to users in privasi.html's storage table.
 *
 * The three helpers are module-local ON PURPOSE, matching playstore-vote.js
 * and install-prompt.js: private mode and QuotaExceededError land in the same
 * catch and neither is an error the user should ever see.
 */
const SIG_KEY = 'pdflokal_signature';

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode / quota */ } }
function safeRemove(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } }

function decodeImage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // corrupt stored value → behave as if none
    img.src = dataUrl;
  });
}

export function createSignatureModal({ modal, onReady, toast }) {
  const canvas = modal.querySelector('#sig-canvas');
  const fileInput = modal.querySelector('#sig-file');
  const preview = modal.querySelector('#sig-preview');
  const parafCheck = modal.querySelector('#sig-paraf');
  const removeBgCheck = modal.querySelector('#sig-removebg');
  const saveCheck = modal.querySelector('#sig-save');
  const tabs = modal.querySelectorAll('.sig-tab');
  let pad = null;
  let uploadedImg = null; // HTMLImageElement of the chosen file
  // The signature read back off the device this open, still untouched:
  // { dataUrl, width, height }. Cleared the moment the user redraws.
  let restored = null;

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
  // "Ulangi" is also how a restored signature is discarded — without dropping
  // `restored` the confirm handler would hand back the stored bytes the user
  // just wiped off the pad.
  modal.querySelector('#sig-clear').addEventListener('click', () => { pad?.clear(); restored = null; });

  /*
   * Paint the saved signature straight onto the pad canvas, so on open it is
   * simply THERE — no second surface and no new visual language, and "Ulangi"
   * already reads as start-over.
   *
   * WHY not pad.fromDataURL(): that helper stretches the image to the whole
   * canvas, ignoring aspect ratio, and decodes a second time. The pad's context
   * already carries initPad()'s DPR scale (assigning canvas.width resets the
   * transform, so it is applied exactly once), so this draws in CSS pixels.
   */
  function paintRestored(img) {
    const boxW = canvas.offsetWidth;
    const boxH = canvas.offsetHeight;
    const fit = Math.min(boxW / img.naturalWidth, boxH / img.naturalHeight, 1);
    const w = img.naturalWidth * fit;
    const h = img.naturalHeight * fit;
    canvas.getContext('2d').drawImage(img, (boxW - w) / 2, (boxH - h) / 2, w, h);
  }

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
  const fromCanvas = (c) => (c
    ? { dataUrl: c.toDataURL('image/png'), width: c.width, height: c.height }
    : null);

  modal.querySelector('#sig-use').addEventListener('click', () => {
    const drawVisible = modal.querySelector('.sig-pane-draw').style.display !== 'none';
    let art = null;
    if (drawVisible && restored && pad?.toData().length === 0) {
      // A restored signature nobody has drawn over: hand back the STORED bytes.
      // WHY: re-reading it off the pad would re-scale it to pad resolution on
      // every open→Pakai cycle, quietly shrinking an uploaded photo signature
      // (capped at 1200px by processUpload) down to a ~460px box, for good.
      // pad.toData() is the discriminator — fromDataURL/paintRestored never
      // touch the stroke data, a real stroke always does.
      art = restored;
    } else if (drawVisible) {
      if (!pad || pad.isEmpty()) { toast('Gambar tanda tanganmu dulu ya'); return; }
      art = fromCanvas(trimToInk(canvas));
    } else {
      art = fromCanvas(processUpload());
      if (!art) { toast('Upload gambar tanda tanganmu dulu ya'); return; }
    }
    if (!art) { toast('Tanda tangan kosong'); return; }
    // The checkbox IS the consent moment, and unchecking it is also the delete
    // control — that is what avoids inventing a second button and a second
    // string. Written only here, past every empty-source check, so Batal and a
    // backdrop click never touch the device.
    if (saveCheck.checked) safeSet(SIG_KEY, art.dataUrl);
    else safeRemove(SIG_KEY);
    modal.close();
    onReady({
      dataUrl: art.dataUrl,
      width: art.width,
      height: art.height,
      subtype: parafCheck.checked ? 'paraf' : null,
    });
  });
  modal.querySelector('#sig-cancel').addEventListener('click', () => modal.close());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.close(); });

  return {
    // async so the restore can wait for the pad: SignaturePad's constructor
    // clear()s the canvas, so painting before it exists paints into nothing.
    // Callers do not await — the sheet is already up and interactive.
    async open() {
      modal.showModal();
      showTab('draw');
      uploadedImg = null;
      preview.innerHTML = '';
      restored = null;
      const saved = safeGet(SIG_KEY);
      // Set synchronously: a stored signature means the box reads as already
      // kept, so leaving it alone keeps it and unchecking it deletes it.
      saveCheck.checked = !!saved;
      await initPad();
      if (!saved || !modal.open) return; // closed while the pad was fetched
      const img = await decodeImage(saved);
      // Re-check: the user may have closed the sheet or started drawing while
      // the pad and the image were loading. Never paint over a live stroke.
      if (!img || !modal.open || pad?.toData().length) return;
      paintRestored(img);
      restored = { dataUrl: saved, width: img.naturalWidth, height: img.naturalHeight };
    },
  };
}
