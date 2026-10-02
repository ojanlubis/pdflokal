/*
 * PDFLokal — v2/install-prompt.js  (the "install to home screen" helper)
 * ============================================================================
 * Lives on the HOMEPAGE, never on the download moment — install must not compete
 * with the share ask (founder call, Jul 2026). A quiet chip under the dropzone,
 * shown by DEFAULT on every visit (founder call, Jul 20: the 2nd-visit gate was
 * wrong — the chip should just be there), opens a card that ADAPTS to the browser:
 *   - one-tap when the native prompt is armed (Chromium desktop + Android),
 *   - point-by-point instructions otherwise (iOS Safari, Android menu, desktop…).
 * Goal: recall — get PDFLokal onto the home screen so the next PDF job returns
 * free (GA4 finding: paid users complete the task but don't return unprompted).
 */
import { track } from '../lib/analytics.js';
import { t as tr } from '../lib/i18n.js';

const DISMISS_KEY = 'pdflokal-install-dismissed';

function lget(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lset(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }

// beforeinstallprompt fires when Chrome deems the app installable; stash it and
// fire on the user's tap. Module loads at app startup, early enough to catch it.
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
});

// SINGLE SOURCE OF TRUTH for "is this session running as an installed app".
// Exported 2026-07-28 so telemetry's doc_open.display_mode asks the SAME
// question the install UI does — two detectors would eventually disagree, and
// then the install-rate number and the install prompt would be telling
// different stories about the same session.
export function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}
function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS masquerades as Mac
}
function isMobile() {
  // Not `maxTouchPoints > 1`: a Windows/ChromeOS touchscreen laptop reports 10
  // touch points and would be told "install on your phone". The PRIMARY pointer
  // tells them apart: a phone's (or a desktop-mode Android's) is coarse, a
  // laptop's trackpad/mouse is fine even with a touchscreen attached.
  return isIOS() || /android/i.test(navigator.userAgent)
    || !!window.matchMedia?.('(pointer: coarse)').matches;
}
function deviceWord() { return isMobile() ? tr('install.device.mobile') : tr('install.device.desktop'); }


// Official install guides — the authoritative source for the EXACT, current UI
// labels (which drift by browser version + OS + locale). We keep a friendly
// first-guess AND link out to these. Step labels in the locale files were verified
// against the live pages on 2026-07-18; re-read 2026-10-02 and found DRIFT (Android
// Chrome now "More → Install and create shortcut → Install"; iOS Safari now
// "… → Share → Add to Home Screen → Open as Web App → Add"; Edge's menu path differs
// from Chrome's) — proposed strings are with the founder, not yet applied. Re-check
// periodically — see the memory note pwa-install-instructions-maintenance.
// (The link is the always-current backstop.)
// The help pages take the page's language (hl=), so /en/ links the English guide.
function guideUrl(kind) {
  const hl = tr('install.guideLang');
  return {
    ios: 'https://support.apple.com/guide/iphone/open-as-web-app-iphea86e5236/ios',
    android: `https://support.google.com/chrome/answer/9658361?hl=${hl}&co=GENIE.Platform%3DAndroid`,
    desktop: `https://support.google.com/chrome/answer/9658361?hl=${hl}&co=GENIE.Platform%3DDesktop`,
  }[kind];
}

// The sophisticated bit: what CAN this browser do, and if not one-tap, how exactly?
function detectInstall() {
  if (deferredPrompt) return { kind: 'onetap' };
  const ua = navigator.userAgent;
  const firefox = /firefox|fxios/i.test(ua);
  const samsung = /samsungbrowser/i.test(ua);
  const chromium = /chrome|crios|chromium|edg/i.test(ua) && !firefox;

  if (isIOS()) {
    return { kind: 'steps', title: tr('install.ios.title'), url: guideUrl('ios'), steps: tr('install.ios.steps') };
  }
  if (/android/i.test(ua)) {
    if (firefox) {
      return { kind: 'steps', title: tr('install.androidFirefox.title'), steps: tr('install.androidFirefox.steps') };
    }
    if (samsung) {
      return { kind: 'steps', title: tr('install.androidSamsung.title'), steps: tr('install.androidSamsung.steps') };
    }
    // Official (Chrome Help, 2026-10-02): ⋮ More → "Install and create shortcut" → "Install"
    // (the locale string still says the 2026-07-18 "Add to Home screen" path: copy is the founder's).
    return { kind: 'steps', title: tr('install.androidChrome.title'), url: guideUrl('android'), steps: tr('install.androidChrome.steps') };
  }
  // Desktop. Official (Chrome Help, 2026-07-18): the address-bar install icon, OR
  // ⋮ → "Cast, save, and share" → "Install page as app…" (the menu path moved —
  // it used to be a top-level "Install…").
  if (chromium) {
    return { kind: 'steps', title: tr('install.desktopChromium.title'), url: guideUrl('desktop'), steps: tr('install.desktopChromium.steps') };
  }
  if (/safari/i.test(ua)) {
    return { kind: 'steps', title: tr('install.desktopSafari.title'), steps: tr('install.desktopSafari.steps') };
  }
  return { kind: 'steps', title: tr('install.fallback.title'), steps: tr('install.fallback.steps') };
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

  const where = deviceWord();                          // hapemu | komputermu
  const screen = isMobile() ? tr('install.screen.mobile') : tr('install.screen.desktop');  // where the icon lands
  chipLabel.textContent = tr('install.chip', { where });
  cardTitle.textContent = tr('install.cardTitle', { where });
  cardSub.textContent = tr('install.cardSub', { screen });

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

  // Reveal the chip by DEFAULT — every visit — for non-installed, non-dismissed
  // users (founder call, Jul 20: the 2nd-visit gate was wrong; the chip should
  // just be there). Still suppressed for anyone already running the installed
  // PWA, or who tapped "jangan tampilkan lagi". One-tap vs steps is decided at
  // tap time by detectInstall.
  if (!isStandalone() && lget(DISMISS_KEY) !== '1') {
    chip.hidden = false;
  }
}
