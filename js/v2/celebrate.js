/*
 * PDFLokal — v2/celebrate.js  (the download moment: reward, then invite)
 * ============================================================================
 * The download is the emotional peak. Two beats, in the founder's order:
 *   1. CELEBRATE: the BERES stamp (stempel language — "cap = pernyataan
 *      status", see memory/design-language-2026-07.md). Thunk, gone in ~1.5s.
 *   2. INVITE: one dismissible card (share PDFLokal or tip via QRIS inline).
 *      Swipe-down dismisses it like any sheet. Once per calendar day,
 *      permanent opt-out. The file is already saved; never held hostage.
 * This module also owns TETAP JALAN (offline mid-session). TAMPILAN BARU is
 * a PERMANENT landing element (founder call, Jul 4 — it marks the revamp era;
 * lives in index.html markup). SUDAH OPTIMAL lives in download-sheet.js,
 * BARU in the future changelog.
 */

import { createPlaystoreVote } from './playstore-vote.js';

// TEMPORARY (founder call 2026-07-19): during the Play Store demand-validation
// drive, the download moment shows the binary VOTE card instead of share/tip —
// the peak-enthusiasm slot is spent, on purpose, on the go/no-go signal. Flip
// this to false to end the drive; the share/tip card returns, nothing else.
const PLAYSTORE_CAMPAIGN = true;

const OPTOUT_KEY = 'pdflokal-support-optout';
const LAST_SHOWN_KEY = 'pdflokal-support-last';
const SHARE_URL = 'https://www.pdflokal.id';
// Written the way a friend would actually send it, not like a brochure.
const SHARE_TEXT = 'Eh coba deh pdflokal.id, bisa edit + tanda tangan PDF langsung di HP. Gratis, dan filenya nggak diupload ke mana-mana.';

// Private-browsing-safe storage (localStorage throws in some private modes).
function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, val) {
  try { localStorage.setItem(key, val); } catch { /* private mode, session-only */ }
}

// ---- the stamp language -----------------------------------------------------------
// "Cap = pernyataan status": a stamp asserts the document's status, exactly like
// a real stempel, and is never decoration. Exactly five moments earn one (see
// memory/design-language-2026-07.md). Distressed texture is a CSS feTurbulence
// mask — zero assets, cheap on 1-juta phones.
const STAMP_MASK = 'url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'120\' height=\'120\'><filter id=\'n\'><feTurbulence baseFrequency=\'.75\'/></filter><rect width=\'120\' height=\'120\' filter=\'url(%23n)\' opacity=\'.9\'/></svg>")';

// opts.anchor: 'center' | 'bottom'. opts.host: element to append into — pass the
// open <dialog> when stamping over one (fixed children of a top-layer dialog
// paint above it; a body-appended stamp would be hidden underneath).
// opts.big: celebration size (BERES). opts.delay: wait before stamping —
// Android Chrome's own download dialog/notification upstages anything shown
// at t=0 (founder-caught), so the download stamp arrives fashionably late.
export function showStamp(text, {
  anchor = 'center', duration = 1500, host = document.body, big = false, delay = 0,
} = {}) {
  setTimeout(() => {
    const el = document.createElement('div');
    el.className = 'v2-stamp';
    el.textContent = text;
    const pos = { bottom: 'bottom:110px', top: 'top:15%' }[anchor] || 'top:34%';
    const scale = big
      ? 'padding:12px 26px;border:5px solid #dc2626;border-radius:12px;font-size:34px;letter-spacing:.09em;'
      : 'padding:8px 18px;border:3.5px solid #dc2626;border-radius:8px;font-size:21px;letter-spacing:.08em;';
    el.style.cssText =
      `position:fixed;left:50%;${pos};z-index:130;pointer-events:none;color:#dc2626;` +
      `font-weight:700;text-transform:uppercase;${scale}` +
      'background:rgba(250,248,244,.72);white-space:nowrap;' +
      `-webkit-mask-image:${STAMP_MASK};mask-image:${STAMP_MASK};` +
      'transform:translateX(-50%) rotate(-6deg);';
    host.appendChild(el);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!reduce) {
      el.animate(
        [
          { transform: 'translateX(-50%) rotate(-14deg) scale(2.1)', opacity: 0 },
          { transform: 'translateX(-50%) rotate(-6deg) scale(.96)', opacity: 1, offset: 0.55 },
          { transform: 'translateX(-50%) rotate(-6deg) scale(1)', opacity: 1 },
        ],
        { duration: 420, easing: 'cubic-bezier(.34,1.45,.44,1)' },
      );
      el.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 280, delay: duration - 280, fill: 'forwards',
      });
    }
    // The big stamp lands with a ring pulse — celebration, still stempel.
    if (big && !reduce) {
      const ring = document.createElement('div');
      ring.style.cssText =
        `position:fixed;left:50%;${pos};z-index:129;pointer-events:none;` +
        'width:90px;height:90px;margin-left:-45px;border-radius:50%;' +
        'border:3px solid rgba(220,38,38,.45);';
      host.appendChild(ring);
      ring.animate(
        [{ transform: 'scale(.4)', opacity: 1 }, { transform: 'scale(3.2)', opacity: 0 }],
        { duration: 700, delay: 120, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' },
      );
      setTimeout(() => ring.remove(), 950);
    }
    setTimeout(() => el.remove(), duration);
  }, delay);
}

