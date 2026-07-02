/*
 * PDFLokal — v2/app.js  (EDITOR V2 SHELL — the clean rebuild)
 * ============================================================================
 * The application layer: owns the Doc, the history, the tool state, and the
 * DOM chrome. All heavy lifting is delegated:
 *   - model + mutations  → js/core/  (headless, tested in Node)
 *   - page views / slots → js/render/page-view.js
 *   - streaming window   → js/render/viewport.js  (phone-validated)
 *   - input              → js/render/interaction.js (one pointer path)
 *   - PDF I/O            → js/core/import.js + js/core/export.js
 *
 * Interaction rules implemented here (product-definition §6):
 *   - tools are verbs; Pilih is home (text/signature return to it after use;
 *     whiteout stays sticky — the honest multi-stamp exception)
 *   - every action reversible; no confirm dialogs
 *   - nothing hover-only; touch targets ≥44px
 */

import { createDoc, createAnnotation } from '../core/model.js';
import {
  addAnnotation, removeAnnotation, updateAnnotation, clearSelection, selectAnnotation,
  moveAnnotation,
} from '../core/operations.js';
import { createHistory, record, undo, redo, canUndo, canRedo } from '../core/history.js';
import { importPdf, importImage, createPageRasterizer } from '../core/import.js';
import { createPageSlot, syncOverlay, textFontCss } from '../render/page-view.js';
import { createViewportStream } from '../render/viewport.js';
import { createInteraction } from '../render/interaction.js';
import { createFormatBar } from './format-bar.js';
import { createPageManager } from './page-manager.js';
import { createSignatureModal } from './signature-modal.js';

window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/js/vendor/pdf.worker.min.js';

// ---- state (ONE doc, ONE history — everything else is DOM or derived) -------
const doc = createDoc();
const history = createHistory();
let slots = [];
let rasterizer = null;
let zoom = 1;
let tool = 'select';
let storedSignature = null;   // { dataUrl, width, height } from the sig modal
let baseName = 'dokumen';
let editingAnno = null;       // text annotation currently in the inline editor
let editingEl = null;         // its contenteditable (format bar restyles it live)

const scrollEl = document.getElementById('v2-scroll');
const stage = document.getElementById('v2-stage');
const emptyEl = document.getElementById('empty');
const pill = document.getElementById('v2-pill');
const toastEl = document.getElementById('toast');

// ---- small helpers -----------------------------------------------------------
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}

function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ---- zoom ---------------------------------------------------------------------
// transform:scale + a sizer that carries the scaled layout size. NOT CSS zoom:
// zoom's coordinate reporting was quirky pre-Chrome-128, and old Androids are
// exactly who we build for. gBCR under transform returns visual coords on every
// engine ever — which is what interaction.js divides by zoom.
const sizer = document.getElementById('v2-sizer');
function applyZoom() {
  stage.style.transform = `scale(${zoom})`;
  // offsetWidth/Height are layout (pre-transform) sizes — scale them ourselves.
  sizer.style.width = Math.ceil(stage.offsetWidth * zoom) + 'px';
  sizer.style.height = Math.ceil(stage.offsetHeight * zoom) + 'px';
  stream.refresh(0);
}
document.getElementById('z-in').onclick = () => { zoom = Math.min(zoom + 0.25, 3); applyZoom(); };
document.getElementById('z-out').onclick = () => { zoom = Math.max(zoom - 0.25, 0.3); applyZoom(); };

