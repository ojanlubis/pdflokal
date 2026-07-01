/*
 * PDFLokal — js/lab.js  (Phase-1/2 render preview — NOT part of the app)
 * ============================================================================
 * Streaming render harness so the founder can feel the real strategy on a phone
 * BEFORE the live editor is touched. The model:
 *   - Open INSTANTLY: read all page sizes (cheap), lay out every page slot at
 *     the correct dimensions immediately. Scrollbar is right from t=0; nothing
 *     reflows. Only pixels stream in.
 *   - STREAM like GTA maps: rasterize only pages near the viewport; release the
 *     far ones to free memory. Memory stays bounded on ANY document size — the
 *     only thing that survives "1 juta phones" (mostly low-end Android).
 *   - Placeholders, never blank → fast-scroll reads as loading, not flicker.
 *
 * Nothing here touches the live app (separate page, noindex, unlinked).
 */
import { createDoc, createAnnotation } from './core/model.js';
import { addAnnotation } from './core/operations.js';
import { importPdf, createPageRasterizer } from './core/import.js';
import { renderPageView, setPageRaster, clearPageRaster } from './render/page-view.js';

window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/js/vendor/pdf.worker.min.js';

const scrollEl = document.getElementById('pv-scroll');
const stage = document.getElementById('pv-stage');
const statusEl = document.getElementById('lab-status');
const setStatus = (s) => { statusEl.textContent = s; };

let zoom = 1;
function applyZoom() { stage.style.transform = `scale(${zoom})`; updateWindow(0); }
document.getElementById('z-in').onclick = () => { zoom = Math.min(zoom + 0.2, 3); applyZoom(); };
document.getElementById('z-out').onclick = () => { zoom = Math.max(zoom - 0.2, 0.3); applyZoom(); };

let slots = [];          // [{ page, view }]
let rasterizer = null;   // per-source PDF.js doc cache
let ticking = false;

async function loadDoc(name, bytes) {
  if (rasterizer) await rasterizer.destroy();
  slots = []; stage.innerHTML = '';
  setStatus('membuka…');

  const doc = createDoc();
  const pages = await importPdf(doc, { name, bytes }); // instant: metadata only

  // A draggable demo annotation on page 1 — proves "active object always on top",
  // and that it stays put even while the page image streams in/out underneath.
  const demo = addAnnotation(doc, pages[0].id, createAnnotation('text', {
    text: 'Seret aku ✍️ (selalu di atas)', x: 48, y: 120, fontSize: 22, color: '#111', bold: true,
  }));

  const fit = Math.min(1, (scrollEl.clientWidth - 32) / pages[0].width);
  zoom = fit; stage.style.transform = `scale(${zoom})`;

  // Lay out EVERY slot immediately (correct size + numbered placeholder). Instant open.
  pages.forEach((page, i) => {
    const view = renderPageView(page, { activeId: demo.id, label: `Hal ${i + 1}` });
    stage.appendChild(view);
    slots.push({ page, view });
  });
  wireDemoDrag(doc, demo);

  rasterizer = createPageRasterizer(doc);
  setStatus(`${pages.length} halaman — dibuka langsung, isi mengalir saat scroll`);
  updateWindow(); // rasterize whatever's on screen now
}

// The GTA-streaming core: rasterize pages within ~2 screens of the viewport,
// release pages beyond ~4 screens (bounded memory, any doc size).
//
// RENDER-ON-SETTLE: while the finger is flinging fast, we DON'T rasterize — you
// aren't reading, you're travelling, and we'd never keep up anyway. We still
// RELEASE far pages (keep memory bounded) and show numbered placeholders. The
// moment the scroll settles, we catch up and sharpen. Never fights the user;
// saves the weak phone's battery on pages you fling past.
const FLING = 45; // px/frame above which we treat it as "travelling", not reading

function updateWindow(velocity = 0) {
  if (!rasterizer || slots.length === 0) return;
  const sc = scrollEl.getBoundingClientRect();
  const loadPad = sc.height * 2;
  const keepPad = sc.height * 4;
  const flinging = velocity > FLING;

  for (const slot of slots) {
    const r = slot.view.getBoundingClientRect();
    const near = r.bottom > sc.top - loadPad && r.top < sc.bottom + loadPad;
    const far = r.bottom < sc.top - keepPad || r.top > sc.bottom + keepPad;

    if (far && slot.page.raster) {
      clearPageRaster(slot.view);   // release always — bounds memory even mid-fling
      slot.page.raster = null;
    } else if (near && !flinging && !slot.page.raster && !slot.loading) {
      slot.loading = true;          // rasterize only when NOT flinging
      rasterizer.rasterize(slot.page, { scale: 2 })
        .then((raster) => { setPageRaster(slot.view, raster); slot.loading = false; })
        .catch(() => { slot.loading = false; });
    }
  }
}

// Telegraph #2 — position pill. Show the center-most page ("42 / 340") while
// scrolling; fade it out when the finger rests. Tells the user where they are
// in a big doc and that the app is tracking them.
const pill = document.getElementById('pv-pill');
let pillTimer = null;
function updatePill() {
  if (slots.length === 0) return;
  const mid = scrollEl.getBoundingClientRect().top + scrollEl.clientHeight / 2;
  let current = 1;
  for (let i = 0; i < slots.length; i += 1) {
    if (slots[i].view.getBoundingClientRect().top <= mid) current = i + 1; else break;
  }
  pill.textContent = `${current} / ${slots.length}`;
  pill.classList.add('show');
  clearTimeout(pillTimer);
  pillTimer = setTimeout(() => pill.classList.remove('show'), 750);
}

let lastTop = 0, settleTimer = null;
function onScroll() {
  if (!ticking) {
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const top = scrollEl.scrollTop;
      const v = Math.abs(top - lastTop);
      lastTop = top;
      updateWindow(v);            // gated: skips rasterizing during a fast fling
      updatePill();
    });
  }
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => updateWindow(0), 130); // catch up once it settles
}
scrollEl.addEventListener('scroll', onScroll, { passive: true });
window.addEventListener('resize', () => updateWindow(0));

// Pointer-based drag (mouse + touch). Updates the core model, moves the element.
// Screen delta ÷ zoom so it tracks the finger 1:1 at any zoom.
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
