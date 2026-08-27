/*
 * PDFLokal — v2/edit-feedback.js  (BETA edit-feedback — founder ruling 2026-07-22;
 * Increment D — consent-gated sample, founder ruling 2026-07-27)
 * ============================================================================
 * "Ship the per-line editor as beta, ask 👍/👎, let telemetry do the rest."
 * WHEN to ask, refined twice by the founder the same day:
 *   1. NOT after every commit (naggy for a 20-line session).
 *   2. NOT in the download sheet either ("to put it here is wrong").
 *   3. → ask ONCE, on the FIRST successful commit of a document. The
 *      idle-detector that used to gate this is gone (2026-07-22 late ruling,
 *      "bollocks, buggy" — see decisions.md); js/v2/app.js calls
 *      showEditFeedback() directly off its own commit path.
 *
 * A floating pill (bottom-center), quiet per ojan-ui-taste: one small ask, never
 * covers the page, auto-vanishes if ignored. 👎 opens a short note whose
 * placeholder ASKS for detail ("isi feedback biar kita bisa improve") rather
 * than waving it off as optional. An abandoned 👎 is still recorded note-less.
 * Feeds telemetry.js feedback() (its own endpoint + table; never the events rail).
 *
 * INCREMENT D (spec-edit-fidelity-instrumentation.md): once the user is in the
 * 👎 note step, IF js/v2/app.js has captured a before/after sample of the
 * edited line (setFeedbackSample() below — called off the commit path, may
 * arrive after the note is already open), the note view grows an ask block
 * with the founder's own verbatim copy + the two crops RENDERED so the user
 * sees exactly what would send, before Kirim exists as an option. Privacy
 * invariants (decisions.md 2026-07-23/2026-07-27, non-negotiable):
 *   - nothing captured/sent unless 👎 THEN Kirim — 👍, "Nggak usah",
 *     abandoning, or closing all resolve with rating(+note) and NO images;
 *   - the crops are whatever js/v2/app.js already captured (that module's own
 *     job is bounding them to the edited line's own box) — this module never
 *     crops, resizes, or re-derives anything, only displays + forwards;
 *   - the stashed sample is freed (pendingSample = null) the instant this
 *     round resolves ANY way, and again at the start of the next round —
 *     never held across edits.
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
let pendingSample = null; // {before, after} PNG data URLs, or null — Increment D
let noteInputEl = null;   // live reference so setFeedbackSample() can re-render
let bottomEl = null;      // just the button/ask area without losing typed note text

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
    /* ---- note step layout: label+input row, then a bottom area that's
       either a lone Kirim (no sample) or the Increment D ask block ---- */
    #edit-feedback .ef-notewrap { display: flex; flex-direction: column; gap: 8px; width: 100%; }
    #edit-feedback .ef-row { display: flex; align-items: center; gap: 10px; }
    #edit-feedback .ef-bottom { display: flex; flex-direction: column; gap: 8px; }
    #edit-feedback .ef-bottom > .ef-send { align-self: flex-end; }
    #edit-feedback .ef-ask-q { font-weight: 600; }
    #edit-feedback .ef-ask-sub { color: var(--muted, #79716b); font-size: 12px; line-height: 1.4; }
    #edit-feedback .ef-crops { display: flex; flex-direction: column; gap: 6px; }
    #edit-feedback .ef-crop-item { display: flex; align-items: center; gap: 8px; }
    #edit-feedback .ef-crop-label {
      font-size: 11px; color: var(--muted, #79716b); width: 38px; flex: none; letter-spacing: .02em;
    }
    #edit-feedback .ef-crop-img {
      max-width: 100%; max-height: 44px; display: block; background: #fff;
      border: 1px solid var(--line, rgba(63,49,35,.12)); border-radius: 6px;
    }
    #edit-feedback .ef-btnrow { display: flex; gap: 8px; justify-content: flex-end; }
    #edit-feedback .ef-skip {
      appearance: none; cursor: pointer; white-space: nowrap; font: inherit;
      background: var(--bg, #f1ede7); color: var(--ink, #211d1a);
      border: 1px solid var(--line, rgba(63,49,35,.12));
      padding: 8px 12px; border-radius: 8px;
    }
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

// Increment D memory hygiene: drop the stashed crops. Called on every path
// that ends a round (resolved either way, abandoned, or a fresh round
// starting) so a sample never survives past the 👎 it was captured for.
function freeSample() { pendingSample = null; noteInputEl = null; bottomEl = null; }

// Close the pill; a still-open 👎 is recorded note-less exactly once.
function finish() {
  if (downPending && !resolved) { resolved = true; try { feedback('down'); } catch { /* never throws */ } }
  freeSample();
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
  body.appendChild(el('span', 'ef-q', 'Makasih, masukanmu ngebantu saya 🙏'));
  clearTimer();
  hideTimer = setTimeout(hide, 1700);
}

// The one place a 👎 actually leaves this module — 'up' never touches this.
// withSample only ever carries pendingSample through when the user tapped
// the Kirim that was rendered ALONGSIDE the visible crops (renderBottom());
// 'Nggak usah' and the plain no-sample Kirim both call this with `false`.
function submitDown(withSample) {
  if (resolved) return;
  resolved = true; downPending = false;
  const note = noteInputEl ? noteInputEl.value : '';
  const sample = withSample && pendingSample ? pendingSample : undefined;
  try { feedback('down', note, sample); } catch { /* never throws */ }
  freeSample();
  renderThanks();
}