// ---- camera: pinch-zoom + pan (the Google-Maps feel, founder ask) ----------------
// One-finger pan = NATIVE container scroll (overflow auto on both axes — free,
// smooth, momentum included). Two fingers = our pinch: preventDefault on the
// 2-touch touchstart keeps the browser from claiming the gesture, zoom anchors
// on the pinch midpoint so the paper under your fingers stays put.
function setZoomAnchored(next, midX, midY) {
  const clamped = Math.min(3, Math.max(0.3, next));
  if (clamped === zoom) return;
  const rect = scrollEl.getBoundingClientRect();
  const mx = midX - rect.left;
  const my = midY - rect.top;
  // Content point under the midpoint, rescaled to the new zoom.
  const cx = (scrollEl.scrollLeft + mx) * (clamped / zoom);
  const cy = (scrollEl.scrollTop + my) * (clamped / zoom);
  zoom = clamped;
  applyZoom();
  scrollEl.scrollLeft = cx - mx;
  scrollEl.scrollTop = cy - my;
}

let pinch = null;
let pinchRaf = false;
scrollEl.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2) {
    e.preventDefault(); // ours, not the browser's
    // A finger that landed on a selected object may have started a drag —
    // abort it and put the object back. Pinching must never fling things.
    interaction.cancelGesture();
    const [a, b] = e.touches;
    pinch = { d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, z0: zoom };
  }
}, { passive: false });
scrollEl.addEventListener('touchmove', (e) => {
  if (!pinch || e.touches.length !== 2) return;
  e.preventDefault();
  if (pinchRaf) return; // rAF-throttle: refresh loops slots, keep it 1×/frame
  pinchRaf = true;
  const [a, b] = e.touches;
  const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const midX = (a.clientX + b.clientX) / 2;
  const midY = (a.clientY + b.clientY) / 2;
  requestAnimationFrame(() => {
    pinchRaf = false;
    if (pinch) setZoomAnchored(pinch.z0 * (d / pinch.d0), midX, midY);
  });
}, { passive: false });
const endPinch = (e) => { if (e.touches.length < 2) pinch = null; };
scrollEl.addEventListener('touchend', endPinch);
scrollEl.addEventListener('touchcancel', endPinch);

// Desktop: trackpad pinch arrives as ctrl+wheel; cmd+wheel for mouse users.
scrollEl.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  setZoomAnchored(zoom * (e.deltaY < 0 ? 1.1 : 0.9), e.clientX, e.clientY);
}, { passive: false });

// ---- streaming viewport --------------------------------------------------------
let pillTimer = null;
const stream = createViewportStream({
  scrollEl,
  slots: () => slots,
  rasterize: (page) => rasterizer.rasterize(page, { scale: 2 }),
  onPosition: (current, total) => {
    pill.textContent = `${current} / ${total}`;
    pill.classList.add('show');
    clearTimeout(pillTimer);
    pillTimer = setTimeout(() => pill.classList.remove('show'), 750);
  },
});
stream.attach();

// ---- stage sync ----------------------------------------------------------------
// Full rebuild from the model. Cheap in practice: rasters ride on page objects
// (shared through history snapshots), so undo/redo re-shows pages instantly —
// no PDF.js work. Per-gesture hot paths never come through here.
function rebuildStage() {
  stage.innerHTML = '';
  slots = doc.pages.map((page, i) => {
    const slot = createPageSlot(page, {
      activeId: doc.selection.annotationId,
      label: `Hal ${i + 1}`,
    });
    stage.appendChild(slot.view);
    return slot;
  });
  interaction.refreshSelection();
  refreshChrome();
  applyZoom(); // stage layout size changed → re-size the sizer (also refreshes)
}

// Re-render one page's overlay after a structural annotation change.
function syncPage(pageId) {
  const slot = slots.find((s) => s.page.id === pageId);
  if (slot) syncOverlay(slot.page, slot.view, { activeId: doc.selection.annotationId });
  interaction.refreshSelection();
  refreshChrome();
}

function refreshChrome() {
  document.getElementById('btn-undo').disabled = !canUndo(history);
  document.getElementById('btn-redo').disabled = !canRedo(history);
  document.getElementById('btn-download').disabled = doc.pages.length === 0;
  document.getElementById('btn-pages').disabled = doc.pages.length === 0;
  // Hapus stays enabled with pages: no selection = arms delete-mode.
  document.getElementById('btn-delete-anno').disabled = doc.pages.length === 0;
  syncFormatBar();
  syncSigBar();
}

