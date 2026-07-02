/*
 * PDFLokal — v2/celebrate.js  (the download moment: reward, then invite)
 * ============================================================================
 * The download is the emotional peak — the user GOT their file. Two beats,
 * in the founder's order (backlog Wave 5):
 *   1. CELEBRATE — a small confetti burst. Never blocks or delays the save;
 *     honors prefers-reduced-motion; pure canvas, zero deps, self-hosted.
 *   2. INVITE — one dismissible card: share PDFLokal (Web Share / copy-link)
 *     or tip via QRIS — revealed INLINE (never navigate away from the flow;
 *     the QR is the same asset dukung.html uses). Frequency: once per
 *     session, with a permanent "jangan tampilkan lagi" opt-out. The file is
 *     already downloaded — nothing is ever held hostage.
 */

const OPTOUT_KEY = 'pdflokal-support-optout';
const SHARE_URL = 'https://www.pdflokal.id';
const SHARE_TEXT = 'Edit, gabung, dan tanda tangan PDF langsung di HP — gratis, privat, tanpa upload.';

// Private-browsing-safe storage (localStorage throws in some private modes).
function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, val) {
  try { localStorage.setItem(key, val); } catch { /* private mode — session-only */ }
}

// ---- beat 1: confetti -----------------------------------------------------------
function confetti() {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const c = document.createElement('canvas');
  c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:120';
  c.width = window.innerWidth;
  c.height = window.innerHeight;
  document.body.appendChild(c);
  const ctx = c.getContext('2d');
  const COLORS = ['#4f8ef7', '#f7b84f', '#1d8a44', '#d33131', '#8e4ff7'];
  const parts = Array.from({ length: 36 }, (_, i) => ({
    x: c.width / 2 + (i % 2 ? 1 : -1) * (i * 3),
    y: c.height * 0.35,
    vx: (Math.cos(i * 1.7) * (2 + (i % 5))),
    vy: -6 - (i % 7),
    s: 5 + (i % 4) * 2,
    r: i * 0.9,
    color: COLORS[i % COLORS.length],
  }));
  const t0 = performance.now();
  (function frame(t) {
    const dt = (t - t0) / 900; // ~0.9s of joy, then gone
    ctx.clearRect(0, 0, c.width, c.height);
    if (dt >= 1) { c.remove(); return; }
    for (const p of parts) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.35; // gravity
      p.r += 0.15;
      ctx.save();
      ctx.globalAlpha = 1 - dt;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6);
      ctx.restore();
    }
    requestAnimationFrame(frame);
  }(t0));
}

// ---- beat 2: the support card ------------------------------------------------------
// deps = { toast }
export function createCelebration(deps) {
  let shownThisSession = false;
  const card = document.getElementById('support-card');

  function hide() { card.classList.remove('show'); }

  card.querySelector('#sc-close').addEventListener('click', hide);
  card.querySelector('#sc-never').addEventListener('click', () => {
    safeSet(OPTOUT_KEY, '1');
    hide();
    deps.toast('Oke, nggak akan muncul lagi 👍');
  });

  card.querySelector('#sc-share').addEventListener('click', async () => {
    try {
      if (navigator.share) {
        await navigator.share({ title: 'PDFLokal', text: SHARE_TEXT, url: SHARE_URL });
        hide();
      } else {
        await navigator.clipboard.writeText(`${SHARE_TEXT} ${SHARE_URL}`);
        deps.toast('Link disalin — tinggal tempel ✓');
        hide();
      }
    } catch { /* user cancelled the share sheet — keep the card, no nagging toast */ }
  });

  card.querySelector('#sc-donate').addEventListener('click', () => {
    // Reveal the QR INLINE — never leave the editor (founder-locked).
    card.classList.add('qr-open');
  });

  return {
    // The one hook: called by the app's shared download chokepoint.
    onDownloadSuccess() {
      confetti(); // instant, independent of the card logic
      if (shownThisSession || safeGet(OPTOUT_KEY) === '1') return;
      shownThisSession = true;
      setTimeout(() => {
        card.classList.remove('qr-open');
        card.classList.add('show');
      }, 1100); // after the confetti settles and the sheet has closed
    },
  };
}
