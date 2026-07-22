/*
 * PDFLokal — v2/edit-feedback.js  (BETA edit-feedback pill — founder ruling 2026-07-22)
 * ============================================================================
 * "Ship the per-line editor as beta, ask a thumbs up/down after every use, and
 * let telemetry do the rest of our work." This is that ask: a quiet, non-
 * blocking pill that appears after a successful Edit commit — 👍 / 👎, and a 👎
 * opens a short free-text box. It feeds js/v2/telemetry.js's feedback() (its
 * own endpoint + table; never the string-free events rail — see there).
 *
 * WHY a self-contained module (styles injected here, not markup in index.html
 * like install-prompt/format-bar): this is a PROVISIONAL beta instrument. Keeping
 * the whole feature — DOM, CSS, wiring — in one file makes it trivial to tune
 * from the phone gate or lift out entirely when the beta ends, without touching
 * index.html or re-running the SEO generator. The one deviation from the house
 * markup-in-HTML convention is deliberate and scoped to this experiment.
 *
 * Taste (ojan-ui-taste): QUIET — one small pill, never covers the page or blocks
 * the next edit; the EDIT was the loud event, this ask is calm chrome (salience
 * budget). Auto-vanishes if ignored (ignoring is a valid non-answer). A new edit
 * dismisses a lingering pill, so a power-edit streak never stacks pills.
 */
import { feedback } from './telemetry.js';

const ASK_MS = 7000; // ignored ask → vanish, no vote recorded
const NOTE_MS = 25000; // ignored open note box → record the 👎 without a note
const NOTE_MAXLEN = 500; // input maxlength; telemetry.js + api cap harder (1000)

let root = null; // the pill element (built once, reused)
let body = null; // its inner content holder (re-rendered per state)
let hideTimer = null;
let downPending = false; // 👎 tapped, note not yet resolved
let resolved = false; // this cycle's rating already sent — never double-send

function injectStyleOnce() {
  if (document.getElementById('edit-feedback-style')) return;
  const style = document.createElement('style');
  style.id = 'edit-feedback-style';
  // Uses the app's own brand tokens (index.html :root) so it matches without
  // duplicating colors. Light-only, like the rest of v2.
  style.textContent = `
    #edit-feedback {
      position: fixed; left: 50%; bottom: calc(env(safe-area-inset-bottom, 0px) + 74px);
      transform: translate(-50%, 8px); z-index: 60;
      display: flex; align-items: center; gap: 10px;
      max-width: min(92vw, 420px);
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
      width: 40px; height: 34px; font-size: 18px; line-height: 1; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      transition: transform .1s ease, background .1s ease;
    }
    #edit-feedback .ef-thumb:hover { background: #eae4dc; }
    #edit-feedback .ef-thumb:active { transform: scale(.92); }
    #edit-feedback .ef-note {
      flex: 1 1 auto; min-width: 0; padding: 7px 9px; font: inherit;
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
    #edit-feedback .ef-skip {
      appearance: none; border: 0; background: none; cursor: pointer;
      color: var(--muted, #79716b); font: inherit; text-decoration: underline; padding: 4px;
    }
    @media (prefers-reduced-motion: reduce) {
      #edit-feedback { transition: opacity .18s ease; transform: translate(-50%, 0); }
      #edit-feedback.show { transform: translate(-50%, 0); }
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

function clearTimer() {
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
}

function hide() {
  clearTimer();
  if (root) root.classList.remove('show');
}

// Close the pill. If a 👎 was left open (note box shown, never Kirim/Lewati),
// record it note-less exactly once — the down itself must not be lost just
// because the user didn't elaborate.
function finish() {
  if (downPending && !resolved) { resolved = true; try { feedback('down'); } catch { /* never throws */ } }
  hide();
}

function clear() { while (body.firstChild) body.removeChild(body.firstChild); }

function makeThumb(emoji, label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ef-thumb';
  b.textContent = emoji;
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}

function renderThanks() {
  clear();
  const q = document.createElement('span');
  q.className = 'ef-q';
  q.textContent = 'Makasih — ini ngebantu kami 🙏';
  body.appendChild(q);
  clearTimer();
  hideTimer = setTimeout(hide, 1700);
}

function renderNote() {
  clear();
  const q = document.createElement('span');
  q.className = 'ef-q';
  q.textContent = 'Apa yang kurang pas?';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ef-note';
  input.maxLength = NOTE_MAXLEN;
  input.placeholder = 'boleh kosong…';
  input.setAttribute('aria-label', 'Ceritakan apa yang kurang pas (opsional)');

  const send = document.createElement('button');
  send.type = 'button';
  send.className = 'ef-send';
  send.textContent = 'Kirim';
  const submit = () => {
    if (resolved) return;
    resolved = true;
    try { feedback('down', input.value); } catch { /* never throws */ }
    renderThanks();
  };
  send.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    e.stopPropagation(); // don't trigger app shortcuts while typing
  });

  const skip = document.createElement('button');
  skip.type = 'button';
  skip.className = 'ef-skip';
  skip.textContent = 'Lewati';
  skip.addEventListener('click', finish); // records the down note-less

  body.appendChild(q);
  body.appendChild(input);
  body.appendChild(send);
  body.appendChild(skip);
  input.focus();

  // Generous backstop: an abandoned note box still records the 👎 note-less.
  clearTimer();
  hideTimer = setTimeout(finish, NOTE_MS);
}

function renderAsk() {
  clear();
  const q = document.createElement('span');
  q.className = 'ef-q';
  q.textContent = 'Hasil editnya oke?';
  const up = makeThumb('👍', 'Bagus', () => {
    if (resolved) return;
    resolved = true;
    try { feedback('up'); } catch { /* never throws */ }
    renderThanks();
  });
  const down = makeThumb('👎', 'Kurang pas', () => {
    downPending = true;
    renderNote();
  });
  body.appendChild(q);
  body.appendChild(up);
  body.appendChild(down);
  clearTimer();
  hideTimer = setTimeout(hide, ASK_MS); // ignored ask → vanish, no vote
}

// Show the pill after a successful Edit commit. Resets any in-flight cycle
// (a new edit supersedes a lingering ask), then asks fresh.
export function showEditFeedback() {
  try {
    injectStyleOnce();
    if (!root) buildRoot();
    finish(); // resolve/close any prior cycle before starting a new one
    downPending = false;
    resolved = false;
    renderAsk();
    // rAF so the .show transition actually animates from the reset state.
    requestAnimationFrame(() => { if (root) root.classList.add('show'); });
  } catch {
    // The feedback pill must NEVER break the editor.
  }
}

// Dismiss a lingering pill because the user moved on (opened another edit).
// Treated like ignoring: closes, and records a still-open 👎 note-less.
export function dismissEditFeedback() {
  try { finish(); } catch { /* never throws */ }
}
