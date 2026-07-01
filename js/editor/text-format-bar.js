/*
 * PDFLokal - editor/text-format-bar.js (ES Module)
 *
 * Contextual floating format toolbar for text annotations — the Word/Figma/Canva
 * pattern. Appears anchored above a text annotation in two situations:
 *   1. While the inline text editor is open (creating or editing text).
 *   2. When a text annotation is selected with the Pilih (select) tool.
 *
 * Every control applies LIVE to the target annotation (mutate + redraw), so it's
 * WYSIWYG. Changes also persist into ueState.lastTextOptions, so the next text
 * annotation inherits the style — the same "last used" behaviour the inline flow
 * already relied on (UX audit H2).
 *
 * WHY this exists: PR #54 rerouted the Text tool to inline-on-first-click, which
 * bypassed the (now orphaned) text-input-modal — leaving NO reachable UI to pick
 * a font family or toggle bold/italic. This bar restores that, inline.
 */

import { ueState, buildCanvasFont } from '../lib/state.js';
import { getTextBounds } from './canvas-utils.js';
import { ueRedrawAnnotations } from './annotations.js';
import { uePushAnnotationSnapshot } from './undo-redo.js';

// Current target: the annotation the bar is editing + the page it lives on.
let target = null; // { anno, pageIndex }
let wired = false;

// WHY one snapshot per burst: clicking B, then I, then bumping size in quick
// succession should collapse into a SINGLE undo entry, not one per click.
// Mirrors the debounced-undo pattern used for arrow-nudge/inline edits.
let snapshotPushedForBurst = false;
let burstTimer = null;
const BURST_MS = 800;

const CHROME_TOP = 96; // header + toolbar height to avoid placing the bar under

function bar() { return document.getElementById('text-format-bar'); }
function byId(id) { return document.getElementById(id); }

// Resolve which page an annotation reference lives on. Prefer the hint; fall
// back to scanning (dblclick-edit doesn't thread a pageIndex through).
function resolvePageIndex(anno, hint) {
  if (typeof hint === 'number' && ueState.annotations[hint]?.includes(anno)) return hint;
  for (const [key, list] of Object.entries(ueState.annotations)) {
    if (list.includes(anno)) return Number(key);
  }
  return ueState.selectedPage;
}

function markChange() {
  if (!snapshotPushedForBurst) {
    uePushAnnotationSnapshot(JSON.parse(JSON.stringify(ueState.annotations)));
    snapshotPushedForBurst = true;
  }
  clearTimeout(burstTimer);
  burstTimer = setTimeout(() => { snapshotPushedForBurst = false; }, BURST_MS);
}

function persistLastOptions() {
  if (!target) return;
  const a = target.anno;
  ueState.lastTextOptions = {
    fontSize: a.fontSize,
    color: a.color,
    fontFamily: a.fontFamily,
    bold: !!a.bold,
    italic: !!a.italic,
  };
}

// Keep the inline text editor's on-screen font/colour in sync when the user
// restyles WHILE typing (so it's truly WYSIWYG, not "changes on commit").
function syncInlineEditor() {
  const editor = byId('inline-text-editor');
  if (!editor || !target) return;
  const a = target.anno;
  const canvas = ueState.pageCanvases[target.pageIndex]?.canvas;
  const dpr = ueState.devicePixelRatio || 1;
  const scaleX = canvas ? canvas.getBoundingClientRect().width / (canvas.width / dpr) : 1;
  editor.style.font = buildCanvasFont(a, a.fontSize * scaleX);
  editor.style.color = a.color || '#000000';
}

// Apply the current target's state to the canvas + editor + persisted defaults.
function applyChange() {
  markChange();
  ueRedrawAnnotations();
  syncInlineEditor();
  persistLastOptions();
  // Confirm/delete buttons track the annotation; keep them aligned after resize.
  if (typeof window.ueUpdateConfirmButtonPosition === 'function') {
    window.ueUpdateConfirmButtonPosition(target?.anno);
  }
  repositionTextFormatBar();
}

function clampSize(n) {
  if (Number.isNaN(n)) return 16;
  return Math.min(120, Math.max(6, n));
}

