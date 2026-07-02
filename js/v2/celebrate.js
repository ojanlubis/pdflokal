/*
 * PDFLokal — v2/celebrate.js  (the download moment: reward, then invite)
 * ============================================================================
 * The download is the emotional peak. Two beats, in the founder's order:
 *   1. CELEBRATE: the BERES stamp (stempel language — "cap = pernyataan
 *      status", see memory/design-language-2026-07.md). Thunk, gone in ~1.5s.
 *   2. INVITE: one dismissible card (share PDFLokal or tip via QRIS inline).
 *      Swipe-down dismisses it like any sheet. Once per calendar day,
 *      permanent opt-out. The file is already saved; never held hostage.
 * This module also owns the other stamp moments: TAMPILAN BARU (once per
 * device) and TETAP JALAN (offline mid-session). SUDAH OPTIMAL lives in
 * download-sheet.js, BARU in the future changelog.
 */

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
export function showStamp(text, { anchor = 'center', duration = 1500, host = document.body } = {}) {
  const el = document.createElement('div');
  el.className = 'v2-stamp';
  el.textContent = text;
  const pos = { bottom: 'bottom:110px', top: 'top:15%' }[anchor] || 'top:34%';
  el.style.cssText =
    `position:fixed;left:50%;${pos};z-index:130;pointer-events:none;` +
    'padding:8px 18px;border:3.5px solid #dc2626;border-radius:8px;color:#dc2626;' +
    'font-weight:700;font-size:21px;letter-spacing:.08em;text-transform:uppercase;' +
    'background:rgba(250,248,244,.72);white-space:nowrap;' +
    `-webkit-mask-image:${STAMP_MASK};mask-image:${STAMP_MASK};` +
    'transform:translateX(-50%) rotate(-6deg);';
  host.appendChild(el);
  if (!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
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
  setTimeout(() => el.remove(), duration);
}

// ---- beat 2: the support card --------------------------------------------------------
// deps = { toast }
export function createCelebration(deps) {
  let shownThisSession = false;
  const card = document.getElementById('support-card');

  // TAMPILAN BARU: once per device, the revamp announces itself. A stamp, not
  // a tour — one thunk and it's gone.
  if (safeGet('pdflokal-seen-revamp') !== '1') {
    safeSet('pdflokal-seen-revamp', '1');
    setTimeout(() => showStamp('Tampilan baru', { anchor: 'top', duration: 2200 }), 900);
  }

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

  // Swipe-down to dismiss: it looks like a sheet, so it must behave like one.
  let swipe = null;
  card.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, a, img')) return; // taps on controls stay taps
    swipe = { y: e.clientY, id: e.pointerId, moved: false };
    card.setPointerCapture(e.pointerId);
  });
  card.addEventListener('pointermove', (e) => {
    if (!swipe || e.pointerId !== swipe.id) return;
    const dy = e.clientY - swipe.y;
    if (dy > 6) swipe.moved = true;
    if (swipe.moved) card.style.transform = `translate(-50%, ${Math.max(0, dy)}px)`;
  });
  const endSwipe = (e) => {
    if (!swipe || e.pointerId !== swipe.id) return;
    const dy = e.clientY - swipe.y;
    swipe = null;
    if (dy > 56) hide();
    else card.style.transform = ''; // spring back (CSS transition)
  };
  card.addEventListener('pointerup', endSwipe);
  card.addEventListener('pointercancel', endSwipe);

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
      showStamp('Beres ✓'); // stamped on the document (center); the card owns the bottom
      // Once per CALENDAR DAY (founder call, Jul 3): heavy users get a gentle
      // daily reminder that free has a sponsor, never a toll booth per file.
      // shownThisSession stays as the fallback where localStorage is unwritable
      // (private mode) so it degrades to once-per-session, not every download.
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
