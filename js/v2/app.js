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
} from '../core/operations.js';
import { createHistory, record, undo, redo, canUndo, canRedo } from '../core/history.js';
import { importPdf, createPageRasterizer } from '../core/import.js';
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
// CSS `zoom` (standardized 2024), NOT transform: it participates in layout, so
// the scroll container sizes correctly at any zoom — no sizer-div math. gBCR
// returns zoomed values, which is exactly what interaction.js divides out.
function applyZoom() {
  stage.style.zoom = zoom;
  stream.refresh(0);
}
document.getElementById('z-in').onclick = () => { zoom = Math.min(zoom + 0.25, 3); applyZoom(); };
document.getElementById('z-out').onclick = () => { zoom = Math.max(zoom - 0.25, 0.3); applyZoom(); };

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
  stream.refresh(0);
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
  document.getElementById('btn-delete-anno').disabled = !doc.selection.annotationId;
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

// ---- interaction wiring ------------------------------------------------------------
const interaction = createInteraction({
  stage,
  getDoc: () => doc,
  getZoom: () => zoom,
  getTool: () => tool,
  history,
  onChange: (kind) => {
    if (kind === 'select') refreshChrome();
    else refreshChrome(); // move/resize/draw: chrome only; DOM was updated surgically
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
    return anno; // whiteout stays sticky (multi-stamp exception)
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

function syncSigBar() {
  const found = selectedSignatureAnno();
  const bar = document.getElementById('sig-bar');
  bar.classList.toggle('show', !!found && doc.pages.length > 1);
  if (found) {
    document.getElementById('sig-bar-label').textContent =
      found.anno.subtype === 'paraf' ? 'Paraf terpilih' : 'Tanda tangan terpilih';
  }
}

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
document.getElementById('btn-delete-anno').addEventListener('click', deleteSelected);

function doUndo() { if (undo(history, doc)) rebuildStage(); }
function doRedo() { if (redo(history, doc)) rebuildStage(); }
document.getElementById('btn-undo').addEventListener('click', doUndo);
document.getElementById('btn-redo').addEventListener('click', doRedo);

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 'z') { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
  else if (mod && e.key === 'y') { e.preventDefault(); doRedo(); }
  else if (mod && e.key === 's') { e.preventDefault(); doDownload(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && doc.selection.annotationId) {
    e.preventDefault(); deleteSelected();
  } else if (e.key === 'Escape') {
    clearSelection(doc);
    interaction.setSelected(null, null);
    setTool('select');
  }
});

// ---- file loading (multi-file = merge, by construction) --------------------------------
async function loadFiles(files) {
  const pdfs = [...files].filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (pdfs.length === 0) { toast('Pilih file PDF ya'); return; }
  const firstLoad = doc.pages.length === 0;
  if (firstLoad) baseName = pdfs[0].name.replace(/\.pdf$/i, '');

  for (const f of pdfs) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    await importPdf(doc, { name: f.name, bytes }); // appends pages → merge
  }
  if (!rasterizer) rasterizer = createPageRasterizer(doc);
  emptyEl.style.display = 'none';

  if (firstLoad) {
    zoom = Math.min(1, (scrollEl.clientWidth - 16) / doc.pages[0].width);
    stage.style.zoom = zoom;
  }
  rebuildStage();
  if (!firstLoad) toast(`${pdfs.length} file ditambahkan`);
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
