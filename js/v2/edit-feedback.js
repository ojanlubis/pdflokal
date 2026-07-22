/*
 * PDFLokal — v2/edit-feedback.js  (BETA edit-feedback — founder ruling 2026-07-22)
 * ============================================================================
 * "Ship the per-line editor as beta, ask 👍/👎, let telemetry do the rest."
 * WHEN to ask, refined twice by the founder the same day:
 *   1. NOT after every commit (naggy for a 20-line session).
 *   2. NOT in the download sheet either ("to put it here is wrong").
 *   3. → a DEBOUNCED toast: after the user's edit activity goes QUIET for a
 *      beat (~2.5s with no new commit and no re-arm of the Edit tool), ask once.
 *      The idle-detector lives in js/v2/app.js; this module is just the toast.
 *
 * A floating pill (bottom-center), quiet per ojan-ui-taste: one small ask, never
 * covers the page, auto-vanishes if ignored. 👎 opens a short note whose
 * placeholder ASKS for detail ("isi feedback biar kita bisa improve") rather
 * than waving it off as optional. An abandoned 👎 is still recorded note-less.
 * Feeds telemetry.js feedback() (its own endpoint + table; never the events rail).
 */
import { feedback } from './telemetry.js';

const ASK_MS = 7000;   // ignored ask → vanish, no vote recorded
const NOTE_MS = 25000; // ignored open note box → record the 👎 without a note
const NOTE_MAXLEN = 500;

let root = null;
let body = null;
let hideTimer = null;
let downPending = false;
let resolved = false;

function injectStyleOnce() {
  if (document.getElementById('edit-feedback-style')) return;
  const style = document.createElement('style');
  style.id = 'edit-feedback-style';
  style.textContent = `
    #edit-feedback {
      position: fixed; left: 50%; bottom: calc(env(safe-area-inset-bottom, 0px) + 74px);
      transform: translate(-50%, 8px); z-index: 60;
      display: flex; align-items: center; gap: 10px;
      max-width: min(92vw, 460px);
      padding: 9px 12px; border-radius: 13px;
      background: var(--surface, #fff); color: var(--ink, #211d1a);
      border: 1px solid var(--line, rgba(63,49,35,.12));
      box-shadow: 0 6px 22px rgba(33,29,26,.16), 0 1px 3px rgba(33,29,26,.08);
      font: 14px/1.3 'Plus Jakarta Sans', system-ui, sans-serif;
      opacity: 0; pointer-events: none;
      transition: opacity .18s ease, transform .18s ease;
    }
    #edit-feedback.show { opacity: 1; transform: translate(-50%, 0); pointer-events: auto; }
    #edit-feedback .ef-q { color: var(--muted, #79716b); white-space: nowrap; }
    #edit-feedback .ef-thumb {
      appearance: none; border: 1px solid var(--line, rgba(63,49,35,.12));
      background: var(--bg, #f1ede7); border-radius: 9px;
      width: 42px; height: 34px; font-size: 18px; line-height: 1; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      transition: transform .1s ease, background .1s ease;
    }
    #edit-feedback .ef-thumb:hover { background: #eae4dc; }
    #edit-feedback .ef-thumb:active { transform: scale(.92); }
    #edit-feedback .ef-note {
      flex: 1 1 170px; min-width: 0; padding: 7px 9px; font: inherit;
      border: 1px solid var(--line, rgba(63,49,35,.12)); border-radius: 8px;
      background: var(--bg, #f1ede7); color: var(--ink, #211d1a);
    }
    #edit-feedback .ef-note:focus { outline: 2px solid var(--accent, #dc2626); outline-offset: 0; }
    #edit-feedback .ef-send {
      appearance: none; border: 0; cursor: pointer; white-space: nowrap;
      background: var(--accent, #dc2626); color: #fff; font: inherit; font-weight: 600;
      padding: 8px 12px; border-radius: 8px;
    }
    #edit-feedback .ef-send:active { background: var(--accent-down, #b91c1c); }
    @media (prefers-reduced-motion: reduce) {
      #edit-feedback, #edit-feedback.show { transform: translate(-50%, 0); transition: opacity .18s ease; }
    }
  `;
  document.head.appendChild(style);
}

function buildRoot() {
  root = document.createElement('div');
  root.id = 'edit-feedback';
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  body = document.createElement('div');
  body.style.cssText = 'display:flex;align-items:center;gap:10px;width:100%;';
  root.appendChild(body);
  document.body.appendChild(root);
}

function clearTimer() { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } }
function hide() { clearTimer(); if (root) root.classList.remove('show'); }
function clear() { while (body.firstChild) body.removeChild(body.firstChild); }

// Close the pill; a still-open 👎 is recorded note-less exactly once.
function finish() {
  if (downPending && !resolved) { resolved = true; try { feedback('down'); } catch { /* never throws */ } }
  hide();
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderThanks() {
  clear();
  body.appendChild(el('span', 'ef-q', 'Makasih — masukanmu ngebantu kami 🙏'));
  clearTimer();
  hideTimer = setTimeout(hide, 1700);
}

function renderNote() {
  clear();
  body.appendChild(el('span', 'ef-q', 'Apa yang kurang pas?'));
  const input = el('input', 'ef-note');
  input.type = 'text';
  input.maxLength = NOTE_MAXLEN;
  // Founder ruling 2026-07-22: the placeholder ASKS for the detail, not "boleh
  // kosong" — we want the reason, and telemetry only works if the signal comes.
  input.placeholder = 'isi feedback biar kita bisa improve';
  input.setAttribute('aria-label', 'Ceritakan apa yang kurang pas');
  const send = el('button', 'ef-send', 'Kirim');
  send.type = 'button';
  const submit = () => {
    if (resolved) return;
    resolved = true; downPending = false;
    try { feedback('down', input.value); } catch { /* never throws */ }
    renderThanks();
  };
  send.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    e.stopPropagation();
  });
  body.appendChild(input);
  body.appendChild(send);
  input.focus();
  clearTimer();
  hideTimer = setTimeout(finish, NOTE_MS);
}

function renderAsk() {
  clear();
  body.appendChild(el('span', 'ef-q', 'Gimana hasil editnya?'));
  const up = el('button', 'ef-thumb', '👍');
  up.type = 'button'; up.setAttribute('aria-label', 'Bagus');
  up.addEventListener('click', () => {
    if (resolved) return;
    resolved = true;
    try { feedback('up'); } catch { /* never throws */ }
    renderThanks();
  });
  const down = el('button', 'ef-thumb', '👎');
  down.type = 'button'; down.setAttribute('aria-label', 'Kurang pas');
  down.addEventListener('click', () => { downPending = true; renderNote(); });
  body.appendChild(up);
  body.appendChild(down);
  clearTimer();
  hideTimer = setTimeout(hide, ASK_MS);
}

// Show the ask (called by app.js's idle-detector once edit activity settles).
export function showEditFeedback() {
  try {
    injectStyleOnce();
    if (!root) buildRoot();
    finish();
    downPending = false; resolved = false;
    renderAsk();
    requestAnimationFrame(() => { if (root) root.classList.add('show'); });
  } catch { /* the pill must NEVER break the editor */ }
}

// Dismiss a shown pill because the user resumed editing (records an open 👎).
export function dismissEditFeedback() {
  try { finish(); } catch { /* never throws */ }
}
