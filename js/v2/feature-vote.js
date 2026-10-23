/*
 * PDFLokal — v2/feature-vote.js  (the feature vote: an invitation from Ojan, then a checklist)
 * ============================================================================
 * Founder ruling 2026-10-02: users vote on the planned features (at most 3) and
 * may write an idea of their own; we build everything, and the RELEASE order
 * follows the vote. v1 (a chip grid, no face) was rejected the same night: "invite
 * them first, with words... and then show them the choices", with his face (design-
 * studio intake, pdflokal.md). This is v2 (2026-10-06). The list and the rules are
 * js/core/features.js; every word is featureVote.* in js/locales; the card is
 * #fv-form in index.html (a skeleton: this module fills it).
 *
 * ONE NATIVE <dialog>, CENTRED (the global `dialog` rule IS the overlay; never the
 * bottom-right corner, which is the maker card's, his ruling 2026-10-06), THREE STEPS:
 *   1. invite   his words, his photo with the top hat below them, "Pilih fitur" / "Nanti aja"
 *   2. choose   no photo; a real checkbox per option (at most 3), the idea box, "Kirim pilihan"
 *   3. done     his one thanks line (it also promises "dikabari di sini"), the top 3 (names only), the coffee ask, Tutup
 *
 * WHEN IT SHOWS (core/features.js shouldOfferVote, wired by celebrate.js): the
 * moment a whole-document download completes, and it REPLACES the share/coffee card
 * for that download (the coffee ask is step 3). After EVERY such download, until
 * "Nanti aja"; after that at most once a day; never after a vote; not without a
 * visitor_id. Never over another card or dialog: if one is up, the vote is simply not
 * offered for that download (and the share card behaves as it always did).
 * A close with no vote from this door, by any route (Escape, the x, a click outside),
 * is the same answer as "Nanti aja": a modal the person had to dismiss and that came
 * straight back on the next download would be a nag. The menu link
 * ([data-feature-vote-open]) opens it any time, straight to step 1 (or to step 3
 * once voted: one browser, one ballot; the server dedupes per visitor as well).
 * While it is open the maker card waits (maker-card.js).
 *
 * WHAT GOES WHERE:
 *   - the vote  -> the rail, `feature_vote` {features:[ids], has_text} (typed, ids
 *     only: js/core/telemetry-schema.js), via tel().
 *   - the idea  -> api/feedback.js as kind 'feature_request' with the voted ids,
 *     filed in feature_requests, never the rail and never `feedback`.
 *   - the top 3 -> GET /api/votes (aggregate only). If it fails, or too few have
 *     voted, the card just says thanks.
 *   - the coffee ask -> CLONED from #support-card (the share/coffee card's own
 *     words, button and QRIS), not rewritten: one component, one set of words.
 *     Seen/tap go to GA4 and Mixpanel (track) tagged surface:'vote'.
 * Nothing here ever reads the document. A vote carries ids and a bool.
 *
 * STORAGE: js/v2/vote-memory.js (all rows are in privasi.html's #storage-ours).
 *
 * DEFENSIVE BY DESIGN: this module is on every generated SEO page and in the
 * stale-shell-beside-fresh-JS combination the service worker can produce (sw.js:
 * JAVASCRIPT-V/J). A missing element degrades to "no card", never to a throw at
 * module top level; and telemetry.featureRequest is reached through a namespace
 * import so an older cached telemetry.js without it cannot break the import graph.
 */

import { tel } from './telemetry.js';
import * as telemetry from './telemetry.js';
import { track } from '../lib/analytics.js';
import { t as tr } from '../lib/i18n.js';
import {
  FEATURES, MAX_VOTES, IDEA_MAX, cleanVote, cleanIdea, shouldOfferVote, dayKey,
} from '../core/features.js';
import { isVoted, nantiDay, rememberNanti, rememberVote } from './vote-memory.js';

const SHEET_WAIT_MS = 600;

