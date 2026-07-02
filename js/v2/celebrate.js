/*
 * PDFLokal — v2/celebrate.js  (the download moment: reward, then invite)
 * ============================================================================
 * The download is the emotional peak. Two beats, in the founder's order:
 *   1. CELEBRATE: a modern micro-burst (soft ring pulse + floating dots with
 *      spring easing, Web Animations API). Quick, quiet, gone in ~0.7s.
 *      Founder killed the 1990s rectangle confetti, rightly.
 *   2. INVITE: one dismissible card (share PDFLokal or tip via QRIS inline).
 *      Swipe-down dismisses it like any sheet. Once per session, permanent
 *      opt-out. The file is already saved; nothing is ever held hostage.
 */

const OPTOUT_KEY = 'pdflokal-support-optout';
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

// ---- beat 1: the burst ------------------------------------------------------------
// One expanding ring + a dozen soft dots that spring up and drift out, all
// GPU-composited transforms/opacity via WAAPI. Reads as "success", not "party".
function burst() {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const wrap = document.createElement('div');
  wrap.className = 'v2-burst';
  wrap.style.cssText =
    'position:fixed;left:50%;bottom:96px;width:0;height:0;pointer-events:none;z-index:120';
  document.body.appendChild(wrap);

  const ring = document.createElement('div');
  ring.style.cssText =
    'position:absolute;left:-28px;top:-28px;width:56px;height:56px;border-radius:50%;' +
    'border:2.5px solid rgba(79,142,247,.55)';
  wrap.appendChild(ring);
  ring.animate(
    [{ transform: 'scale(.3)', opacity: 1 }, { transform: 'scale(1.9)', opacity: 0 }],
    { duration: 520, easing: 'cubic-bezier(.2,.8,.2,1)' },
  );

  const COLORS = ['#4f8ef7', '#7db1ff', '#1d8a44', '#f7b84f'];
  for (let i = 0; i < 12; i += 1) {
    const dot = document.createElement('div');
    const s = 5 + (i % 3) * 3;
    dot.style.cssText =
      `position:absolute;left:${-s / 2}px;top:${-s / 2}px;width:${s}px;height:${s}px;` +
      `border-radius:50%;background:${COLORS[i % COLORS.length]};opacity:0`;
    wrap.appendChild(dot);
    const ang = (Math.PI * (i + 0.5)) / 12 + Math.PI; // upward fan
    const dist = 60 + (i % 4) * 22;
    const dx = Math.cos(ang) * dist * ((i % 2) ? 1 : -1) * 0.6;
    const dy = -Math.abs(Math.sin(ang)) * dist - 30;
    dot.animate(
      [
        { transform: 'translate(0,0) scale(.4)', opacity: 0 },
        { transform: `translate(${dx * 0.5}px,${dy * 0.6}px) scale(1)`, opacity: 1, offset: 0.35 },
        { transform: `translate(${dx}px,${dy}px) scale(.5)`, opacity: 0 },
      ],
      { duration: 620 + (i % 5) * 40, delay: i * 14, easing: 'cubic-bezier(.16,.84,.3,1)' },
    );
  }
  setTimeout(() => wrap.remove(), 950);
}

// ---- beat 2: the support card --------------------------------------------------------
// deps = { toast }
export function createCelebration(deps) {
  let shownThisSession = false;
  const card = document.getElementById('support-card');

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
      burst(); // instant, independent of the card logic
      if (shownThisSession || safeGet(OPTOUT_KEY) === '1') return;
      shownThisSession = true;
      setTimeout(() => {
        card.classList.remove('qr-open');
        card.classList.add('show');
      }, 200); // right on the heels of the burst (founder: 1.1s was too slow)
    },
  };
}
