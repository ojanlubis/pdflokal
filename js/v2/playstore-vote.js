/*
 * PDFLokal — v2/playstore-vote.js  (TEMPORARY demand-validation campaign)
 * ===========================================================================
 * A binary "do you want PDFLokal on Play Store?" vote, shown at the download
 * moment IN PLACE OF the share/tip card. Founder call (2026-07-19): the peak-
 * enthusiasm slot is spent — deliberately and temporarily — on this go/no-go
 * signal, because the tester count is worth more than a marginal share for the
 * two weeks of the drive.
 *
 * Two steps: (1) the vote → GA4 event; (2) only "Ya" voters see the tester
 * opt-in → a Google Form. The yes→optin DROP-OFF is the real signal, not the
 * raw yes count: a free "yes" click skews positive (selection bias + zero
 * cost), so the number that matters is how many yes-voters actually leave an
 * email.
 *
 * Persistence: NONE of ours. The vote is a GA4 event (reuses the analytics
 * rail — no backend, no DB, no CSP change). The only thing stored is the
 * tester's Gmail + WhatsApp, in the Google Form, reached by the committed few.
 *
 * TO END THE CAMPAIGN: set PLAYSTORE_CAMPAIGN = false in celebrate.js. This
 * module goes dormant; the share/tip card returns. Nothing else to revert.
 */

import { track } from '../lib/analytics.js';

// The live tester sign-up form (Gmail + WhatsApp). Placeholder until it ships;
// swap this ONE string for the real forms.gle/… link.
const FORM_URL = 'https://forms.gle/cWaqHGvDXi1Dapie6';

const VOTED_KEY = 'pdflokal-ps-voted'; // set once they vote (yes|no) → never re-ask
const LAST_KEY = 'pdflokal-ps-last';   // dismiss-without-vote → once/day, no nagging

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

// deps = { toast }
export function createPlaystoreVote(deps) {
  const card = document.getElementById('vote-card');
  // Defensive no-op: SEO/landing pages are generated FROM index.html; if this
  // markup ever fails to propagate, degrade silently rather than crash the app.
  // (JAVASCRIPT-J: a null getElementById once took the whole growth channel
  // down on every SEO page for ~4h.)
  if (!card) return { maybeShow() { return false; } };

  function hide() {
    card.classList.remove('show');
    card.setAttribute('aria-hidden', 'true');
  }
  function show() {
    card.classList.add('show');
    card.setAttribute('aria-hidden', 'false');
  }

  // Scrim tap (outside the inner card) dismisses — the file is already saved,
  // it is never held hostage. Close button too.
  card.addEventListener('click', (e) => { if (e.target === card) hide(); });
  card.querySelector('#vc-close').addEventListener('click', hide);

  card.querySelector('#vc-no').addEventListener('click', () => {
    track('vote_playstore', { choice: 'no' });
    safeSet(VOTED_KEY, '1');
    deps.toast('Oke, makasih masukannya!');
    hide();
  });

  card.querySelector('#vc-yes').addEventListener('click', () => {
    track('vote_playstore', { choice: 'yes' });
    safeSet(VOTED_KEY, '1');
    card.classList.add('step2'); // reveal the tester opt-in in place
  });

  const tester = card.querySelector('#vc-tester');
  tester.href = FORM_URL;
  tester.addEventListener('click', () => {
    // The one metric that matters: yes → actually-signs-up conversion.
    track('tester_optin');
    setTimeout(hide, 120); // let the new tab open first
  });

  card.querySelector('#vc-later').addEventListener('click', () => {
    deps.toast('Sip, makasih ya!');
    hide();
  });

  return {
    // Returns true if it showed → celebrate.js then SKIPS the share/tip card.
    maybeShow() {
      if (safeGet(VOTED_KEY) === '1') return false;                 // already voted → done forever
      if (safeGet(LAST_KEY) === new Date().toDateString()) return false; // dismissed already today
      safeSet(LAST_KEY, new Date().toDateString());
      card.classList.remove('step2'); // always open on the vote, never mid-flow
      setTimeout(show, 200); // on the heels of the BERES burst
      return true;
    },
  };
}
