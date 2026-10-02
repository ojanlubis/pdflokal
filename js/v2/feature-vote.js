/*
 * PDFLokal — v2/feature-vote.js  (the feature vote card: "Fitur apa yang paling kamu butuh?")
 * ============================================================================
 * Founder ruling 2026-10-02: users vote on the planned features (at most 3) and
 * may write an idea of their own; we build everything, and the RELEASE order
 * follows the vote. The list and the rules are js/core/features.js; the card is
 * #fv-form in index.html (its labels are its checkboxes' text, so rewording one
 * changes no stored data).
 *
 * TWO DOORS, ONE DIALOG:
 *   - AUTO: once, after the user's SECOND successful download, in a session where
 *     the share/tip card did not already speak (celebrate.js asks us, and gives
 *     the moment to us instead of the share card when we take it). A vote or a
 *     dismiss closes this door for good.
 *   - MENU: "Usulkan fitur", in the desktop nav and the mobile drawer
 *     ([data-feature-vote-open]), always there. After a vote it opens straight on
 *     the result, not on a fresh form: one browser, one ballot (the server dedupes
 *     per visitor as well, api/votes.js, because this memory is a convenience).
 *
 * WHAT GOES WHERE:
 *   - the vote  -> the rail, `feature_vote` {features:[ids], has_text} (typed, ids
 *     only: js/core/telemetry-schema.js), via tel().
 *   - the idea  -> api/feedback.js as kind 'feature_request' with the voted ids,
 *     into the feedback database, never the rail (telemetry.featureRequest).
 *   - the top 3 -> GET /api/votes (aggregate only). If it fails, or too few have
 *     voted, the card just says thanks.
 * Nothing here ever reads the document. A vote carries ids and a bool.
 *
 * STORAGE (both rows are in privasi.html's #storage-ours):
 *   pdflokal_export_count  how many files this browser has saved (capped)
 *   pdflokal_vote_done     'voted' | 'dismissed'
 *
 * DEFENSIVE BY DESIGN: this module is on every generated SEO page and in the
 * stale-shell-beside-fresh-JS combination the service worker can produce (sw.js:
 * JAVASCRIPT-V/J). A missing element degrades to "no card", never to a throw at
 * module top level; and telemetry.featureRequest is reached through a namespace
 * import so an older cached telemetry.js without it cannot break the import graph.
 */

import { tel } from './telemetry.js';
import * as telemetry from './telemetry.js';
import { t as tr } from '../lib/i18n.js';
import {
  FEATURES, MAX_VOTES, IDEA_MAX, cleanVote, shouldOfferVote,
} from '../core/features.js';

const COUNT_KEY = 'pdflokal_export_count';
const DONE_KEY = 'pdflokal_vote_done';
const COUNT_CAP = 99; // we only ever ask "is it at least 2"; never an unbounded counter

// The BERES stamp lands 1.2s after a download and lasts 3s (celebrate.js). A modal
// sheet opened over it would bury the one moment this product rewards, so the card
// waits for the stamp to clear.
export const SHOW_DELAY_MS = 4400;

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: it just asks again */ } }

// Pure: the top three FEATURE IDS from api/votes.js's counts, most first, ties in
// list order, zero-vote features never shown. [] when there is nothing to rank.
export function topThree(counts) {
  if (!counts || typeof counts !== 'object') return [];
  return FEATURES
    .map((f, i) => ({ id: f.id, n: Number(counts[f.id]), i }))
    .filter((f) => Number.isFinite(f.n) && f.n > 0)
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .slice(0, 3)
    .map((f) => f.id);
}

