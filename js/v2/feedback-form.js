/*
 * PDFLokal — v2/feedback-form.js  (the GENERAL feedback channel)
 * ============================================================================
 * A passive, always-available way for ANY user to say something — opened from
 * the landing footer's "Ada masukan?" link, never prompted, never timed.
 *
 * WHY THIS EXISTS: until now the only person who could speak to us was someone
 * who used Edit Teks Asli — roughly 109 sessions a week out of ~1300. The
 * ~800/week who open a file, compress or convert it and leave satisfied had no
 * channel at all. This is that channel.
 *
 * ⚠️ WHY THIS IS A SEPARATE MODULE AND NOT A SECOND ENTRY POINT INTO
 * edit-feedback.js — read this before "simplifying" the two together.
 * edit-feedback.js carries the consent-gated crop path: it attaches before/after
 * crops of an edited line, produced by OUR code from the user's document, under
 * privacy invariants its own header calls non-negotiable. Adding a second door
 * into that module is how a sample ends up on a path nobody audited — not
 * because someone decided to send content, but because two callers shared a
 * state machine that only one of them was reasoned about. That still stands:
 * this module never passes a `sample`, and never will.
 *
 * ⚠️ THE OLD INVARIANT HERE WAS "no code path can reach an image, because there
 * is no code here that knows images exist." HE RETIRED IT ON 2026-09-09 — the
 * form now accepts ONE PASTED SCREENSHOT. It is written out rather than quietly
 * deleted, because the replacement is narrower than it looks and the difference
 * is the whole defence:
 *
 *   THE ONLY IMAGE THAT CAN EXIST HERE IS ONE THE USER PASTED, DELIBERATELY,
 *   INTO THIS TEXTAREA. Nothing in this module reads the editor, the canvas,
 *   the document, or the clipboard unprompted. There is no attach button by his
 *   own ruling ("gausah ada tombolnya"), and there must never be an "attach the
 *   current page" convenience — that would turn a deliberate act into a default
 *   and take the product's "no uploads" claim with it.
 *
 * The paste is shown BACK before it can be sent (#fb-shot), because a
 * screenshot the sender never saw is a screenshot they did not really choose.
 * Validation is core/feedback-shot.js — its own module, deliberately not
 * core/feedback-sample.js: a matched PNG crop pair at 40KB and one user-chosen
 * JPEG at 200KB are different objects, and one validator holding the union of
 * both rules enforces neither.
 *
 * ONE SCREEN, per ojan-ui-taste ("one viewport = one reading + one action"):
 * the rating and the note are shown together, not as two steps. The user got
 * here by CLICKING a feedback link, so they already arrived intending to speak
 * — hiding the text box behind a thumb would add a step to someone who has
 * already declared their intent. Kirim stays disabled until a rating is picked,
 * because the table's `rating` column is a NOT NULL check-constrained enum
 * (up|down) and a note with no rating cannot be stored.
 *
 * COPY: ratified by the founder 2026-08-03, string by string, and it lives in
 * index.html rather than here. He kept four as drafted and rewrote two in his
 * own words. Do not tidy his lowercase or his spelling of "terimakasih" — they
 * are his. Any change to a user-visible word here needs him again.
 */
import { feedback } from './telemetry.js';
import { SHOT_MAX_DIM, SHOT_DATA_URL_PREFIX, validateShot } from '../core/feedback-shot.js';

const NOTE_MAX = 500;

let dlg = null;
let rating = null;
let shot = null;        // the pasted screenshot, as a validated data URL
let shotEl = null;
let shotImg = null;
let noteEl = null;
let sendEl = null;
let thumbUp = null;
let thumbDown = null;

function setRating(next) {
  rating = next;
  // aria-pressed IS the state, not a class — a screen reader user gets the same
  // information a sighted one does, and the CSS keys off the same attribute so
  // the two can never disagree.
  if (thumbUp) thumbUp.setAttribute('aria-pressed', String(next === 'up'));
  if (thumbDown) thumbDown.setAttribute('aria-pressed', String(next === 'down'));
  if (sendEl) sendEl.disabled = !next;
}

function clearShot() {
  shot = null;
  if (shotImg) shotImg.removeAttribute('src');
  if (shotEl) shotEl.hidden = true;
}

function reset() {
  rating = null;
  if (noteEl) noteEl.value = '';
  // THE IMAGE IS CLEARED ON EVERY OPEN, not only on send. A screenshot pasted,
  // then dismissed with Batal, must not be sitting there attached the next time
  // the dialog opens — the user would be re-consenting to something they had
  // already backed out of, without being asked again.
  clearShot();
  setRating(null);
  const body = dlg && dlg.querySelector('.fb-body');
  const done = dlg && dlg.querySelector('.fb-done');
  if (body) body.hidden = false;
  if (done) done.hidden = true;
}

