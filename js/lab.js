/*
 * PDFLokal — js/lab.js  (Phase-1 render-engine PREVIEW, not part of the app)
 * ============================================================================
 * A throwaway harness to let the founder FEEL the new image-backed rendering on
 * a real phone BEFORE we swap the live editor. It wires: PDF bytes → core Doc
 * (import + rasterize) → render/page-view. Then it drops one draggable demo
 * annotation on page 1 so you can drag it around and confirm it stays ON TOP of
 * the pages (the "slides behind" fix), and scroll/zoom without flicker.
 *
 * Nothing here touches the live app. Not linked from anywhere; robots-noindex.
 */
import { createDoc, createAnnotation } from './core/model.js';
import { addAnnotation } from './core/operations.js';
import { importPdf, rasterizePage } from './core/import.js';
import { renderPageView } from './render/page-view.js';

window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/js/vendor/pdf.worker.min.js';

const stage = document.getElementById('pv-stage');
const statusEl = document.getElementById('lab-status');
const setStatus = (s) => { statusEl.textContent = s; };

let zoom = 1;
function applyZoom() { stage.style.transform = `scale(${zoom})`; }
document.getElementById('z-in').onclick = () => { zoom = Math.min(zoom + 0.2, 3); applyZoom(); };
document.getElementById('z-out').onclick = () => { zoom = Math.max(zoom - 0.2, 0.3); applyZoom(); };

// Load a document from bytes, rasterize every page, render the column.
async function loadDoc(name, bytes) {
  setStatus('memuat…');
  stage.innerHTML = '';
  const doc = createDoc();
  const pages = await importPdf(doc, { name, bytes });

  // A draggable demo annotation on page 1 — proves "active object always on top".
  const demo = addAnnotation(doc, pages[0].id,
    createAnnotation('text', { text: 'Seret aku ✍️  (aku selalu di atas)', x: 60, y: 140, fontSize: 22, color: '#111', bold: true }));

  // Fit the first page to the viewport width for a sensible default zoom.
  const fit = Math.min(1, (stage.parentElement.clientWidth - 32) / pages[0].width);
  zoom = fit; applyZoom();

  for (const page of pages) {
    await rasterizePage(doc, page, { scale: 2 });
    const view = renderPageView(page, { activeId: demo.id });
    stage.appendChild(view);
    setStatus(`${stage.children.length}/${pages.length} halaman`);
  }
  setStatus(`${pages.length} halaman · seret teks hijau, scroll, zoom ± — cek flicker`);

  wireDemoDrag(doc, demo);
}

// Pointer-based drag (works mouse + touch). Updates the annotation in the core
// model, then moves its element. Screen delta is divided by zoom so it tracks
// the finger 1:1 at any zoom.
function wireDemoDrag(doc, anno) {
  const el = stage.querySelector(`[data-anno-id="${anno.id}"]`);
  if (!el) return;
  el.style.cursor = 'grab';
  el.style.touchAction = 'none';
  let startX = 0, startY = 0, baseX = 0, baseY = 0, dragging = false;

  el.addEventListener('pointerdown', (e) => {
    dragging = true; el.setPointerCapture(e.pointerId);
    startX = e.clientX; startY = e.clientY; baseX = anno.x; baseY = anno.y;
    el.style.zIndex = '1000'; el.style.cursor = 'grabbing';
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    anno.x = baseX + (e.clientX - startX) / zoom;
    anno.y = baseY + (e.clientY - startY) / zoom;
    el.style.left = anno.x + 'px';
    el.style.top = anno.y + 'px';
  });
  const end = () => { dragging = false; el.style.cursor = 'grab'; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

// Wire the file picker + auto-load the bundled sample so it's alive on open.
document.getElementById('lab-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  loadDoc(file.name, bytes).catch((err) => { console.error(err); setStatus('gagal memuat'); });
  e.target.value = '';
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
