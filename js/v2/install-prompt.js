/*
 * PDFLokal — v2/install-prompt.js  (the "install to home screen" helper)
 * ============================================================================
 * Lives on the HOMEPAGE, never on the download moment — install must not compete
 * with the share ask (founder call, Jul 2026). A quiet chip under the dropzone,
 * shown only to RETURNING users, opens a card that ADAPTS to the browser:
 *   - one-tap when the native prompt is armed (Chromium desktop + Android),
 *   - point-by-point instructions otherwise (iOS Safari, Android menu, desktop…).
 * Goal: recall — get PDFLokal onto the home screen so the next PDF job returns
 * free (GA4 finding: paid users complete the task but don't return unprompted).
 */
import { track } from '../lib/analytics.js';

const DISMISS_KEY = 'pdflokal-install-dismissed';
const VISITS_KEY = 'pdflokal-visits';
const SESSION_FLAG = 'pdflokal-visit-counted';

function lget(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lset(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

// beforeinstallprompt fires when Chrome deems the app installable; stash it and
// fire on the user's tap. Module loads at app startup, early enough to catch it.
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
});

function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}
function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS masquerades as Mac
}
function isMobile() {
  return isIOS() || /android/i.test(navigator.userAgent) || navigator.maxTouchPoints > 1;
}
function deviceWord() { return isMobile() ? 'hapemu' : 'komputermu'; }

// One visit counted per browser session; "returning" = the 2nd session onward.
function countVisit() {
  try {
    if (window.sessionStorage.getItem(SESSION_FLAG)) return;
    window.sessionStorage.setItem(SESSION_FLAG, '1');
  } catch { /* private mode: count every load — harmless */ }
  lset(VISITS_KEY, String((parseInt(lget(VISITS_KEY), 10) || 0) + 1));
}
function isReturning() { return (parseInt(lget(VISITS_KEY), 10) || 0) >= 2; }

// Official install guides — the authoritative source for the EXACT, current UI
// labels (which drift by browser version + OS + locale). We keep a friendly
// Indonesian first-guess AND link out to these. Step labels below were verified
// against the live pages on 2026-07-18; re-check periodically — see the memory note
// pwa-install-instructions-maintenance. (The link is the always-current backstop.)
const GUIDE = {
  ios: 'https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios',
  android: 'https://support.google.com/chrome/answer/9658361?hl=id&co=GENIE.Platform%3DAndroid',
  desktop: 'https://support.google.com/chrome/answer/9658361?hl=id&co=GENIE.Platform%3DDesktop',
};

// The sophisticated bit: what CAN this browser do, and if not one-tap, how exactly?
function detectInstall() {
  if (deferredPrompt) return { kind: 'onetap' };
  const ua = navigator.userAgent;
  const firefox = /firefox|fxios/i.test(ua);
  const samsung = /samsungbrowser/i.test(ua);
  const chromium = /chrome|crios|chromium|edg/i.test(ua) && !firefox;

  if (isIOS()) {
    return { kind: 'steps', title: 'Caranya di iPhone/iPad:', url: GUIDE.ios, steps: [
      'Ketuk ikon Bagikan (kotak dengan panah ke atas) di bilah browser.',
      'Geser ke bawah, lalu ketuk “Tambah ke Layar Utama”.',
      'Ketuk “Tambah” di pojok kanan atas.',
    ] };
  }
  if (/android/i.test(ua)) {
    if (firefox) {
      return { kind: 'steps', title: 'Caranya di Firefox:', steps: [
        'Ketuk menu titik-tiga di pojok kanan atas.',
        'Pilih “Install”.',
      ] };
    }
    if (samsung) {
      return { kind: 'steps', title: 'Caranya di Samsung Internet:', steps: [
        'Ketuk menu di bagian bawah.',
        'Pilih “Tambahkan halaman ke”, lalu “Layar Utama”.',
      ] };
    }
    // Official (Chrome Help, 2026-07-18): ⋮ More → "Add to home screen" → "Install".
    return { kind: 'steps', title: 'Caranya di Chrome:', url: GUIDE.android, steps: [
      'Ketuk menu titik-tiga di kanan address bar.',
      'Pilih “Tambahkan ke Layar utama” (Add to Home screen).',
      'Ketuk “Instal” buat konfirmasi.',
    ] };
  }
  // Desktop. Official (Chrome Help, 2026-07-18): the address-bar install icon, OR
  // ⋮ → "Cast, save, and share" → "Install page as app…" (the menu path moved —
  // it used to be a top-level "Install…").
  if (chromium) {
    return { kind: 'steps', title: 'Caranya di Chrome/Edge:', url: GUIDE.desktop, steps: [
      'Klik ikon Instal (layar kecil dengan panah) di ujung kanan address bar, kalau ada.',
      'Atau: menu titik-tiga → “Cast, save, and share” → “Install page as app…”.',
      'Klik “Instal”.',
    ] };
  }
  if (/safari/i.test(ua)) {
    return { kind: 'steps', title: 'Caranya di Safari (Mac):', steps: [
      'Dari menu “File”, pilih “Add to Dock”.',
      'Klik “Add”.',
    ] };
  }
  return { kind: 'steps', title: 'Biar gampang dibuka lagi:', steps: [
    'Tekan Ctrl+D (atau ⌘D) buat bookmark halaman ini.',
    'Atau buka pdflokal.id lewat Chrome/Edge buat install jadi aplikasi.',
  ] };
}