// ---- format bar ----------------------------------------------------------------
// Visible whenever text is in play: selected text anno, inline editing, or the
// Teks tool armed. Sticky defaults feed new annotations.
function selectedTextAnno() {
  const id = doc.selection.annotationId;
  if (!id) return null;
  for (const page of doc.pages) {
    const a = page.annotations.find((x) => x.id === id);
    if (a) return a.type === 'text' ? a : null;
  }
  return null;
}

const formatBar = createFormatBar({
  el: document.getElementById('format-bar'),
  getDoc: () => doc,
  history,
  getTarget: () => editingAnno || selectedTextAnno(),
  onStyled: (anno) => {
    // Restyle the open inline editor live; re-render the committed element.
    if (editingEl && editingAnno && anno.id === editingAnno.id) {
      editingEl.style.font = textFontCss(anno);
      editingEl.style.color = anno.color || '#000';
    }
    for (const page of doc.pages) {
      if (page.annotations.some((a) => a.id === anno.id)) { syncPage(page.id); break; }
    }
  },
  onDefaults: (d) => {
    // Un-committed draft (new text, no annotation yet): restyle the editor live.
    if (editingEl && !editingAnno) {
      editingEl.style.font = textFontCss(d);
      editingEl.style.color = d.color || '#000';
    }
  },
});

function syncFormatBar() {
  formatBar.sync(!!(editingAnno || editingEl || selectedTextAnno() || tool === 'text'));
}

// ---- tools ----------------------------------------------------------------------
function setTool(next) {
  tool = next;
  for (const btn of document.querySelectorAll('#toolbar .tool[data-tool]')) {
    const active = btn.dataset.tool === next;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
  // While a placement tool is active the page must not pan under the finger.
  stage.style.touchAction = next === 'select' ? '' : 'none';
  syncFormatBar();
  syncSigBar();
}
for (const btn of document.querySelectorAll('#toolbar .tool[data-tool]')) {
  btn.addEventListener('click', () => {
    const t = btn.dataset.tool;
    if (t === 'signature' && !storedSignature) { signatureModal.open(); return; }
    setTool(t);
    if (t === 'text') toast('Ketuk halaman untuk menulis');
    if (t === 'whiteout') toast('Seret di halaman untuk menutup teks');
    if (t === 'signature') toast('Ketuk halaman untuk menempatkan tanda tangan');
  });
}

// Hapus works BOTH ways (founder ask): with a selection it deletes now; with
// nothing selected it arms delete-mode — the next tapped object is removed.
document.getElementById('btn-delete-anno').addEventListener('click', () => {
  if (doc.selection.annotationId) { deleteSelected(); return; }
  setTool('delete');
  toast('Ketuk objek yang mau dihapus');
});

// ---- Tip-Ex color matching -------------------------------------------------------
// Zero-UI "colour matching tool", decided AT STROKE START (founder: the user
// should see the matched color WHILE drawing, not a white→color jump at the
// end). Sample two rings around the press point from the page raster and take
// the per-channel median — thin ink strokes lose the vote to the surrounding
// paper, so covering text on a cream scan yields cream. White stays white.
async function matchWhiteoutColor(anno, pageId, ox, oy) {
  const page = doc.pages.find((p) => p.id === pageId);
  if (!page?.raster) return; // page not rasterized — keep default white
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = page.raster.dataUrl; });
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(img, 0, 0);
    const rotated = (page.rotation || 0) % 180 !== 0;
    const frameW = rotated ? page.height : page.width;
    const s = img.width / frameW;              // raster px per page point
    const samples = { r: [], g: [], b: [] };
    const take = (x, y) => {
      if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;
      const px = cx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
      samples.r.push(px[0]); samples.g.push(px[1]); samples.b.push(px[2]);
    };
    for (const radius of [6 * s, 12 * s]) {
      for (let i = 0; i < 10; i += 1) {
        const ang = (Math.PI * 2 * i) / 10;
        take(ox * s + radius * Math.cos(ang), oy * s + radius * Math.sin(ang));
      }
    }
    if (samples.r.length < 8) return;
    const med = (arr) => arr.sort((a, b) => a - b)[Math.floor(arr.length / 2)];
    const hex = (n) => n.toString(16).padStart(2, '0');
    const color = `#${hex(med(samples.r))}${hex(med(samples.g))}${hex(med(samples.b))}`;
    updateAnnotation(doc, anno.id, { color });
    // Mid-gesture: update the LIVE element directly — rebuilding the overlay
    // here would destroy the element holding the pointer capture.
    const el = stage.querySelector(`[data-anno-id="${anno.id}"]`);
    if (el) el.style.background = color;
  } catch { /* sampling is best-effort; white stays */ }
}