// WHY: font <select> and the size <input> steal focus from the inline editor.
// After a discrete change, hand focus back so the blur-save timer is cancelled
// (inline-editor listens for focus) and typing/Enter keep working. Caret to end.
function refocusInlineEditor() {
  const ed = byId('inline-text-editor');
  if (!ed) return;
  ed.focus();
  const range = document.createRange();
  range.selectNodeContents(ed);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function wireOnce() {
  if (wired) return;
  wired = true;

  byId('tfb-font').addEventListener('change', (e) => {
    if (!target) return;
    target.anno.fontFamily = e.target.value;
    applyChange();
    refocusInlineEditor();
  });

  byId('tfb-bold').addEventListener('click', () => {
    if (!target) return;
    target.anno.bold = !target.anno.bold;
    byId('tfb-bold').setAttribute('aria-pressed', String(!!target.anno.bold));
    byId('tfb-bold').classList.toggle('active', !!target.anno.bold);
    applyChange();
  });

  byId('tfb-italic').addEventListener('click', () => {
    if (!target) return;
    target.anno.italic = !target.anno.italic;
    byId('tfb-italic').setAttribute('aria-pressed', String(!!target.anno.italic));
    byId('tfb-italic').classList.toggle('active', !!target.anno.italic);
    applyChange();
  });

  const commitSize = (n) => {
    if (!target) return;
    const size = clampSize(n);
    target.anno.fontSize = size;
    byId('tfb-size').value = size;
    applyChange();
  };
  byId('tfb-size').addEventListener('change', (e) => {
    commitSize(Number.parseInt(e.target.value, 10));
    refocusInlineEditor();
  });
  byId('tfb-size-dec').addEventListener('click', () => commitSize((target?.anno.fontSize || 16) - 1));
  byId('tfb-size-inc').addEventListener('click', () => commitSize((target?.anno.fontSize || 16) + 1));

  byId('tfb-color').addEventListener('input', (e) => {
    if (!target) return;
    target.anno.color = e.target.value;
    applyChange();
  });

  // WHY mousedown preventDefault: clicking a bar control must NOT blur the inline
  // text editor (blur queues saveEdit, which would tear the editor down mid-format).
  bar().addEventListener('mousedown', (e) => {
    if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') e.preventDefault();
  });
}

// Load the bar's controls from the target annotation's current formatting.
function populateFromTarget() {
  const a = target.anno;
  byId('tfb-font').value = a.fontFamily || 'Helvetica';
  byId('tfb-size').value = a.fontSize || 16;
  byId('tfb-color').value = a.color || '#000000';
  byId('tfb-bold').classList.toggle('active', !!a.bold);
  byId('tfb-bold').setAttribute('aria-pressed', String(!!a.bold));
  byId('tfb-italic').classList.toggle('active', !!a.italic);
  byId('tfb-italic').setAttribute('aria-pressed', String(!!a.italic));
}

// WHY position: fixed + viewport coords: the bar floats over everything and must
// track the annotation as the user scrolls (Figma/Canva "glued" toolbar). We
// recompute from the page canvas's on-screen rect each time.
export function repositionTextFormatBar() {
  const b = bar();
  if (!b || !target || b.hidden) return;
  const canvas = ueState.pageCanvases[target.pageIndex]?.canvas;
  if (!canvas) { hideTextFormatBar(); return; }

  const ctx = canvas.getContext('2d');
  const bounds = getTextBounds(target.anno, ctx);
  const rect = canvas.getBoundingClientRect();
  const dpr = ueState.devicePixelRatio || 1;
  const scaleX = rect.width / (canvas.width / dpr);
  const scaleY = rect.height / (canvas.height / dpr);

  const textLeft = rect.left + bounds.x * scaleX;
  const textTop = rect.top + bounds.y * scaleY;
  const textBottom = textTop + bounds.height * scaleY;

  const bw = b.offsetWidth || 260;
  const bh = b.offsetHeight || 40;
  const gap = 8;

  // Prefer above the text; drop below if it would collide with the top chrome.
  let top = textTop - bh - gap;
  if (top < CHROME_TOP) top = textBottom + gap;
  // Keep on-screen vertically.
  top = Math.min(top, window.innerHeight - bh - gap);
  top = Math.max(top, CHROME_TOP);

  let left = textLeft;
  left = Math.min(left, window.innerWidth - bw - 8);
  left = Math.max(left, 8);

  b.style.left = left + 'px';
  b.style.top = top + 'px';
}

const onScrollResize = () => repositionTextFormatBar();

export function showTextFormatBar(anno, pageIndexHint) {
  if (!anno || anno.type !== 'text') return;
  const b = bar();
  if (!b) return;

  target = { anno, pageIndex: resolvePageIndex(anno, pageIndexHint) };
  wireOnce();
  populateFromTarget();

  b.hidden = false;
  repositionTextFormatBar();

  window.addEventListener('scroll', onScrollResize, { passive: true });
  window.addEventListener('resize', onScrollResize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onScrollResize);
}

export function hideTextFormatBar() {
  const b = bar();
  if (b) b.hidden = true;
  target = null;
  window.removeEventListener('scroll', onScrollResize);
  window.removeEventListener('resize', onScrollResize);
  if (window.visualViewport) window.visualViewport.removeEventListener('resize', onScrollResize);
}
