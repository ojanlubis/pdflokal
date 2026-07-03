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
import { createDownloadSheet } from './download-sheet.js';
import { track } from '../lib/analytics.js';
import { createCelebration } from './celebrate.js';

window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/js/vendor/pdf.worker.min.js';

// ---- state (ONE doc, ONE history — everything else is DOM or derived) -------
let doc = createDoc(); // replaced wholesale by "Buka Baru" (File menu)
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
  // The chokepoint every export path funnels through — celebrate here, AFTER
  // the save was triggered. (Wave 5: reward the "I got my file" moment.)
  celebration.onDownloadSuccess();
}
const celebration = createCelebration({ toast });

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
  document.getElementById('btn-file').disabled = doc.pages.length === 0;
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
    if (kind === 'draw') { track('editor_action', { action: 'whiteout' }); setTool('select'); }
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
      track('editor_action', { action: storedSignature.subtype === 'paraf' ? 'paraf' : 'signature' });
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
  pickBar: document.getElementById('pm-pickbar'),
  getDoc: () => doc,
  history,
  getRasterizer: () => rasterizer,
  onDocChanged: rebuildStage,
  onAddFiles: () => document.getElementById('file-input').click(),
  onExtract: async (pages) => {
    // Export ONLY the selected pages: a shallow Doc sharing the same sources.
    try {
      toast('Sebentar, lagi disiapkan');
      const { buildPdfBytes } = await import('../core/export.js');
      const subset = { sources: doc.sources, pages, selection: { pageId: null, annotationId: null } };
      const bytes = await buildPdfBytes(subset, { PDFLib: window.PDFLib, fontkit: window.fontkit });
      download(new Blob([bytes], { type: 'application/pdf' }), `${baseName}-halaman-${pages.length}.pdf`);
      toast(`Selesai! ${pages.length} halaman diekstrak jadi PDF baru`);
    } catch (err) {
      console.error(err);
      toast('Waduh, gagal mengekstrak. Coba sekali lagi ya');
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
        track('editor_action', { action: 'text_inline' });
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
      track('editor_action', { action: 'text' });
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
    // Founder punch list #1: if a placed signature is SELECTED when the user
    // redraws, they're fixing THAT one — swap its image in place instead of
    // making them delete + re-place. Otherwise arm placement as before.
    const found = selectedSignatureAnno();
    if (found) {
      record(history, doc);
      found.anno.image = sig.dataUrl;
      found.anno.height = found.anno.width * (sig.height / sig.width);
      rebuildStage();
      toast('Tanda tangan diganti');
      return;
    }
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
  // Punch list #1: a SELECTED signature also offers Gambar Ulang — "it placed
  // the old ttd" must be fixable right where the user is looking.
  bar.classList.toggle('show', !!found || armed);
  allBtn.style.display = found && doc.pages.length > 1 ? '' : 'none';
  redrawBtn.style.display = (armed || found) ? '' : 'none';
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
  toast(`Oke, ditaruh di ${doc.pages.length - 1} halaman lainnya juga`);
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

function doUndo() { if (undo(history, doc)) { pageManager.invalidateThumbs(); rebuildStage(); } }
function doRedo() { if (redo(history, doc)) { pageManager.invalidateThumbs(); rebuildStage(); } }
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

let loadingFiles = false; // re-entry guard: double-taps and rapid picks interleave imports

async function loadFiles(files) {
  if (loadingFiles) { toast('Sebentar ya, file sebelumnya masih dimuat'); return; }
  loadingFiles = true;
  try {
    await loadFilesInner(files);
  } finally {
    loadingFiles = false;
  }
}

async function loadFilesInner(files) {
  const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
  const isImg = (f) => f.type.startsWith('image/');
  // In picker order: PDFs append their pages, images become one page each.
  const usable = [...files].filter((f) => isPdf(f) || isImg(f));
  if (usable.length === 0) { toast('Pilih file PDF atau gambar ya'); return; }
  const oversize = usable.find((f) => f.size > SIZE_BLOCK);
  if (oversize) { toast(`"${oversize.name}" terlalu besar (maks 100MB)`); return; }
  if (usable.some((f) => f.size > SIZE_WARN)) toast('Filenya lumayan besar, sabar sebentar ya');
  const firstLoad = doc.pages.length === 0;
  if (firstLoad) baseName = usable[0].name.replace(/\.[^.]+$/, '');

  for (const f of usable) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (isPdf(f)) await importPdf(doc, { name: f.name, bytes });
    else await importImage(doc, { name: f.name, bytes, mimeType: f.type });
    track('file_loaded', { tool: 'editor-v2', fileType: isPdf(f) ? 'pdf' : 'image' });
  }
  if (!rasterizer) rasterizer = createPageRasterizer(doc);
  emptyEl.style.display = 'none';
  document.body.classList.remove('is-empty'); // landing yields, editor chrome returns

  if (firstLoad) {
    zoom = Math.min(1, (scrollEl.clientWidth - 16) / doc.pages[0].width);
  }
  rebuildStage(); // applies zoom + sizer at the end
  if (!firstLoad) toast(`Dijepit jadi satu, sekarang ${doc.pages.length} halaman`);
  // If the Halaman sheet triggered this add, refresh its grid in place.
  if (document.getElementById('pm-sheet').open) pageManager.render();

  // The intent hook: a landing card (or a future /gabung-pdf page via ?buat=)
  // told us what the user came to do — configure the editor for it, once.
  if (firstLoad && pendingIntent) {
    const intent = pendingIntent;
    pendingIntent = null;
    applyIntent(intent);
  }
}

// ---- the landing: dropzone, tool cards, intent hook -------------------------------
// WHY ?buat= exists now: SEO intent pages (/gabung-pdf etc, strategy bet 5.3)
// boot the editor pre-configured. Planned = one line; retrofitted = a refactor.
let pendingIntent = new URLSearchParams(window.location.search).get('buat');

function applyIntent(intent) {
  if (intent === 'ttd' || intent === 'paraf') {
    // Same semantics as the toolbar button: no stored signature → the modal
    // opens to make one; otherwise arm placement.
    if (!storedSignature) { signatureModal.open(); return; }
    setTool('signature');
    toast('Ketuk halaman untuk menempatkan tanda tangan');
  } else if (intent === 'teks') {
    setTool('text');
    toast('Ketuk halaman untuk menulis');
  } else if (intent === 'tipex') {
    setTool('whiteout');
    toast('Seret di halaman untuk menutup teks');
  } else if (intent === 'kompres') downloadSheet.open({ size: 'kompres' });
  else if (intent === 'gambar') downloadSheet.open({ format: 'img' });
  else if (intent === 'split' || intent === 'halaman') pageManager.open();
  else if (intent === 'gabung') toast('Tambah file lainnya lewat menu File di kiri atas');
}

const fileInput = document.getElementById('file-input');
const DEFAULT_ACCEPT = fileInput.getAttribute('accept');
document.getElementById('btn-open').addEventListener('click', () => fileInput.click());

for (const card of document.querySelectorAll('.ld-card[data-intent]')) {
  card.addEventListener('click', () => {
    pendingIntent = card.dataset.intent;
    // Foto jadi PDF narrows the picker to images; everything else keeps both.
    fileInput.setAttribute('accept', pendingIntent === 'foto' ? 'image/*' : DEFAULT_ACCEPT);
    fileInput.click();
  });
}

const lihatBtn = document.getElementById('ld-lihat');
const moreGrid = document.getElementById('ld-more');
lihatBtn.addEventListener('click', () => {
  const open = moreGrid.hidden;
  moreGrid.hidden = !open;
  lihatBtn.setAttribute('aria-expanded', String(open));
  lihatBtn.firstChild.textContent = open ? 'Sembunyikan' : 'Lihat semua alat';
});

// The dropzone welcomes an incoming drag (border + tint via .over).
const dropzoneEl = document.getElementById('btn-open');
for (const ev of ['dragenter', 'dragover']) {
  dropzoneEl.addEventListener(ev, (e) => { e.preventDefault(); dropzoneEl.classList.add('over'); });
}
for (const ev of ['dragleave', 'drop']) {
  dropzoneEl.addEventListener(ev, () => dropzoneEl.classList.remove('over'));
}

// ---- File menu: add more files or start over WITHOUT a page refresh ----------------
const fileMenu = document.getElementById('file-menu');
const fileBtn = document.getElementById('btn-file');
let pendingReplace = false; // next file selection replaces the doc instead of appending

function toggleFileMenu(show) {
  fileMenu.hidden = !show;
  fileBtn.setAttribute('aria-expanded', String(show));
}
fileBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleFileMenu(fileMenu.hidden); });
document.addEventListener('pointerdown', (e) => {
  if (!fileMenu.hidden && !e.target.closest('.file-menu-wrap')) toggleFileMenu(false);
});
document.getElementById('fm-add').addEventListener('click', () => {
  toggleFileMenu(false);
  fileInput.click(); // appends → merge, the default loadFiles path
});
document.getElementById('fm-new').addEventListener('click', () => {
  toggleFileMenu(false);
  pendingReplace = true; // applied when the picker actually returns files
  fileInput.click();
});

