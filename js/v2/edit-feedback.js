/*
 * PDFLokal — v2/edit-feedback.js  (BETA edit-feedback — founder ruling 2026-07-22)
 * ============================================================================
 * "Ship the per-line editor as beta, ask a thumbs up/down, and let telemetry
 * do the rest of our work." WHEN to ask, refined by the founder the same day:
 * NOT after every commit (too naggy for a 20-line edit session) — instead once,
 * at the DOWNLOAD moment, "before they choose output format." So this renders a
 * quiet strip at the TOP of the Unduh sheet (js/v2/download-sheet.js), shown
 * only when the doc actually carries an Edit. It feeds js/v2/telemetry.js's
 * feedback() (its own endpoint + table; never the string-free events rail).
 *
 * Taste (ojan-ui-taste): QUIET — the format choice is the primary action here;
 * this is calm chrome above it, muted question + small thumbs, never a gate.
 * 👎 opens a short optional note; an un-submitted 👎 is still recorded note-less
 * when the sheet closes (finalize()), so a dissatisfied user is never lost.
 */
import { feedback } from './telemetry.js';

const NOTE_MAXLEN = 500;

function injectStyleOnce() {
  if (document.getElementById('edit-feedback-style')) return;
  const style = document.createElement('style');
  style.id = 'edit-feedback-style';
  // Scoped to the strip's host inside the sheet. Uses the app's brand tokens
  // (index.html :root) so it matches without duplicating colors. Light-only.
  style.textContent = `
    .ds-feedback {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      padding: 10px 12px; margin-bottom: 4px; border-radius: 11px;
      background: var(--bg, #f1ede7); border: 1px solid var(--line, rgba(63,49,35,.12));
    }
    .ds-feedback .ef-q { color: var(--muted, #79716b); font-size: 14px; }
    .ds-feedback .ef-thumb {
      appearance: none; border: 1px solid var(--line, rgba(63,49,35,.12));
      background: var(--surface, #fff); border-radius: 9px;
      width: 42px; height: 34px; font-size: 18px; line-height: 1; cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      transition: transform .1s ease, background .1s ease;
    }
    .ds-feedback .ef-thumb:hover { background: #eae4dc; }
    .ds-feedback .ef-thumb:active { transform: scale(.92); }
    .ds-feedback .ef-note {
      flex: 1 1 140px; min-width: 0; padding: 8px 10px; font: inherit; font-size: 14px;
      border: 1px solid var(--line, rgba(63,49,35,.12)); border-radius: 8px;
      background: var(--surface, #fff); color: var(--ink, #211d1a);
    }
    .ds-feedback .ef-note:focus { outline: 2px solid var(--accent, #dc2626); outline-offset: 0; }
    .ds-feedback .ef-send {
      appearance: none; border: 0; cursor: pointer; white-space: nowrap;
      background: var(--accent, #dc2626); color: #fff; font: inherit; font-size: 14px; font-weight: 600;
      padding: 8px 14px; border-radius: 8px;
    }
    .ds-feedback .ef-send:active { background: var(--accent-down, #b91c1c); }
  `;
  document.head.appendChild(style);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/**
 * Render the feedback flow into `host` (a strip inside the download sheet).
 * Fresh each call (host is emptied). Returns { finalize } — the sheet calls
 * finalize() on close so an un-submitted 👎 is still recorded note-less.
 * @param {HTMLElement} host
 */
export function renderEditFeedback(host) {
  injectStyleOnce();
  let sent = false; // this render's rating already went out — never double-send
  let downPending = false; // 👎 tapped, note not yet submitted

  const clear = () => { while (host.firstChild) host.removeChild(host.firstChild); };

  function thanks() {
    clear();
    host.appendChild(el('span', 'ef-q', 'Makasih — masukanmu ngebantu kami 🙏'));
  }

  function note() {
    clear();
    host.appendChild(el('span', 'ef-q', 'Apa yang kurang pas?'));
    const input = el('input', 'ef-note');
    input.type = 'text';
    input.maxLength = NOTE_MAXLEN;
    input.placeholder = 'boleh kosong…';
    input.setAttribute('aria-label', 'Ceritakan apa yang kurang pas (opsional)');
    const send = el('button', 'ef-send', 'Kirim');
    send.type = 'button';
    const submit = () => {
      if (sent) return;
      sent = true; downPending = false;
      try { feedback('down', input.value); } catch { /* never throws */ }
      thanks();
    };
    send.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      e.stopPropagation(); // don't trigger app shortcuts while typing
    });
    host.appendChild(input);
    host.appendChild(send);
    input.focus();
  }

  function ask() {
    clear();
    host.appendChild(el('span', 'ef-q', 'Gimana hasil editnya?'));
    const up = el('button', 'ef-thumb', '👍');
    up.type = 'button';
    up.setAttribute('aria-label', 'Bagus');
    up.addEventListener('click', () => {
      if (sent) return;
      sent = true;
      try { feedback('up'); } catch { /* never throws */ }
      thanks();
    });
    const down = el('button', 'ef-thumb', '👎');
    down.type = 'button';
    down.setAttribute('aria-label', 'Kurang pas');
    down.addEventListener('click', () => { downPending = true; note(); });
    host.appendChild(up);
    host.appendChild(down);
  }

  ask();

  return {
    // Called when the sheet closes: a 👎 that opened the note box but was never
    // submitted is still recorded (note-less) — the dissatisfaction is the
    // signal; losing it because they didn't elaborate would defeat the loop.
    finalize() {
      if (downPending && !sent) {
        sent = true;
        try { feedback('down'); } catch { /* never throws */ }
      }
    },
  };
}