// ---- interaction wiring ------------------------------------------------------------
const interaction = createInteraction({
  stage,
  getDoc: () => doc,
  getZoom: () => zoom,
  getTool: () => tool,
  history,
  onChange: (kind) => {
    // Tip-Ex stroke finished (color was already matched at stroke START):
    // return home to Pilih (founder: whiteout should NOT stay sticky).
    if (kind === 'draw') setTool('select');
    refreshChrome();
  },
  onDeleteTap: (annoId, pageId) => {
    record(history, doc);
    removeAnnotation(doc, annoId);
    syncPage(pageId);
    setTool('select'); // one delete per arming; undo covers mistakes
  },
  onPlace: (t, { pageId, x, y }) => {
    if (t === 'text') {
      openTextEditor({ pageId, x, y, anno: null });
    } else if (t === 'signature' && storedSignature) {
      record(history, doc);
      // Paraf places small (initials), signature at document scale.
      const w = storedSignature.subtype === 'paraf' ? 80 : 150;
      const h = w * (storedSignature.height / storedSignature.width);
      const created = addAnnotation(doc, pageId, createAnnotation('signature', {
        image: storedSignature.dataUrl, subtype: storedSignature.subtype,
        x: Math.max(0, x - w / 2), y: Math.max(0, y - h / 2), width: w, height: h,
      }));
      selectAnnotation(doc, created.id); // selected → "Semua Hal." is one tap away
      syncPage(pageId);
      setTool('select'); // tools are verbs; back home
    }
  },
  onDrawStart: ({ pageId, x, y }) => {
    // Whiteout drag-to-draw. interaction.js already recorded history.
    const anno = addAnnotation(doc, pageId, createAnnotation('whiteout', {
      x, y, width: 8, height: 8,
    }));
    syncPage(pageId);
    matchWhiteoutColor(anno, pageId, x, y); // async; colors the rect while drawing
    return anno;
  },
  onEditText: (annoId) => {
    for (const page of doc.pages) {
      const anno = page.annotations.find((a) => a.id === annoId);
      if (anno) { openTextEditor({ pageId: page.id, x: anno.x, y: anno.y, anno }); return; }
    }
  },
});

// ---- page manager (Halaman sheet) -----------------------------------------------
const pageManager = createPageManager({
  sheet: document.getElementById('pm-sheet'),
  grid: document.getElementById('pm-grid'),
  bulkBar: document.getElementById('pm-bulk'),
  getDoc: () => doc,
  history,
  getRasterizer: () => rasterizer,
  onDocChanged: rebuildStage,
  onAddFiles: () => document.getElementById('file-input').click(),
  onExtract: async (pages) => {
    // Export ONLY the selected pages: a shallow Doc sharing the same sources.
    try {
      toast('Menyiapkan PDF…');
      const { buildPdfBytes } = await import('../core/export.js');
      const subset = { sources: doc.sources, pages, selection: { pageId: null, annotationId: null } };
      const bytes = await buildPdfBytes(subset, { PDFLib: window.PDFLib, fontkit: window.fontkit });
      download(new Blob([bytes], { type: 'application/pdf' }), `${baseName}-halaman-${pages.length}.pdf`);
      toast(`${pages.length} halaman diekstrak ✓`);
    } catch (err) {
      console.error(err);
      toast('Gagal mengekstrak — coba lagi ya');
    }
  },
  toast,
});
document.getElementById('btn-pages').addEventListener('click', () => pageManager.open());
document.getElementById('pm-close').addEventListener('click', () => pageManager.close());