export function initInstallPrompt() {
  const chip = document.getElementById('ip-chip');
  const card = document.getElementById('install-card');
  if (!chip || !card) return; // partial DOM — never crash the app

  const chipLabel = chip.querySelector('.ip-chip-label');
  const cardTitle = card.querySelector('.sc-head');
  const cardSub = card.querySelector('.sc-sub');
  const onetap = card.querySelector('#ic-onetap');
  const stepsBox = card.querySelector('#ic-steps');
  const stepsTitle = stepsBox.querySelector('.ic-steps-title');
  const stepsList = stepsBox.querySelector('ol');
  const guideLink = stepsBox.querySelector('#ic-guide');
  const installBtn = card.querySelector('#ic-install');

  countVisit();
  const where = deviceWord();                          // hapemu | komputermu
  const screen = isMobile() ? 'layar HP' : 'desktop';  // where the icon lands
  chipLabel.textContent = `Install PDFLokal di ${where}`;
  cardTitle.textContent = `Install PDFLokal di ${where}`;
  cardSub.textContent = `Biar besok nggak usah nyari lagi — langsung ada di ${screen}, tetap jalan walau lagi offline.`;

  function hideCard() { card.classList.remove('show'); }
  function openCard() {
    const info = detectInstall();
    if (info.kind === 'onetap') {
      onetap.hidden = false;
      stepsBox.hidden = true;
    } else {
      onetap.hidden = true;
      stepsBox.hidden = false;
      stepsTitle.textContent = info.title;
      // DOM construction (never innerHTML) — steps are static, but keep the house rule.
      stepsList.replaceChildren(...info.steps.map((s) => {
        const li = document.createElement('li');
        li.textContent = s;
        return li;
      }));
      // Always-current backstop: link to the official guide when we have one.
      if (info.url) { guideLink.href = info.url; guideLink.hidden = false; }
      else { guideLink.hidden = true; }
    }
    card.classList.add('show');
    track('pwa_card_open', { mode: info.kind });
  }
  function dismissForever() {
    lset(DISMISS_KEY, '1');
    chip.hidden = true;
    hideCard();
  }

  chip.addEventListener('click', openCard);
  card.querySelector('#ic-close').addEventListener('click', hideCard);
  card.querySelector('#ic-never').addEventListener('click', dismissForever);
  installBtn.addEventListener('click', async () => {
    const p = deferredPrompt;
    if (!p) { hideCard(); return; }
    deferredPrompt = null; // the event can only be used once
    try {
      p.prompt();
      const { outcome } = await p.userChoice;
      track('pwa_install', { outcome });
    } catch { /* consumed or cancelled — no nagging */ }
    hideCard();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    chip.hidden = true;
    hideCard();
    track('pwa_installed');
  });

  // Reveal the chip for returning, non-installed, non-dismissed users. (Whether it
  // opens to one-tap or steps is decided at tap time by detectInstall.)
  if (!isStandalone() && lget(DISMISS_KEY) !== '1' && isReturning()) {
    chip.hidden = false;
  }
}
