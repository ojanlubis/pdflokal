/*
 * PDFLokal — qr.js  (the /qr page: paste a link, get the QR)
 * ============================================================================
 * Ported from the founder's other site (template-lokal site/components/QrTool.tsx,
 * React) to this stack. Same behaviour, same strings, no framework.
 *
 * THE LINK NEVER LEAVES THE BROWSER. The code is drawn by js/vendor/qrcode.min.js
 * (qrcode 1.5.4, a classic script that sets the global QRCode) from the text in
 * the input, entirely here. The only thing sent anywhere is tel('qr_use', {action}):
 * an enum saying "download" or "copy", never the text, never the QR. That is the
 * claim the page makes in its last paragraph ("Nggak lewat server kami"), so a
 * second tel() prop here would have to be an enum too: js/core/telemetry-schema.js
 * has no string-typed prop by design.
 *
 * SINGLE SOURCE OF TRUTH for the sizes: the displayed SVG carries no quiet zone of
 * its own (the white padding of .qr-tile in qr.html is its quiet zone); the PNG has
 * nothing around it once it leaves the page, so its margin is baked in.
 */
import { tel } from './v2/telemetry.js';

// (The sample the page opens with, https://pdflokal.id, is the input's value in
// qr.html, so the page is not blank before this runs. An empty frame teaches nothing.)
const SVG_OPTS = { margin: 0, errorCorrectionLevel: 'M' };
const PNG_OPTS = { margin: 2, width: 1024, errorCorrectionLevel: 'M' };

const GALAT_KEPANJANGAN = 'Isinya kepanjangan buat satu QR. Coba perpendek dulu linknya.';

const input = document.getElementById('tautan');
const tampil = document.getElementById('qr-img');
const kosong = document.getElementById('qr-kosong');
const galatEl = document.getElementById('qr-galat');
const unduhBtn = document.getElementById('qr-unduh');
const salinBtn = document.getElementById('qr-salin');
const statusEl = document.getElementById('qr-status');

// { svg, png } for the text currently shown, or null.
let hasil = null;
// Bumped on every keystroke. The library's promises resolve a tick later, and a
// result that a newer keystroke outran must be dropped, not painted over it.
let giliran = 0;

function setStatus(teks, gagal) {
  statusEl.textContent = teks;
  statusEl.style.color = gagal ? 'var(--ink)' : '';
  statusEl.style.fontWeight = gagal ? '600' : '';
}

function paint(isi, galat) {
  const siap = Boolean(isi) && hasil !== null;
  unduhBtn.disabled = !siap;
  salinBtn.disabled = !siap;
  galatEl.textContent = isi ? galat : '';

  if (siap) {
    // WHY DOMParser and not innerHTML: the markup is the library's own output for
    // a string of modules (no user text reaches it), but this repo's rule is that
    // innerHTML never takes anything built from input, so this does not start the
    // exception.
    const svg = new DOMParser().parseFromString(hasil.svg, 'image/svg+xml').documentElement;
    tampil.replaceChildren(document.importNode(svg, true));
    tampil.setAttribute('aria-label', `Kode QR untuk ${isi}`);
    tampil.hidden = false;
    kosong.hidden = true;
  } else {
    tampil.replaceChildren();
    tampil.hidden = true;
    kosong.hidden = false;
    kosong.textContent = galat && isi ? 'Belum ada QR yang bisa dibentuk.' : 'QR-nya muncul di sini.';
  }
}

function bentuk() {
  const isi = input.value.trim();
  const saya = ++giliran;

  // Empty is derived, never encoded: clearing the field must not flash a stale code.
  if (!isi || typeof window.QRCode === 'undefined') {
    hasil = null;
    paint(isi, '');
    return;
  }

  // Encoding is fast and local; the await is the library's own boundary, not a
  // network call.
  Promise.all([
    window.QRCode.toString(isi, { type: 'svg', ...SVG_OPTS }),
    window.QRCode.toDataURL(isi, PNG_OPTS),
  ])
    .then(([svg, png]) => {
      if (saya !== giliran) return;
      hasil = { svg, png };
      paint(isi, '');
    })
    .catch(() => {
      if (saya !== giliran) return;
      hasil = null;
      paint(isi, GALAT_KEPANJANGAN);
    });
}

// data:image/png;base64,... -> Blob, synchronously. Synchronous matters for the
// clipboard: Safari only honours clipboard.write inside the user gesture, and an
// await on a fetch of the data URL before it spends the gesture.
function keBlob(dataUrl) {
  const biner = window.atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const bytes = new Uint8Array(biner.length);
  for (let i = 0; i < biner.length; i += 1) bytes[i] = biner.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

function unduh() {
  if (!hasil) return;
  tel('qr_use', { action: 'download' });
  const url = URL.createObjectURL(keBlob(hasil.png));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'qr.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function salin() {
  if (!hasil) return;
  tel('qr_use', { action: 'copy' });
  try {
    await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': keBlob(hasil.png) })]);
    setStatus('Tersalin. Tinggal tempel.', false);
  } catch {
    // Some browsers refuse image writes to the clipboard outright. Say so rather
    // than showing a success that did not happen.
    setStatus('Browser ini menolak menyalin gambar. Pakai Unduh PNG.', true);
  }
}

input.addEventListener('input', () => {
  setStatus('', false);
  bentuk();
});
unduhBtn.addEventListener('click', unduh);
salinBtn.addEventListener('click', salin);

bentuk();
