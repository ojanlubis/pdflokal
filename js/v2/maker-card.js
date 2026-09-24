/*
 * PDFLokal — v2/maker-card.js  (the person behind it, and how many use it)
 * ============================================================================
 * Two founder asks, 2026-09-23, one module because they share one purpose:
 * a visitor should feel there is a real person working on this, and other
 * people using it.
 *
 *   1. THE MAKER CARD — Ojan's face and name (inherited from /dukung, the
 *      performer), his last three approved updates (js/updates.js), one way
 *      to support him. Homepage only, on a visitor's first open, and again
 *      only when an approved update exists they have not seen.
 *      A CORNER CARD, NOT A CENTRED DIALOG: the dropzone and Buka File stay
 *      usable. Blocking someone who came to fix a PDF, before they have tried
 *      the tool, is the "too begging" fence he named. On phones it sits IN
 *      THE PAGE under the dropzone instead: a fixed sheet covered Buka File on
 *      a 667px screen (tests/maker-card.spec.js caught it).
 *      Also on the SEO pages, which copy the landing: that is where most first
 *      visits arrive from Google. "Seen" is per origin, so it shows once.
 *
 *   2. THE COUNT — distinct browsers in the last 24 hours (api/visitors.js),
 *      in the homepage header beside the wordmark and in the editor header
 *      between File and the tools. His ruling: it is the FIRST thing to go
 *      when the header gets tight.
 */
import { shownUpdates } from '../updates.js';

export const SEEN_KEY = 'pdflokal_maker_seen';
const SHOW_DELAY_MS = 900; // let the landing paint and be read first

// Pure: show when there is something approved and its newest id is unseen.
export function shouldShowCard(entries, seenId) {
  return entries.length > 0 && entries[0].id !== seenId;
}

// "23 Sep" — short, and the same in both languages this page ships.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
export function shortDate(iso) {
  const [, m, d] = String(iso).split('-').map(Number);
  return m >= 1 && m <= 12 && d ? `${d} ${MONTHS[m - 1]}` : '';
}

function readSeen() {
  try { return localStorage.getItem(SEEN_KEY); } catch { return null; }
}
function writeSeen(id) {
  try { localStorage.setItem(SEEN_KEY, id); } catch { /* private mode: it just shows again */ }
}

export function initMakerCard({ entries = shownUpdates(), delay = SHOW_DELAY_MS } = {}) {
  const card = document.getElementById('maker-card');
  if (!card || !shouldShowCard(entries, readSeen())) return;

  const list = card.querySelector('.mk-list');
  list.replaceChildren(...entries.map((u) => {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.dateTime = u.date;
    time.textContent = shortDate(u.date);
    const p = document.createElement('span');
    p.textContent = u.text;
    li.append(time, p);
    return li;
  }));

  const dismiss = () => {
    writeSeen(entries[0].id);
    card.hidden = true;
  };
  card.querySelector('.mk-close').addEventListener('click', dismiss);
  // The support link navigates on its own; marking seen first means the card
  // does not greet them again when they come back from /dukung.
  card.querySelector('.mk-support').addEventListener('click', () => writeSeen(entries[0].id));

  // Homepage only. Opening a document leaves the landing; the card goes with
  // it, without marking seen — they never answered it.
  const onLanding = () => document.body.classList.contains('is-empty');
  new MutationObserver(() => { if (!onLanding()) card.hidden = true; })
    .observe(document.body, { attributes: true, attributeFilter: ['class'] });

  setTimeout(() => { if (onLanding()) card.hidden = false; }, delay);
}

// ---- the count ----------------------------------------------------------------

export function formatCount(n) {
  return Number.isInteger(n) ? n.toLocaleString('id-ID') : null;
}

// Editor header: the count is the first thing to leave when the row runs out
// of room. CSS gives it flex-shrink 1000, so it gives up space before File or
// a tool label does; this hides it the moment its own text would be clipped,
// and brings it back only when the toolbar has its whole width spare again
// plus 24px (hysteresis, so an edge width cannot flicker). Measured, never a
// guessed breakpoint, so a new tool can never strand it.
function fitEditorCount(el) {
  const header = el.parentElement;
  const toolbar = header?.querySelector('#toolbar');
  if (!toolbar || typeof ResizeObserver !== 'function') return;
  let natural = el.scrollWidth;
  const spare = () => {
    const kids = [...toolbar.children].filter((c) => c.offsetParent !== null);
    const used = kids.reduce((s, c) => s + c.getBoundingClientRect().width, 0);
    return toolbar.getBoundingClientRect().width - used;
  };
  const fit = () => {
    if (!el.classList.contains('is-crowded')) {
      natural = Math.max(natural, el.scrollWidth);
      if (el.scrollWidth > el.clientWidth + 1) el.classList.add('is-crowded');
    } else if (spare() > natural + 24) {
      el.classList.remove('is-crowded');
    }
  };
  new ResizeObserver(fit).observe(header);
  fit();
}

export async function initVisitorCount({ fetchImpl = globalThis.fetch } = {}) {
  const els = [...document.querySelectorAll('[data-visitor-count]')];
  if (els.length === 0 || typeof fetchImpl !== 'function') return;
  let n = null;
  try {
    const res = await fetchImpl('/api/visitors', { cache: 'no-store' });
    if (res.ok) n = (await res.json())?.visitors ?? null;
  } catch { /* offline or blocked: show nothing */ }
  const text = formatCount(n);
  if (!text) return;
  for (const el of els) {
    el.querySelector('.vc-n').textContent = text;
    el.hidden = false;
    if (el.closest('header') && !el.closest('.ld-hd')) fitEditorCount(el);
  }
}
