/*
 * PDFLokal — v2/h1-rotation.js  (the homepage headline that drifts: the wiring)
 * ============================================================================
 * The lines, the levels and the pick are js/core/h1-rotation.js (pure). This file
 * only counts days and writes the headline.
 *
 * ONE localStorage key, `pdflokal_visit_days` (a row in privasi.html's
 * #storage-ours): JSON {count, lastDay, last}. `count` is the number of distinct
 * WIB calendar days this browser loaded any page of the product, `lastDay` the
 * last one counted, `last` the headline last shown (so it is not repeated).
 * It stays in the browser; it is never sent anywhere.
 *
 * THE GATES, and why each one:
 *   - only counts when a visitor_id exists (hasVisitorId): no storage, no count,
 *     no rotation. A browser that cannot remember cannot have visited before.
 *   - only rotates on the two HOMEPAGES, `/` (Indonesian) and `/en` (English
 *     lines, the page's own language). The SEO pages share this module graph
 *     but their headline IS their keyword. Counting happens on every page of
 *     either language, one shared count for the browser, because a visit is a
 *     visit.
 *   - every storage access is in try/catch: a failure means the static headline.
 */
import { hasVisitorId } from './telemetry.js';
import { pickH1, wibDay, levelFor } from '../core/h1-rotation.js';

export const VISIT_DAYS_KEY = 'pdflokal_visit_days';

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(VISIT_DAYS_KEY));
    if (v && Number.isInteger(v.count) && v.count >= 1 && typeof v.lastDay === 'string') {
      return { count: v.count, lastDay: v.lastDay, last: typeof v.last === 'string' ? v.last : null };
    }
  } catch { /* unreadable or blocked: start over */ }
  return null;
}

function write(state) {
  try { localStorage.setItem(VISIT_DAYS_KEY, JSON.stringify(state)); } catch { /* private mode: static headline */ }
}

// Count today if it is a new WIB day. Returns the state, or null when there is no
// visitor_id or nothing could be stored (then there is no rotation either).
export function countToday(now = Date.now()) {
  if (!hasVisitorId()) return null;
  const today = wibDay(now);
  let state = read();
  if (!state) state = { count: 1, lastDay: today, last: null };
  else if (state.lastDay !== today) state = { ...state, count: state.count + 1, lastDay: today };
  else return state;
  write(state);
  return read() ? state : null; // read back: a setItem that did not stick is not a visit
}

// 'id' on the Indonesian homepage, 'en' on /en, null anywhere else.
function homeLang() {
  const p = location.pathname.replace(/\/+$/, '');
  if (p === '' || p === '/index' || p === '/index.html') return document.documentElement.lang === 'en' ? null : 'id';
  if (p === '/en' || p === '/en/index' || p === '/en/index.html') return document.documentElement.lang === 'en' ? 'en' : null;
  return null;
}

export function initH1Rotation() {
  try {
    const state = countToday();
    const lang = homeLang();
    if (!state || !lang) return;
    const line = pickH1({ visitDays: state.count, last: state.last, lang });
    if (line === null) return;
    const h1 = document.querySelector('.ld-hero-copy h1');
    if (!h1) return;
    h1.textContent = line;
    h1.dataset.h1Level = String(levelFor(state.count));
    write({ ...state, last: line });
  } catch { /* the static headline stays */ }
}
