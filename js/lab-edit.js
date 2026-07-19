import { ensurePdfJs, ensurePdfLib } from '/js/core/vendor.js';
import { removeRunsFromPdfPage } from '/js/core/redact.js';

const MAX_PAGES = 3; // fase 1: cukup untuk membuktikan mekanismenya
const pagesEl = document.getElementById('pages');
const panel = document.getElementById('panel');
const statsEl = document.getElementById('stats');
const routerEl = document.getElementById('router');

// Mirrors text-walk.js's own (unexported) normalize() — a 3-line pure vector
// helper isn't worth an export just to share across the module boundary, but
// it MUST stay identical: it's what turns pdf.js's item.transform into the
// same (ux,uy) baseline-direction unit vector the walk computes internally,
// so a target built here lands on the geometry the walk actually matches.
function normalize(x, y) {
  const len = Math.hypot(x, y);
  return len === 0 ? [1, 0] : [x / len, y / len];
}

document.getElementById('toggle-boxes').addEventListener('change', (e) => {
  document.body.classList.toggle('show-boxes', e.target.checked);
});
document.getElementById('file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) open(new Uint8Array(await f.arrayBuffer()), f.name);
});
document.getElementById('load-sample').addEventListener('click', async () => {
  const res = await fetch('/tests/fixtures/sample-2pages.pdf');
  open(new Uint8Array(await res.arrayBuffer()), 'sample-2pages.pdf');
});

let selected = null;
const state = { bytes: null }; // fase 2 reloads the ORIGINAL bytes for surgery
// pageNum -> Map<runText, count>: the ORIGINAL text layer's occurrence count
// per string. A repeated line (subset/CID fixtures draw the same string at
// several positions — see undangan-cid.pdf) means "is runText still there"
// can't be a plain .includes() after removal; the proof needs count-before
// vs count-after (see removeRun's `gone` check).
const pageTextCounts = new Map();

async function open(data, name) {
  state.bytes = data;
  const pdfjs = await ensurePdfJs();
  const doc = await pdfjs.getDocument({ data: data.slice() }).promise; // defensive slice: pdf.js detaches the buffer (see core/import.js) — state.bytes must survive for fase 2
  pagesEl.textContent = '';
  pageTextCounts.clear();
  const fonts = new Set();
  let runCount = 0;

  const n = Math.min(doc.numPages, MAX_PAGES);
  for (let p = 1; p <= n; p++) {
    const page = await doc.getPage(p);
    // Skala render menyesuaikan lebar layar; semua koordinat run ikut viewport
    // yang SAMA, jadi kotak menempel tepat di atas glyph di kanvas.
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2, (Math.min(900, pagesEl.clientWidth - 8)) / base.width);
    const viewport = page.getViewport({ scale });

    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    wrap.appendChild(canvas);
    pagesEl.appendChild(wrap);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

    const tc = await page.getTextContent();
    const counts = new Map();
    for (const item of tc.items) {
      if (!item.str || !item.str.trim()) continue;
      counts.set(item.str, (counts.get(item.str) || 0) + 1);
    }
    pageTextCounts.set(p, counts);

    for (const item of tc.items) {
      if (!item.str || !item.str.trim()) continue;
      runCount++;
      const style = tc.styles[item.fontName] || {};
      fonts.add(style.fontFamily || item.fontName);

      // PDF meletakkan teks lewat matriks transform; proyeksikan ke ruang
      // viewport, lalu tinggi glyph = panjang vektor sumbu-Y matriks itu.
      const tx = pdfjs.Util.transform(viewport.transform, item.transform);
      const fh = Math.hypot(tx[2], tx[3]);
      const w = item.width * viewport.scale;

      const box = document.createElement('div');
      box.className = 'run';
      box.dataset.runText = item.str; // lets tests pick a SPECIFIC occurrence of a repeated line by content, not just DOM order (see undangan-cid.pdf's 3 identical lines)
      box.style.left = `${tx[4]}px`;
      box.style.top = `${tx[5] - fh}px`;
      box.style.width = `${w}px`;
      box.style.height = `${fh * 1.15}px`;
      box.addEventListener('click', () => {
        if (selected) selected.classList.remove('selected');
        selected = box;
        box.classList.add('selected');
        panel.innerHTML =
          `<b>run</b> "${item.str.replace(/&/g, '&amp;').replace(/</g, '&lt;')}"<br>` +
          `<b>font</b> ${item.fontName} → ${style.fontFamily || '?'}` +
          ` · ${style.ascent ? `ascent ${style.ascent.toFixed(2)}` : ''}` +
          ` · ukuran ±${(fh / viewport.scale).toFixed(1)} pt<br>` +
          `<b>posisi</b> hal ${p} · PDF(${item.transform[4].toFixed(1)}, ${item.transform[5].toFixed(1)})` +
          ` · lebar ${(item.width).toFixed(1)} pt · ${item.hasEOL ? 'akhir baris' : 'tengah baris'} ` +
          `<button id="btn-remove-run">fase 2: hapus dari stream</button><span id="rm-result"></span>`;
        document.getElementById('btn-remove-run').addEventListener('click', () => removeRun(p, item));
      });
      wrap.appendChild(box);
    }
  }

  const isDigital = runCount > 0;
  routerEl.textContent = isDigital
    ? 'ROUTER: born-digital → tangga teks-asli'
    : 'ROUTER: scan/foto → tangga dokumen-foto';
  routerEl.className = isDigital ? 'digital' : 'scan';
  statsEl.textContent = `${name} · ${doc.numPages} hal (render ${n}) · ${runCount} run · ${fonts.size} font: ${[...fonts].join(', ')}`;
}