// Start over: a FRESH doc + history. The signature stays (it's the user's,
// not the document's). Cancelling the picker leaves everything untouched.
async function resetDoc() {
  doc = createDoc();
  history.undoStack.length = 0;
  history.redoStack.length = 0;
  if (rasterizer) { await rasterizer.destroy(); rasterizer = null; }
  slots = [];
  stage.innerHTML = '';
  baseName = 'dokumen';
  setTool('select');
}
fileInput.addEventListener('change', async (e) => {
  const files = e.target.files;
  if (files?.length) {
    if (pendingReplace) await resetDoc();
    await loadFiles(files).catch((err) => { console.error(err); toast('Gagal membuka file'); });
  }
  pendingReplace = false; // picker cancelled → nothing was destroyed
  fileInput.value = '';
  fileInput.setAttribute('accept', DEFAULT_ACCEPT); // undo any intent narrowing (Foto jadi PDF)
});

// Drag & drop anywhere (desktop).
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer?.files?.length) loadFiles(e.dataTransfer.files);
});

// ---- download: the Unduh sheet (output pipeline) ------------------------------------------
// Opening it starts building the REAL PDF in the background — by the time the
// 90% user taps the big button, the bytes are already there.
const downloadSheet = createDownloadSheet({
  modal: document.getElementById('dl-sheet'),
  getDoc: () => doc,
  getBaseName: () => baseName,
  pickPages: (preselected) => pageManager.openPick(preselected),
  download,
  toast,
});
function doDownload() {
  if (doc.pages.length === 0) return;
  downloadSheet.open();
}
document.getElementById('btn-download').addEventListener('click', doDownload);

