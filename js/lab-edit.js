import { ensurePdfJs, ensurePdfLib } from '/js/core/vendor.js';
import { removeShowOps } from '/js/core/content-stream.js';

const MAX_PAGES = 3; // fase 1: cukup untuk membuktikan mekanismenya
const pagesEl = document.getElementById('pages');
const panel = document.getElementById('panel');
const statsEl = document.getElementById('stats');
const routerEl = document.getElementById('router');

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

async function open(data, name) {
  state.bytes = data;
  const pdfjs = await ensurePdfJs();
  const doc = await pdfjs.getDocument({ data: data.slice() }).promise; // defensive slice: pdf.js detaches the buffer (see core/import.js) — state.bytes must survive for fase 2
  pagesEl.textContent = '';
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
        document.getElementById('btn-remove-run').addEventListener('click', () => removeRun(p, item.str));
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
// Lab scope: string-match removal (simple/Standard fonts decode ASCII-ish —
// our fixtures and most Word-born docs). Subset/CID fonts need the position-
// matched interpreter walk — that's the production Rung B build.
async function removeRun(pageNum, runText) {
  const out = document.getElementById('rm-result');
  out.textContent = ' …memproses';
  try {
    const { PDFLib } = await ensurePdfLib();
    const { PDFDocument, PDFName, PDFArray, PDFRawStream, decodePDFRawStream } = PDFLib;
    const doc = await PDFDocument.load(state.bytes.slice());
    const page = doc.getPage(pageNum - 1);
    const ctx = doc.context;

    // Contents may be one stream or an array — decode ALL, join (the spec
    // says multiple streams are logically one), operate, write back as one.
    const contents = page.node.Contents();
    const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
    const latin1 = (u8) => Array.from(u8, (b) => String.fromCharCode(b)).join('');
    const parts = refs.map((r) => {
      const s = ctx.lookup(r);
      return latin1(s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents());
    });
    const whole = parts.join('\n');

    const { content, removed } = removeShowOps(whole, ({ text }) => text.includes(runText));
    if (removed === 0) { out.textContent = ' ✗ tidak ketemu di stream (font subset? → butuh interpreter walk)'; return; }

    const bytesOf = (str) => Uint8Array.from(str, (c) => c.charCodeAt(0));
    const newStream = ctx.flateStream(bytesOf(content));
    page.node.set(PDFName.of('Contents'), ctx.register(newStream));
    const outBytes = await doc.save();

    // Proof, both layers: text layer no longer knows the string AND the pixels
    // no longer show it. Render the result page beside the original.
    const pdfjs = await ensurePdfJs();
    const check = await pdfjs.getDocument({ data: outBytes.slice() }).promise;
    const cp = await check.getPage(pageNum);
    const tc = await cp.getTextContent();
    const still = tc.items.some((i) => i.str.includes(runText));

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

    out.textContent = still
      ? ` ✗ ${removed} op dihapus tapi teks masih di text layer`
      : ` ✓ ${removed} op dihapus — teks HILANG dari file (${outBytes.length} bytes). Halaman hasil (hijau) ditambahkan di bawah.`;
  } catch (err) {
    console.error(err);
    out.textContent = ` ✗ gagal: ${err.message}`;
  }
}