// ---- fase 2: REMOVE the selected run from the page's content stream ---------
// POSITION-matched removal (Rung B production): the clicked run's pdf.js
// geometry (item.transform + item.width) becomes a user-space target that
// text-walk.js's interpreter walk matches against — this is what works
// regardless of font encoding, unlike the string-match seed this replaces
// (see core/redact.js's header for the adapter that feeds the walk).
async function removeRun(pageNum, item) {
  const out = document.getElementById('rm-result');
  out.textContent = ' …memproses';
  try {
    const { PDFLib } = await ensurePdfLib();
    const { PDFDocument } = PDFLib;
    const doc = await PDFDocument.load(state.bytes.slice());
    const page = doc.getPage(pageNum - 1);

    // item.transform = [a,b,c,d,e,f]: (a,b) is the baseline-direction axis
    // (scaled by fontSize*Th), (c,d) is the perpendicular axis (scaled by
    // fontSize) — exactly what text-walk.js computes internally as `full`,
    // so this is the SAME geometry the walk will match against.
    const [ux, uy] = normalize(item.transform[0], item.transform[1]);
    const target = {
      x0: item.transform[4],
      y0: item.transform[5],
      ux, uy,
      len: item.width, // pdf.js already reports this in user-space units
      size: Math.hypot(item.transform[2], item.transform[3]),
    };

    const { removed, results } = removeRunsFromPdfPage(page, PDFLib, [target]);
    if (!results[0].matched) {
      out.textContent = ' ✗ tidak ketemu / ditolak (posisi tak bisa dipastikan)';
      return;
    }

    const outBytes = await doc.save();
    // Test hook (lab-only, noindexed page — never shipped in the real editor):
    // exposes the produced bytes so the Playwright proof can independently
    // re-parse the OUTPUT with pdf.js, instead of trusting this panel's own
    // self-report (see tests/rung-b-lab.spec.js).
    window.__labLastOutput = outBytes;

    // Proof: re-parse with pdf.js and compare the COUNT of text-layer items
    // matching this run's exact string, before vs after — NOT a global
    // .includes(). A repeated line (undangan-cid.pdf draws the same string 3×
    // at different positions) means .includes() stays true even when exactly
    // the clicked one is gone; only the count can tell "3 → 2" from "3 → 3".
    const beforeCount = pageTextCounts.get(pageNum)?.get(item.str) || 0;
    const pdfjs = await ensurePdfJs();
    const check = await pdfjs.getDocument({ data: outBytes.slice() }).promise;
    const cp = await check.getPage(pageNum);
    const tc = await cp.getTextContent();
    const afterCount = tc.items.filter((i) => i.str === item.str).length;
    const gone = afterCount === beforeCount - 1;

    const vp = cp.getViewport({ scale: Math.min(2, 700 / cp.getViewport({ scale: 1 }).width) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
    await cp.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.style.outline = '3px solid #16a34a';
    wrap.appendChild(canvas);
    pagesEl.appendChild(wrap);
    wrap.scrollIntoView({ behavior: 'smooth' });

    out.textContent = gone
      ? ` ✓ ${removed} op dihapus — teks HILANG dari file (${outBytes.length} bytes). Halaman hasil (hijau) ditambahkan di bawah.`
      : ` ✗ ${removed} op dihapus tapi teks masih di text layer (sebelum ${beforeCount}, sesudah ${afterCount})`;
  } catch (err) {
    console.error(err);
    out.textContent = ` ✗ gagal: ${err.message}`;
  }
}
