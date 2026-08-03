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
 * edit-feedback.js carries the consent-gated image path: it can attach
 * before/after crops of an edited line, under privacy invariants its own header
 * calls non-negotiable. The seat's decisions.md names content-blindness as the
 * ONE failure class that cannot be walked back: a document string that leaves a
 * device is out, permanently. Adding a second door into that module is exactly
 * how a sample ends up on a path nobody audited — not because someone decided
 * to send content, but because two callers shared a state machine that only one
 * of them was reasoned about.
 *
 * So: this module NEVER passes a sample argument. It calls feedback(rating,
 * note) with two arguments, always. There is no code path here that can reach
 * an image, because there is no code here that knows images exist.
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

const NOTE_MAX = 500;

let dlg = null;
let rating = null;
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

function reset() {
  rating = null;
  if (noteEl) noteEl.value = '';
  setRating(null);
  const body = dlg && dlg.querySelector('.fb-body');
  const done = dlg && dlg.querySelector('.fb-done');
  if (body) body.hidden = false;
  if (done) done.hidden = true;
}

function send() {
  if (!rating) return;                       // guard: the button is disabled, but never trust the view
  const note = noteEl ? noteEl.value : '';
  feedback(rating, note);                    // TWO ARGUMENTS. Never a third. See the header.
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

  if (thumbUp) thumbUp.addEventListener('click', () => setRating('up'));
  if (thumbDown) thumbDown.addEventListener('click', () => setRating('down'));
  if (sendEl) sendEl.addEventListener('click', send);

  const cancel = dlg.querySelector('#fb-cancel');
  if (cancel) cancel.addEventListener('click', () => dlg.close());

  if (noteEl) noteEl.setAttribute('maxlength', String(NOTE_MAX));

  // Clicking the backdrop closes. The global `dialog` rule IS the overlay, so
  // the backdrop is the dialog element itself and anything inside .sheet is a
  // child — a click landing on the dialog and not the sheet is a click outside.
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
}