// ---- inline text editing ------------------------------------------------------------
// One code path for "place new text" and "edit existing text": a contenteditable
// positioned in the page overlay at page coords. Commit on blur / Enter.
function openTextEditor({ pageId, x, y, anno }) {
  const slot = slots.find((s) => s.page.id === pageId);
  if (!slot) return;
  const overlay = slot.view.querySelector('.pv-overlay');
  // New text starts from the format bar's sticky defaults (Canva behavior).
  const style = anno || formatBar.getDefaults();

  const ed = document.createElement('div');
  ed.className = 'v2-text-edit';
  ed.contentEditable = 'true';
  ed.style.left = (anno ? anno.x : x) + 'px';
  ed.style.top = (anno ? anno.y : y) + 'px';
  ed.style.font = textFontCss(style);
  ed.style.color = style.color || '#000';
  ed.textContent = anno?.text || '';

  // Hide the original while editing (the editor visually replaces it).
  const origEl = anno ? overlay.querySelector(`[data-anno-id="${anno.id}"]`) : null;
  if (origEl) origEl.style.visibility = 'hidden';

  editingAnno = anno || null;
  editingEl = ed;
  syncFormatBar();

  let committed = false; // guard: blur fires after Enter-commit too
  const commit = () => {
    if (committed) return;
    committed = true;
    const text = ed.textContent.trim();
    ed.remove();
    editingAnno = null;
    editingEl = null;
    if (anno) {
      if (text && text !== anno.text) {
        record(history, doc);
        updateAnnotation(doc, anno.id, { text });
      } else if (!text) {
        record(history, doc);
        removeAnnotation(doc, anno.id);
      }
    } else if (text) {
      record(history, doc);
      const d = formatBar.getDefaults();
      const created = addAnnotation(doc, pageId, createAnnotation('text', {
        text, x, y,
        fontSize: d.fontSize, fontFamily: d.fontFamily,
        bold: d.bold, italic: d.italic, color: d.color,
      }));
      // Keep the fresh text SELECTED: the user sees it's an object, and a
      // format-bar dropdown change right after the blur-commit still lands.
      selectAnnotation(doc, created.id);
    }
    syncPage(pageId);
    setTool('select');
  };

  ed.addEventListener('blur', commit);
  ed.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ed.blur(); }
    if (e.key === 'Escape') { ed.textContent = anno?.text || ''; ed.blur(); }
    e.stopPropagation(); // don't trigger app shortcuts while typing
  });
  ed.addEventListener('pointerdown', (e) => e.stopPropagation());

  overlay.appendChild(ed);
  ed.focus();
  // Place the caret at the end (mobile keyboards otherwise start at 0).
  const sel = window.getSelection();
  sel.selectAllChildren(ed);
  sel.collapseToEnd();
}

// ---- signature modal (draw / upload / paraf) --------------------------------------------
const signatureModal = createSignatureModal({
  modal: document.getElementById('sig-modal'),
  toast,
  onReady: (sig) => {
    storedSignature = sig; // { dataUrl, width, height, subtype }
    setTool('signature');
    toast(sig.subtype === 'paraf'
      ? 'Ketuk halaman untuk menempatkan paraf'
      : 'Ketuk halaman untuk menempatkan tanda tangan');
  },
});

// ---- "Semua Hal." — copy the selected signature/paraf to every page ----------------------
function selectedSignatureAnno() {
  const id = doc.selection.annotationId;
  if (!id) return null;
  for (const page of doc.pages) {
    const a = page.annotations.find((x) => x.id === id);
    if (a) return a.type === 'signature' ? { page, anno: a } : null;
  }
  return null;
}