export function createFeatureVote() {
  const dlg = document.getElementById('fv-form');
  const noop = { countDownload() { return 0; }, maybeShow() { return false; }, open() {} };
  const list = dlg?.querySelector('.fv-list');
  const sendBtn = dlg?.querySelector('#fv-send');
  const ideaEl = dlg?.querySelector('#fv-idea');
  const countEl = dlg?.querySelector('#fv-count');
  const bodyEl = dlg?.querySelector('.fv-body');
  const doneEl = dlg?.querySelector('.fv-done');
  const headEl = dlg?.querySelector('.fv-done-head');
  const topEl = dlg?.querySelector('.fv-top');
  if (!dlg || !list || !sendBtn || !ideaEl || !countEl || !bodyEl || !doneEl || !headEl || !topEl) return noop;

  const boxes = () => [...list.querySelectorAll('input[type="checkbox"]')];
  const picked = () => boxes().filter((b) => b.checked).map((b) => b.value);
  const state = () => safeGet(DONE_KEY);
  let source = 'menu';           // who opened it: 'auto' (the download moment) or 'menu'
  let sent = false;
  let pending = false;           // an auto-open is waiting for its delay

  // The label of a feature IS its checkbox's text (see the header): read it from
  // there, so the result list can never say something the form did not.
  function labelOf(id) {
    const box = boxes().find((b) => b.value === id);
    return box?.closest('label')?.textContent.trim() || id;
  }

  function refresh() {
    const ids = picked();
    // MAX_VOTES enforced in the UI by disabling the rest, not by a message after
    // the fact: a disabled box is out of the tab order and announced as dimmed,
    // and the live count says why.
    for (const b of boxes()) b.disabled = !b.checked && ids.length >= MAX_VOTES;
    countEl.textContent = tr('featureVote.picked', { n: ids.length, max: MAX_VOTES });
    sendBtn.disabled = sent || (ids.length === 0 && ideaEl.value.trim() === '');
  }

  function showForm() {
    sent = false;
    for (const b of boxes()) { b.checked = false; b.disabled = false; }
    ideaEl.value = '';
    bodyEl.hidden = false;
    doneEl.hidden = true;
    refresh();
  }

  async function showDone() {
    bodyEl.hidden = true;
    doneEl.hidden = false;
    headEl.textContent = tr('featureVote.thanks');
    topEl.replaceChildren();
    topEl.hidden = true;
    headEl.focus();
    // "Most requested so far", from the rail. Any failure, or too few votes (the
    // endpoint answers {voters:null}), leaves the plain thanks standing.
    try {
      const r = await fetch('/api/votes', { credentials: 'omit' });
      if (!r.ok) return;
      const d = await r.json();
      const ids = topThree(d?.counts);
      if (!ids.length || !dlg.open) return;
      headEl.textContent = tr('featureVote.thanksTop');
      topEl.replaceChildren(...ids.map((id) => {
        const li = document.createElement('li'); // textContent, never innerHTML
        li.textContent = labelOf(id);
        return li;
      }));
      topEl.hidden = false;
    } catch { /* offline, blocked, or no endpoint: the thanks is already on screen */ }
  }

  function send() {
    const ids = picked();
    const text = ideaEl.value.trim().slice(0, IDEA_MAX);
    if (sent || (ids.length === 0 && !text) || !cleanVote(ids).ok) return;
    sent = true;
    tel('feature_vote', { features: ids, has_text: text !== '' });
    if (text) telemetry.featureRequest?.(ids, text);
    safeSet(DONE_KEY, 'voted');
    showDone();
  }

  function open(from) {
    source = from;
    if (state() === 'voted') { sent = true; showDone(); } else showForm();
    if (!dlg.open) dlg.showModal();
    if (state() !== 'voted') dlg.querySelector('.fv-title')?.focus();
  }

  // A close with no vote, from the auto door, is the user's answer: no.
  dlg.addEventListener('close', () => {
    if (source === 'auto' && !sent && state() !== 'voted') safeSet(DONE_KEY, 'dismissed');
    source = 'menu';
  });
  // The global `dialog` rule IS the overlay, so a click landing on the dialog
  // itself (not inside its .sheet) is a click outside.
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  for (const b of dlg.querySelectorAll('[data-fv-close]')) b.addEventListener('click', () => dlg.close());
  list.addEventListener('change', refresh);
  ideaEl.addEventListener('input', refresh);
  ideaEl.setAttribute('maxlength', String(IDEA_MAX));
  sendBtn.addEventListener('click', send);

  // The menu door: the nav link and the drawer link. Plain anchors so they read as
  // links to keyboard and screen reader alike; the click is the dialog's, not a jump.
  for (const a of document.querySelectorAll('[data-feature-vote-open]')) {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      // The mobile drawer sits above the page: shut it so the sheet is the only thing open.
      const drawer = document.getElementById('ld-burger-menu');
      if (drawer && !drawer.hidden) document.getElementById('ld-burger')?.click();
      open('menu');
    });
  }

  return {
    // Called by celebrate.js on EVERY successful download. Returns how many this
    // browser has now saved. Stops counting once the question is answered.
    countDownload() {
      if (state()) return 0;
      const n = Math.min(COUNT_CAP, (parseInt(safeGet(COUNT_KEY), 10) || 0) + 1);
      safeSet(COUNT_KEY, String(n));
      return n;
    },
    // Returns true when the card takes this download's moment, so celebrate.js
    // withholds the share/tip card from the rest of the session.
    maybeShow({ downloads, supportShownThisSession }) {
      if (pending || !shouldOfferVote({ downloads, state: state(), supportShownThisSession })) return false;
      pending = true;
      const fire = () => {
        pending = false;
        // Never over another dialog (the Unduh sheet closing, the feedback form):
        // skip silently and ask again on a later download rather than stack two.
        if (document.querySelector('dialog[open]')) return;
        open('auto');
      };
      const arm = () => setTimeout(fire, SHOW_DELAY_MS);
      // A download is exactly when Android hides the tab behind its own sheet; a
      // dialog opened into a hidden tab is a dialog nobody saw (see
      // bug-report-prompt.js, which learned this the hard way).
      if (document.hidden) {
        const onVisible = () => {
          if (document.hidden) return;
          document.removeEventListener('visibilitychange', onVisible);
          arm();
        };
        document.addEventListener('visibilitychange', onVisible);
      } else arm();
      return true;
    },
    open,
  };
}
