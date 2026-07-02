/*
 * PDFLokal — js/lab.js  (render-engine preview — NOT part of the app)
 * ============================================================================
 * Phone-openable harness for the render engine (pdflokal.id/lab.html). The
 * engine itself now lives in real modules — this file is ONLY wiring:
 *   - streaming window        → js/render/viewport.js  (extracted Jul 2026)
 *   - page views / slots      → js/render/page-view.js
 *   - input (drag/resize/tap) → js/render/interaction.js
 * If lab behavior regresses after an engine change, the engine broke — that is
 * the point of keeping this page alive.
 */
import { createDoc, createAnnotation } from './core/model.js';
import { addAnnotation } from './core/operations.js';
import { createHistory } from './core/history.js';
import { importPdf, createPageRasterizer } from './core/import.js';
import { createPageSlot } from './render/page-view.js';
import { createViewportStream } from './render/viewport.js';
import { createInteraction } from './render/interaction.js';

window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/js/vendor/pdf.worker.min.js';

const scrollEl = document.getElementById('pv-scroll');
const stage = document.getElementById('pv-stage');
const statusEl = document.getElementById('lab-status');
const setStatus = (s) => { statusEl.textContent = s; };

let zoom = 1;
let doc = createDoc();
let slots = [];
let rasterizer = null;
const history = createHistory();

function applyZoom() { stage.style.transform = `scale(${zoom})`; stream.refresh(0); }
document.getElementById('z-in').onclick = () => { zoom = Math.min(zoom + 0.2, 3); applyZoom(); };
document.getElementById('z-out').onclick = () => { zoom = Math.max(zoom - 0.2, 0.3); applyZoom(); };

// Telegraph #2 — position pill ("42 / 340"), shown on scroll, fades on idle.
const pill = document.getElementById('pv-pill');
let pillTimer = null;
function showPill(current, total) {
  pill.textContent = `${current} / ${total}`;
  pill.classList.add('show');
  clearTimeout(pillTimer);
  pillTimer = setTimeout(() => pill.classList.remove('show'), 750);
}

const stream = createViewportStream({
  scrollEl,
  slots: () => slots,
  rasterize: (page) => rasterizer.rasterize(page, { scale: 2 }),
  onPosition: showPill,
});
stream.attach();

createInteraction({
  stage,
  getDoc: () => doc,
  getZoom: () => zoom,
  getTool: () => 'select',
  history,
  onChange: () => {},
});

async function loadDoc(name, bytes) {
  if (rasterizer) await rasterizer.destroy();
  slots = []; stage.innerHTML = '';
  setStatus('membuka…');

  doc = createDoc();
  const pages = await importPdf(doc, { name, bytes }); // instant: metadata only

  // A draggable demo annotation on page 1 — proves "active object always on
  // top" AND exercises the real interaction layer (select → drag → undo path).
  const demo = addAnnotation(doc, pages[0].id, createAnnotation('text', {
    text: 'Seret aku ✍️ (selalu di atas)', x: 48, y: 120, fontSize: 22, color: '#111', bold: true,
  }));

  const fit = Math.min(1, (scrollEl.clientWidth - 32) / pages[0].width);
  zoom = fit; stage.style.transform = `scale(${zoom})`;

  // Lay out EVERY slot immediately (correct size + numbered placeholder).
  pages.forEach((page, i) => {
    const slot = createPageSlot(page, { activeId: demo.id, label: `Hal ${i + 1}` });
    stage.appendChild(slot.view);
    slots.push(slot);
  });

  rasterizer = createPageRasterizer(doc);
  setStatus(`${pages.length} halaman — dibuka langsung, isi mengalir saat scroll`);
  stream.refresh(0);
}

document.getElementById('lab-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  e.target.value = '';
  loadDoc(file.name, bytes).catch((err) => { console.error(err); setStatus('gagal memuat'); });
});

(async () => {
  try {
    const res = await fetch('/tests/fixtures/sample-2pages.pdf');
    const bytes = new Uint8Array(await res.arrayBuffer());
    await loadDoc('sample-2pages.pdf', bytes);
  } catch (err) {
    console.error(err);
    setStatus('Buka PDF untuk mulai');
  }
})();