// The strip serves two moments: a selected signature (→ Semua Hal.) and the
// armed TTD tool (→ Gambar Ulang, so the saved signature is never a trap).
function syncSigBar() {
  const found = selectedSignatureAnno();
  const armed = tool === 'signature' && !!storedSignature;
  const bar = document.getElementById('sig-bar');
  const allBtn = document.getElementById('btn-all-pages');
  const redrawBtn = document.getElementById('btn-redraw-sig');
  bar.classList.toggle('show', (!!found && doc.pages.length > 1) || armed);
  allBtn.style.display = found && doc.pages.length > 1 ? '' : 'none';
  redrawBtn.style.display = armed ? '' : 'none';
  document.getElementById('sig-bar-label').textContent = found
    ? (found.anno.subtype === 'paraf' ? 'Paraf terpilih' : 'Tanda tangan terpilih')
    : (armed ? 'Ketuk halaman untuk menempatkan' : '');
}
document.getElementById('btn-redraw-sig').addEventListener('click', () => signatureModal.open());

document.getElementById('btn-all-pages').addEventListener('click', () => {
  const found = selectedSignatureAnno();
  if (!found) return;
  const { page: home, anno } = found;
  record(history, doc);
  for (const page of doc.pages) {
    if (page.id === home.id) continue;
    // Same position on every page; each copy is its OWN object (new id) so it
    // moves/deletes independently afterwards.
    addAnnotation(doc, page.id, createAnnotation('signature', {
      image: anno.image, subtype: anno.subtype,
      x: anno.x, y: anno.y, width: anno.width, height: anno.height,
    }));
  }
  rebuildStage();
  toast(`Diterapkan ke ${doc.pages.length - 1} halaman lain ✓`);
});

// ---- delete / undo / redo ------------------------------------------------------------
function deleteSelected() {
  const id = doc.selection.annotationId;
  if (!id) return;
  let pageId = null;
  for (const page of doc.pages) {
    if (page.annotations.some((a) => a.id === id)) { pageId = page.id; break; }
  }
  record(history, doc);
  removeAnnotation(doc, id);
  if (pageId) syncPage(pageId);
}

function doUndo() { if (undo(history, doc)) rebuildStage(); }
function doRedo() { if (redo(history, doc)) rebuildStage(); }
document.getElementById('btn-undo').addEventListener('click', doUndo);
document.getElementById('btn-redo').addEventListener('click', doRedo);