// ---- wordmark → home (punch list #3) --------------------------------------------
// On the landing the wordmark is already home; with a doc open it asks first —
// a reload throws away un-downloaded edits.
document.getElementById('btn-home').addEventListener('click', () => {
  if (document.body.classList.contains('is-empty')) return;
  document.getElementById('home-confirm').showModal();
});
document.getElementById('hc-cancel').addEventListener('click', () => {
  document.getElementById('home-confirm').close();
});
document.getElementById('hc-go').addEventListener('click', () => {
  window.location.assign('/');
});

// ---- Android back button: closes the open sheet, never leaves the app -----------------
// Every dialog open pushes one history entry; the hardware/gesture back pops it
// and we close the dialog. UI-initiated closes (✕, backdrop, Escape, success)
// consume their entry with history.back() — guarded so our own back() doesn't
// cascade into closing the next dialog underneath (nested pm-over-download case).
(function wireDialogHistory() {
  // NOTE: window.history everywhere — plain `history` is SHADOWED in this
  // module by the undo history (const history = createHistory()).
  const dialogs = ['pm-sheet', 'sig-modal', 'dl-sheet', 'home-confirm'].map((id) => document.getElementById(id));
  const stack = []; // open dialogs in STACKING order (array order lies for nesting)
  let expectPop = false;

  for (const dlg of dialogs) {
    const nativeShow = dlg.showModal.bind(dlg);
    dlg.showModal = () => {
      if (dlg.open) return; // double-tap/double-Ctrl+S: showModal throws on open dialogs
      nativeShow();
      window.history.pushState({ v2dlg: dlg.id }, '');
      stack.push(dlg);
    };
    dlg.addEventListener('close', () => {
      const i = stack.lastIndexOf(dlg);
      if (i !== -1) stack.splice(i, 1);
      // Closed by UI code → its history entry is stale; consume it silently.
      if (window.history.state?.v2dlg === dlg.id) {
        expectPop = true;
        window.history.back();
      }
    });
  }

  window.addEventListener('popstate', () => {
    if (expectPop) { expectPop = false; return; }
    // Hardware back: close every dialog stacked ABOVE the entry we landed on.
    // Rapid double-back COALESCES two traversals into one popstate — closing
    // only the top layer would strand the lower sheet open with no history
    // entry left (the next back would exit the app with a sheet showing).
    const cur = window.history.state?.v2dlg || null;
    const keepIdx = cur ? stack.findIndex((d) => d.id === cur) : -1;
    const toClose = stack.slice(keepIdx + 1).reverse();
    for (const d of toClose) if (d.open) d.close();
  });
}());

// ---- test hooks (same pattern the old suite relies on) ----------------------------------
window.v2 = {
  getDoc: () => doc,
  getSlots: () => slots,
  loadFiles,
  setTool,
  getTool: () => tool,
  history,
};