function cropRow(label, dataUrl) {
  const row = el('div', 'ef-crop-item');
  row.appendChild(el('span', 'ef-crop-label', label));
  const img = document.createElement('img');
  img.className = 'ef-crop-img';
  img.src = dataUrl;
  img.alt = label;
  row.appendChild(img);
  return row;
}

// Renders just the bottom area of the note step — either today's lone Kirim
// (no sample offered/ready yet) or the Increment D ask block with both crops
// already rendered and a Kirim/Nggak usah pair. Re-callable in place (from
// setFeedbackSample()) without touching the note input above it, so a
// sample arriving AFTER the note is already open never loses what the user
// typed.
function renderBottom() {
  if (!bottomEl) return;
  while (bottomEl.firstChild) bottomEl.removeChild(bottomEl.firstChild);
  if (pendingSample) {
    // Founder's copy, VERBATIM — do not improve it (spec-edit-fidelity-
    // instrumentation.md Increment D, decisions.md 2026-07-27).
    bottomEl.appendChild(el('div', 'ef-ask-q', 'Boleh saya minta dua potongan ini?'));
    bottomEl.appendChild(el('div', 'ef-ask-sub',
      'Sebelum dan sesudahnya, biar saya bisa analisis fiturnya kurang di mana. Nggak ada isi file lain.'));
    const crops = el('div', 'ef-crops');
    crops.appendChild(cropRow('Asli', pendingSample.before));
    crops.appendChild(cropRow('Hasil', pendingSample.after));
    bottomEl.appendChild(crops);
    const btns = el('div', 'ef-btnrow');
    const skip = el('button', 'ef-skip', 'Nggak usah');
    skip.type = 'button';
    skip.addEventListener('click', () => submitDown(false));
    const send = el('button', 'ef-send', 'Kirim');
    send.type = 'button';
    send.addEventListener('click', () => submitDown(true));
    btns.appendChild(skip);
    btns.appendChild(send);
    bottomEl.appendChild(btns);
  } else {
    const send = el('button', 'ef-send', 'Kirim');
    send.type = 'button';
    send.addEventListener('click', () => submitDown(false));
    bottomEl.appendChild(send);
  }
}

function renderNote() {
  clear();
  const wrap = el('div', 'ef-notewrap');
  const row = el('div', 'ef-row');
  row.appendChild(el('span', 'ef-q', 'Apa yang kurang pas?'));
  const input = el('input', 'ef-note');
  input.type = 'text';
  input.maxLength = NOTE_MAXLEN;
  // Founder ruling 2026-07-22: the placeholder ASKS for the detail, not "boleh
  // kosong" — we want the reason, and telemetry only works if the signal comes.
  input.placeholder = 'isi feedback biar kita bisa improve';
  input.setAttribute('aria-label', 'Ceritakan apa yang kurang pas');
  row.appendChild(input);
  wrap.appendChild(row);

  const bottom = el('div', 'ef-bottom');
  wrap.appendChild(bottom);
  body.appendChild(wrap);

  noteInputEl = input;
  bottomEl = bottom;
  renderBottom(); // reads whatever pendingSample already holds (often none yet)

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitDown(!!pendingSample); }
    e.stopPropagation();
  });
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
    freeSample(); // Increment D: 👍 never offers/sends a sample — nothing to keep
    renderThanks();
  });
  const down = el('button', 'ef-thumb', '👎');
  down.type = 'button'; down.setAttribute('aria-label', 'Kurang pas');
  down.addEventListener('click', () => { downPending = true; renderNote(); });
  body.appendChild(up);
  body.appendChild(down);
  clearTimer();
  hideTimer = setTimeout(() => { freeSample(); hide(); }, ASK_MS);
}

// Show the ask (called by js/v2/app.js on the first successful commit).
export function showEditFeedback() {
  try {
    injectStyleOnce();
    if (!root) buildRoot();
    finish();
    downPending = false; resolved = false;
    freeSample(); // a fresh round never inherits a stale sample
    renderAsk();
    requestAnimationFrame(() => { if (root) root.classList.add('show'); });
  } catch { /* the pill must NEVER break the editor */ }
}

// Dismiss a shown pill because the user resumed editing (records an open 👎).
export function dismissEditFeedback() {
  try { finish(); } catch { /* never throws */ }
}

// Increment D: js/v2/app.js calls this once it has captured (or declined to
// capture) the before/after crop for THIS round's edit, off the commit path
// (requestIdleCallback — never competes with the commit paint). May land
// before OR after the user has already reached the note step; either way,
// a no-op once this round has resolved (an impatient 👍/Nggak usah/abandon
// already happened) — the sample would have nowhere honest to go.
export function setFeedbackSample(sample) {
  try {
    if (resolved) return;
    pendingSample = sample || null;
    if (downPending) renderBottom(); // update in place; typed note text is untouched
  } catch { /* the pill must NEVER break the editor */ }
}