// ---- beat 2: the support card --------------------------------------------------------
// deps = { toast }
export function createCelebration(deps) {
  let shownThisSession = false;
  const card = document.getElementById('support-card');
  // The temporary Play Store vote — owns its own gating; celebrate.js only asks
  // it to try, and skips the share/tip card when it takes the moment.
  const vote = createPlaystoreVote({ toast: deps.toast });

  // TETAP JALAN: connection dies, PDFLokal doesn't (no server in the loop).
  // The moat made visible — once per session, only while a page is open.
  let offlineShown = false;
  window.addEventListener('offline', () => {
    if (offlineShown) return;
    offlineShown = true;
    showStamp('Tetap jalan', { duration: 1800 });
    deps.toast('Internet putus. Tenang, semuanya jalan di HP-mu, bukan di server.');
  });

  function hide() {
    card.classList.remove('show');
    card.style.transform = ''; // reset any swipe offset
  }

  // Swipe-down to dismiss: the card looks like a sheet, so it behaves like one.
  function attachSwipeDismiss(el, onDismiss) {
    let swipe = null;
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, a, img')) return; // taps on controls stay taps
      swipe = { y: e.clientY, id: e.pointerId, moved: false };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!swipe || e.pointerId !== swipe.id) return;
      const dy = e.clientY - swipe.y;
      if (dy > 6) swipe.moved = true;
      if (swipe.moved) el.style.transform = `translate(-50%, ${Math.max(0, dy)}px)`;
    });
    const end = (e) => {
      if (!swipe || e.pointerId !== swipe.id) return;
      const dy = e.clientY - swipe.y;
      swipe = null;
      if (dy > 56) onDismiss();
      else el.style.transform = ''; // spring back (CSS transition)
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }
  attachSwipeDismiss(card, hide);

  card.querySelector('#sc-close').addEventListener('click', hide);
  card.querySelector('#sc-never').addEventListener('click', () => {
    safeSet(OPTOUT_KEY, '1');
    hide();
    deps.toast('Oke, nggak bakal muncul lagi');
  });

  card.querySelector('#sc-share').addEventListener('click', async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: 'PDFLokal', text: SHARE_TEXT, url: SHARE_URL });
        hide();
      } else {
        await navigator.clipboard.writeText(`${SHARE_TEXT} ${SHARE_URL}`);
        deps.toast('Udah disalin, tinggal kirim ke temanmu');
        hide();
      }
    } catch { /* user cancelled the share sheet; keep the card, no nagging */ }
  });

  card.querySelector('#sc-donate').addEventListener('click', () => {
    // Reveal the QR INLINE, never leave the editor (founder-locked).
    card.classList.add('qr-open');
  });

  return {
    // The one hook: called by the app's shared download chokepoint.
    onDownloadSuccess() {
      // Big, and ~1.2s late on purpose: Android Chrome's download dialog +
      // notification own the first second; we celebrate once the stage clears.
      showStamp('Beres ✓', { big: true, delay: 1200, duration: 3000 });
      // During the drive, the vote takes this slot from share/tip. If it shows,
      // we stop here; if it declines (already voted / dismissed today), the
      // share/tip card runs as usual — so voters still get the normal invite.
      if (PLAYSTORE_CAMPAIGN && vote.maybeShow()) return;
      // The share/tip invite, once per CALENDAR DAY (founder call, Jul 3) — a gentle
      // reminder that free has a sponsor, never a toll booth per file. (Install lives
      // on the homepage now, off this moment — see install-prompt.js.) shownThisSession
      // is the private-mode fallback, degrading to once-per-session, not every download.
      if (shownThisSession || safeGet(OPTOUT_KEY) === '1') return;
      if (safeGet(LAST_SHOWN_KEY) === new Date().toDateString()) return;
      shownThisSession = true;
      safeSet(LAST_SHOWN_KEY, new Date().toDateString());
      setTimeout(() => {
        card.classList.remove('qr-open');
        card.classList.add('show');
      }, 200); // right on the heels of the burst (founder: 1.1s was too slow)
    },
  };
}