// A pasted image → a small JPEG data URL, or null. Never throws: a paste that
// cannot be decoded is simply not an attachment, and the note still sends.
//
// RE-ENCODED, ALWAYS, EVEN WHEN THE ORIGINAL WOULD FIT. Two reasons and both
// matter: a screenshot pasted from a phone is often several megapixels, and a
// canvas round-trip DROPS EVERY METADATA BLOCK the source carried — EXIF,
// timestamps, and on some platforms the GPS a screenshot tool wrote in. We are
// asking for a picture of our own UI, not for where the user was standing.
async function toShot(blob) {
  try {
    const bitmap = await window.createImageBitmap(blob);
    const scale = Math.min(1, SHOT_MAX_DIM / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    // One retry at a lower quality, then give up. A loop chasing the cap would
    // spend a phone's battery on an attachment nobody promised to send.
    for (const q of [0.65, 0.45]) {
      const url = canvas.toDataURL('image/jpeg', q);
      if (url.startsWith(SHOT_DATA_URL_PREFIX) && validateShot(url)) return url;
    }
    return null;
  } catch {
    return null;
  }
}

function onPaste(e) {
  const items = [...(e.clipboardData?.items || [])];
  const item = items.find((i) => i.kind === 'file' && i.type.startsWith('image/'));
  if (!item) return;                          // pasting TEXT stays ordinary paste
  const blob = item.getAsFile();
  if (!blob) return;
  e.preventDefault();                         // stop the browser dropping a filename in the note
  toShot(blob).then((url) => {
    if (!url) return;                         // too big even at 0.45, or undecodable — silently no attachment
    shot = url;
    if (shotImg) shotImg.src = url;
    if (shotEl) shotEl.hidden = false;
  });
}

function send() {
  if (!rating) return;                       // guard: the button is disabled, but never trust the view
  const note = noteEl ? noteEl.value : '';
  // `sample` is ALWAYS null from here — the crop pair belongs to
  // edit-feedback.js and this module has never owned one. `shot` is the pasted
  // screenshot, and it is the only image this file can produce.
  feedback(rating, note, null, shot);
  const body = dlg.querySelector('.fb-body');
  const done = dlg.querySelector('.fb-done');
  if (body) body.hidden = true;
  if (done) done.hidden = false;
  // Let them read the thanks, then close. Short enough not to trap anyone, and
  // the dialog stays dismissible throughout.
  setTimeout(() => { if (dlg && dlg.open) dlg.close(); }, 1400);
}

export function initFeedbackForm() {
  dlg = document.getElementById('fb-form');
  const open = document.getElementById('fb-open');
  // TWO DOORS, ONE DIALOG (2026-09-09). The footer link and the floating tab
  // both land here. Deliberately not two implementations: the tab was wired in
  // app.js while it opened its own panel, and leaving it there would have meant
  // two modules owning one surface — the exact shape this file's own header
  // warns about for the image path.
  const tab = document.getElementById('contact-tab-btn');
  if (!dlg || !open) return;                 // SEO pages that drop the footer simply have no channel

  noteEl = dlg.querySelector('#fb-note');
  sendEl = dlg.querySelector('#fb-send');
  thumbUp = dlg.querySelector('#fb-up');
  thumbDown = dlg.querySelector('#fb-down');

  open.addEventListener('click', (e) => {
    e.preventDefault();                      // it is an <a> for keyboard/semantics, not a navigation
    reset();
    dlg.showModal();
  });
  // Same act, same dialog, same telemetry — so the tab reuses the link's own
  // handler rather than getting a parallel one that can drift from it.
  if (tab) tab.addEventListener('click', (e) => { e.preventDefault(); open.click(); });

  if (thumbUp) thumbUp.addEventListener('click', () => setRating('up'));
  if (thumbDown) thumbDown.addEventListener('click', () => setRating('down'));
  if (sendEl) sendEl.addEventListener('click', send);

  const cancel = dlg.querySelector('#fb-cancel');
  if (cancel) cancel.addEventListener('click', () => dlg.close());

  if (noteEl) noteEl.setAttribute('maxlength', String(NOTE_MAX));

  shotEl = dlg.querySelector('#fb-shot');
  shotImg = dlg.querySelector('#fb-shot-img');
  const shotClear = dlg.querySelector('#fb-shot-clear');
  if (noteEl) noteEl.addEventListener('paste', onPaste);
  if (shotClear) shotClear.addEventListener('click', clearShot);

  // Clicking the backdrop closes. The global `dialog` rule IS the overlay, so
  // the backdrop is the dialog element itself and anything inside .sheet is a
  // child — a click landing on the dialog and not the sheet is a click outside.
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}