document.addEventListener('keydown', (e) => {
  // Never hijack typing surfaces (the inline editor stops propagation itself).
  if (e.target.matches?.('input, select, textarea, [contenteditable="true"]')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
  else if (mod && e.key === 'y') { e.preventDefault(); doRedo(); }
  else if (mod && e.key === 's') { e.preventDefault(); doDownload(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && doc.selection.annotationId) {
    e.preventDefault(); deleteSelected();
  } else if (e.key === 'Escape') {
    // Native <dialog> closes itself on Escape; this handles the editor surface.
    clearSelection(doc);
    interaction.setSelected(null, null);
    setTool('select');
  } else if (!mod && doc.pages.length > 0) {
    // Tool verbs — same keys as the old editor (muscle memory carries over).
    const k = e.key.toLowerCase();
    if (k === 'v') setTool('select');
    else if (k === 't') setTool('text');
    else if (k === 'w') setTool('whiteout');
    else if (k === 's' || k === 'p') {
      if (storedSignature) setTool('signature');
      else signatureModal.open();
    }
  }
});

// Arrow-key nudge for the selected annotation (1px, Shift = 10px) — parity
// with the live editor's #74. Separate listener: it must also work while a
// tool other than Pilih is active.
let nudgeLast = 0;
document.addEventListener('keydown', (e) => {
  if (!doc.selection.annotationId) return;
  if (e.target.matches?.('input, select, textarea, [contenteditable="true"]')) return;
  const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (!dir) return;
  e.preventDefault();
  const step = e.shiftKey ? 10 : 1;
  // One undo step per nudge burst: only record when the previous keydown was >600ms ago.
  const now = Date.now();
  if (!nudgeLast || now - nudgeLast > 600) record(history, doc);
  nudgeLast = now;
  const a = moveAnnotation(doc, doc.selection.annotationId, dir[0] * step, dir[1] * step);
  if (a) {
    const el = stage.querySelector(`[data-anno-id="${a.id}"]`);
    if (el) { el.style.left = a.x + 'px'; el.style.top = a.y + 'px'; }
  }
});

// ---- file loading (multi-file = merge, by construction) --------------------------------
// Size guards (carried from the live app): heads-up above 20MB, block at 100MB
// — a 100MB+ file will OOM the weak phones we build for before it ever renders.
const SIZE_WARN = 20 * 1024 * 1024;
const SIZE_BLOCK = 100 * 1024 * 1024;

async function loadFiles(files) {
  const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
  const isImg = (f) => f.type.startsWith('image/');
  // In picker order: PDFs append their pages, images become one page each.
  const usable = [...files].filter((f) => isPdf(f) || isImg(f));
  if (usable.length === 0) { toast('Pilih file PDF atau gambar ya'); return; }
  const oversize = usable.find((f) => f.size > SIZE_BLOCK);
  if (oversize) { toast(`"${oversize.name}" terlalu besar (maks 100MB)`); return; }
  if (usable.some((f) => f.size > SIZE_WARN)) toast('File besar — proses bisa agak lama ya');
  const firstLoad = doc.pages.length === 0;
  if (firstLoad) baseName = usable[0].name.replace(/\.[^.]+$/, '');

  for (const f of usable) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (isPdf(f)) await importPdf(doc, { name: f.name, bytes });
    else await importImage(doc, { name: f.name, bytes, mimeType: f.type });
  }
  if (!rasterizer) rasterizer = createPageRasterizer(doc);
  emptyEl.style.display = 'none';

  if (firstLoad) {
    zoom = Math.min(1, (scrollEl.clientWidth - 16) / doc.pages[0].width);
  }
  rebuildStage(); // applies zoom + sizer at the end
  if (!firstLoad) toast(`${usable.length} file ditambahkan`);
  // If the Halaman sheet triggered this add, refresh its grid in place.
  if (document.getElementById('pm-sheet').open) pageManager.render();
}

const fileInput = document.getElementById('file-input');
document.getElementById('btn-open').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async (e) => {
  const files = e.target.files;
  if (files?.length) await loadFiles(files).catch((err) => { console.error(err); toast('Gagal membuka file'); });
  fileInput.value = '';
});

// Drag & drop anywhere (desktop).
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) loadFiles(e.dataTransfer.files);
});

// ---- download ---------------------------------------------------------------------------
async function doDownload() {
  if (doc.pages.length === 0) return;
  const btn = document.getElementById('btn-download');
  btn.disabled = true;
  btn.textContent = 'Menyiapkan…';
  try {
    const { buildPdfBytes } = await import('../core/export.js');
    const bytes = await buildPdfBytes(doc, { PDFLib: window.PDFLib, fontkit: window.fontkit });
    download(new Blob([bytes], { type: 'application/pdf' }), `${baseName}-pdflokal.pdf`);
    toast('PDF berhasil dibuat ✓');
  } catch (err) {
    console.error(err);
    toast('Gagal membuat PDF — coba lagi ya');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Unduh';
  }
}
document.getElementById('btn-download').addEventListener('click', doDownload);

// ---- test hooks (same pattern the old suite relies on) ----------------------------------
window.v2 = {
  getDoc: () => doc,
  getSlots: () => slots,
  loadFiles,
  setTool,
  getTool: () => tool,
  history,
};