// Everything that is already on screen and must not share it with the vote: any
// open dialog (the Unduh sheet, the feedback form...) and the page's cards.
const OCCUPANTS = 'dialog[open]:not(#dl-sheet), #support-card.show, #install-card.show, #bug-prompt.show, #vote-card.show';

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

// The label of a feature: featureVote.labels is an array in FEATURES order (a key
// cannot be built from the id; lib/i18n.js).
export function labelOf(id) {
  const labels = tr('featureVote.labels');
  const i = FEATURES.findIndex((f) => f.id === id);
  return Array.isArray(labels) && labels[i] ? labels[i] : id;
}

export function createFeatureVote() {
  const dlg = document.getElementById('fv-form');
  const noop = { maybeShow() { return false; }, open() {} };
  const $ = (sel) => dlg?.querySelector(sel);
  const steps = { invite: $('[data-fv-step="invite"]'), choose: $('[data-fv-step="choose"]'), done: $('[data-fv-step="done"]') };
  const list = $('.fv-list');
  const sendBtn = $('#fv-send');
  const ideaEl = $('#fv-idea');
  const countEl = $('#fv-count');
  const errorEl = $('#fv-error');
  const inviteTitle = $('#fv-invite-title');
  const inviteText = $('#fv-invite-text');
  const titleEl = $('#fv-title');
  const doneHead = $('#fv-done-head');
  const topWrap = $('.fv-top-wrap');
  const topEl = $('.fv-top');
  const coffeeEl = $('.fv-coffee');
  if (!dlg || !steps.invite || !steps.choose || !steps.done || !list || !sendBtn || !ideaEl || !countEl
    || !errorEl || !inviteTitle || !inviteText || !titleEl || !doneHead || !topWrap || !topEl || !coffeeEl) return noop;

  // ---- the words (every string is a featureVote.* key; the call sites are literal) ----
  const setText = (sel, text) => { const el = $(sel); if (el) el.textContent = text; };
  inviteTitle.textContent = tr('featureVote.inviteTitle');
  inviteText.textContent = tr('featureVote.invite');
  setText('.fv-start', tr('featureVote.start'));
  for (const el of dlg.querySelectorAll('[data-fv-later]')) el.textContent = tr('featureVote.later');
  titleEl.textContent = tr('featureVote.title');
  setText('.fv-hint', tr('featureVote.hint'));
  setText('.fv-idea-label', tr('featureVote.idea'));
  sendBtn.textContent = tr('featureVote.send');
  doneHead.textContent = tr('featureVote.thanks');
  setText('.fv-top-label', tr('featureVote.top'));
  for (const el of dlg.querySelectorAll('[data-fv-close]')) {
    if (el.matches('.fv-x')) el.setAttribute('aria-label', tr('featureVote.close'));
    else el.textContent = tr('featureVote.close');
  }
  list.replaceChildren(...FEATURES.map((f) => {
    const li = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'fv-opt';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.name = 'feature';
    box.value = f.id;
    const span = document.createElement('span');
    span.textContent = labelOf(f.id);
    label.append(box, span);
    li.append(label);
    return li;
  }));

  const boxes = () => [...list.querySelectorAll('input[type="checkbox"]')];
  const picked = () => boxes().filter((b) => b.checked).map((b) => b.value);
  let source = 'menu';           // who opened it: 'auto' (the download moment) or 'menu'
  let sent = false;
  let sending = false;           // a ballot is on its way
  let pending = false;           // an auto-open is waiting for its delay

  function refresh() {
    const ids = picked();
    // MAX_VOTES enforced in the UI by disabling the rest, not by a message after
    // the fact: a disabled box is out of the tab order and announced as dimmed,
    // and the live count says why.
    for (const b of boxes()) b.disabled = !b.checked && ids.length >= MAX_VOTES;
    countEl.textContent = tr('featureVote.picked', { n: ids.length, max: MAX_VOTES });
    sendBtn.disabled = sent || sending || (ids.length === 0 && cleanIdea(ideaEl.value) === '');
  }

  // One step visible at a time; the dialog is named by the step's own heading.
  function showStep(name) {
    for (const [k, el] of Object.entries(steps)) el.hidden = k !== name;
    const head = { invite: inviteTitle, choose: titleEl, done: doneHead }[name];
    dlg.setAttribute('aria-labelledby', head.id);
    return head;
  }

  function resetForm() {
    sent = false;
    errorEl.hidden = true;
    for (const b of boxes()) { b.checked = false; b.disabled = false; }
    ideaEl.value = '';
    refresh();
  }

  // ---- step 3's coffee ask: the share/coffee card's own content, cloned ----------
  function buildCoffee() {
    coffeeEl.replaceChildren();
    coffeeEl.classList.remove('qr-open');
    const card = document.getElementById('support-card');
    const sub = card?.querySelector('.sc-sub');
    const donate = card?.querySelector('#sc-donate');
    const qr = card?.querySelector('.sc-qr');
    if (!sub || !donate || !qr) return;
    const ask = sub.cloneNode(true);
    const btn = donate.cloneNode(true);
    btn.removeAttribute('id'); // the original keeps #sc-donate
    btn.type = 'button';
    const actions = document.createElement('div');
    actions.className = 'sc-actions';
    actions.append(btn);
    const qrCopy = qr.cloneNode(true);
    coffeeEl.append(ask, actions, qrCopy);
    btn.addEventListener('click', () => {
      if (coffeeEl.classList.contains('qr-open')) return;
      coffeeEl.classList.add('qr-open');
      track('donate_tap', { surface: 'vote' });
    });
    track('share_card_shown', { surface: 'vote' });
  }

  async function showDone() {
    const head = showStep('done');
    topEl.replaceChildren();
    topWrap.hidden = true;
    buildCoffee();
    head.focus();
    // "Most picked so far", from the rail. Any failure, or too few votes (the
    // endpoint answers {voters:null}), leaves the plain thanks standing.
    try {
      const r = await fetch('/api/votes', { credentials: 'omit' });
      if (!r.ok) return;
      const d = await r.json();
      const ids = topThree(d?.counts);
      if (!ids.length || !dlg.open) return;
      topEl.replaceChildren(...ids.map((id) => {
        const li = document.createElement('li'); // names only, no counts
        li.textContent = labelOf(id);
        return li;
      }));
      topWrap.hidden = false;
    } catch { /* offline, blocked, or no endpoint: the thanks is already on screen */ }
  }

  // The ballot is AWAITED: "makasih" is said only for a ballot the server took (or
  // already had). On a refusal the card stays on step 2 with the ticks intact and
  // says so; nothing is remembered as voted.
  async function send() {
    const ids = picked();
    const text = cleanIdea(ideaEl.value);
    if (sent || sending || (ids.length === 0 && !text) || !cleanVote(ids).ok) return;
    sending = true;
    errorEl.hidden = true;
    sendBtn.disabled = true;
    // No usable visitor_id (private mode, blocked storage): there is no one to hold a
    // ballot for, so no ballot is sent and nothing is remembered as voted. An idea,
    // if there is one, is still filed (its visitor_id is simply null).
    const noVisitor = telemetry.hasVisitorId?.() === false;
    const result = noVisitor ? 'no-visitor' : await (telemetry.submitBallot?.(ids, text !== '') ?? 'failed');
    sending = false;
    if (result === 'failed') {
      errorEl.textContent = tr('featureVote.failed');
      errorEl.hidden = false;
      refresh();
      return;
    }
    sent = true;
    // The idea goes either way: it is its own note (feature_requests), not the ballot.
    if (text) telemetry.featureRequest?.(ids, text);
    if (result === 'recorded') {
      tel('feature_vote', { features: ids, has_text: text !== '' });
      rememberVote(ids);
    } else if (result === 'already') {
      rememberVote([]); // voted before: we do not know what they picked then, so we never claim to
    }
    showDone();
  }

  function open(from) {
    source = from;
    let head;
    if (isVoted()) { sent = true; head = null; } else { resetForm(); head = showStep('invite'); }
    if (!dlg.open) dlg.showModal();
    if (head === null) showDone();
    else head.focus();
  }

  // "Nanti aja": an explicit answer from any door. Closing the card by any other
  // route from the auto door, without a vote, is the same answer.
  function later() {
    rememberNanti(dayKey());
    if (dlg.open) dlg.close();
  }
  dlg.addEventListener('close', () => {
    if (source === 'auto' && !sent && !isVoted()) rememberNanti(dayKey());
    source = 'menu';
  });
  // The global `dialog` rule IS the overlay, so a click landing on the dialog
  // itself (not inside its .sheet) is a click outside.
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  for (const b of dlg.querySelectorAll('[data-fv-close]')) b.addEventListener('click', () => dlg.close());
  for (const b of dlg.querySelectorAll('[data-fv-later]')) b.addEventListener('click', later);
  $('.fv-start')?.addEventListener('click', () => showStep('choose').focus());
  list.addEventListener('change', (e) => {
    // Belt and braces for the UI's disabling: a fourth tick never stands.
    if (picked().length > MAX_VOTES && e.target?.checked) e.target.checked = false;
    refresh();
  });
  ideaEl.addEventListener('input', refresh);
  ideaEl.setAttribute('maxlength', String(IDEA_MAX));
  sendBtn.addEventListener('click', send);

  // The menu door: the nav link and the drawer link. Plain anchors so they read as
  // links to keyboard and screen reader alike; the click is the dialog's, not a jump.
  for (const a of document.querySelectorAll('[data-feature-vote-open]')) {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      // The mobile drawer sits above the page: shut it so the dialog is the only thing open.
      const drawer = document.getElementById('ld-burger-menu');
      if (drawer && !drawer.hidden) document.getElementById('ld-burger')?.click();
      open('menu');
    });
  }
  refresh();

  return {
    // Called by celebrate.js on EVERY successful download; `whole` is true only for
    // the whole document (not a picked subset). Returns true when the card TAKES this
    // download's moment, and the share/coffee card then does not show for it (his
    // ruling 2026-10-06: "begitu selesai download itu muncul, ngereplace share card
    // dan traktir kopi"). It opens at once, with no wait for the BERES stamp (a
    // body-level stamp paints under a top-layer dialog, so the dialog wins) and no
    // wait for other cards: if one is on screen the vote simply is not offered for
    // this download and the share card behaves as it always did.
    maybeShow({ whole, supportShownThisSession }) {
      // No visitor_id means no ballot can be held (one per visitor_id): do not invite.
      if (telemetry.hasVisitorId?.() === false) return false;
      if (pending || !shouldOfferVote({
        whole, voted: isVoted(), nantiDay: nantiDay(), today: dayKey(), supportShownThisSession,
      })) return false;
      if (document.querySelector(OCCUPANTS)) return false;
      pending = true;
      const go = () => {
        if (!pending) return;
        pending = false;
        if (document.querySelector(OCCUPANTS)) return; // something took the screen in the meantime
        open('auto');
      };
      // The Unduh sheet is closing in this same breath; opening after its `close`
      // keeps the sheet's own focus restore from landing on this dialog. A short
      // cap, so a sheet that never closes cannot hold the vote back.
      const sheet = document.getElementById('dl-sheet');
      if (sheet?.open) {
        sheet.addEventListener('close', go, { once: true });
        setTimeout(go, SHEET_WAIT_MS);
      } else if (document.hidden) {
        // A download is exactly when Android hides the tab behind its own sheet; a
        // dialog opened into a hidden tab is a dialog nobody saw (see
        // bug-report-prompt.js, which learned this the hard way).
        const onVisible = () => {
          if (document.hidden) return;
          document.removeEventListener('visibilitychange', onVisible);
          go();
        };
        document.addEventListener('visibilitychange', onVisible);
      } else go();
      return true;
    },
    open,
  };
}
