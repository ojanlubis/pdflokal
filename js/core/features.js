/*
 * PDFLokal — core/features.js  (THE FEATURE VOTE: the list, the rules, the schedule)
 * ============================================================================
 * Founder ruling 2026-10-02: users vote on the planned features (at most 3) and
 * may write an idea of their own. We build everything; the RELEASE order follows
 * the vote. v2 (2026-10-06): his cut of the list to 8, a two-step card, a new
 * schedule, and "nanti saya kabari di sini" (SHIPPED, below).
 *
 * ONE LIST, AND IT IS DATA ONLY. A feature is an id. Its LABEL is not here: it is
 * `featureVote.labels` in js/locales/id.js and en.js, an array in THIS ORDER (the
 * i18n call-site law forbids building a key from the id), so a label can be
 * reworded without touching one stored vote. The id is what the rail records, what
 * api/votes.js counts and what the founder reads; it is never shown and never
 * renamed. tests/core/feature-vote.test.mjs pins that the dictionaries and this
 * list are the same length.
 *
 * Imported VERBATIM by js/core/telemetry-schema.js (so api/t.js drops a vote
 * naming an id that is not here), by api/feedback.js, by api/votes.js and by
 * js/v2/feature-vote.js. Client and server cannot disagree about what a feature is.
 *
 * ADDING A FEATURE: one row here, one label in each dictionary. Old cached clients
 * simply never send it.
 * RETIRING ONE: delete the row and its labels; its past votes stay on the rail
 * and api/votes.js ignores ids that are no longer on this list.
 * SHIPPING ONE: put its id in SHIPPED. Everyone who voted for it is told, once.
 */

export const MAX_VOTES = 3;

export const IDEA_MAX = 500;

// The free-text idea, cleaned: tags and stray angle brackets removed (it is a plain
// sentence, never markup, and it is only ever shown as text), control characters
// dropped, trimmed, capped at IDEA_MAX. '' when nothing is left. Applied by the
// client before sending and again by api/feedback.js: the server never trusts the client.
export function cleanIdea(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/[<>]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, IDEA_MAX);
}

// His order (2026-10-06). The card shows them in this order and api/votes.js
// breaks ties by it.
export const FEATURES = Object.freeze([
  { id: 'pdf-word' },
  { id: 'pdf-excel' },
  { id: 'save-edits' },
  { id: 'lock-unlock' },
  { id: 'form-fill' },
  { id: 'camera-scan' },
  { id: 'canvas-image' },
  { id: 'watermark' },
].map((f) => Object.freeze(f)));

// Features that are BUILT AND RELEASED, by id. Empty today. When one ships, add its
// id here: anyone whose stored vote holds it is told once, by the maker card
// ("<feature> sudah jadi. Kamu salah satu yang milih ini."), and never again.
export const SHIPPED = Object.freeze([]);

export const FEATURE_IDS = Object.freeze(FEATURES.map((f) => f.id));

// The ONE validator. `ids` is whatever arrived (a client, a request body, a
// beacon): returns { ok: true, ids } with the ids de-duplicated in the order
// given, or { ok: false }. Never repairs: more than MAX_VOTES, an id that is not
// on the list, a non-string, or a non-array all fail the WHOLE vote, because a
// vote that quietly dropped one of its choices is not the vote the person cast.
export function cleanVote(ids) {
  if (!Array.isArray(ids)) return { ok: false };
  if (ids.length > MAX_VOTES) return { ok: false };
  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== 'string' || !FEATURE_IDS.includes(id)) return { ok: false };
    if (seen.has(id)) return { ok: false };
    seen.add(id);
  }
  return { ok: true, ids: [...seen] };
}

// ---- when the card is offered (pure; js/v2/feature-vote.js wires it) ----------
// His rule (2026-10-02, restated 2026-10-06): after EVERY successful whole-document
// download, until the person taps "Nanti aja"; after a "Nanti aja", at most once a
// day; never again after voting. Never beside the share/coffee card or any other
// dialog (the wiring checks that at the moment of showing).
//   whole      this download was the whole document, not a picked subset
//   voted      the person has voted
//   nantiDay   dayKey() of the last "Nanti aja", or null
//   today      dayKey() now
//   supportShownThisSession  the share/coffee card already took this page load
export function shouldOfferVote({ whole, voted, nantiDay, today, supportShownThisSession }) {
  if (!whole) return false;
  if (voted) return false;
  if (supportShownThisSession) return false;
  if (typeof nantiDay === 'string' && nantiDay !== '' && nantiDay === today) return false;
  return true;
}

// The calendar day, local, as 'YYYY-MM-DD'. A calendar day, not 24 hours: the
// share/tip card's cap (celebrate.js) reads the same way.
export function dayKey(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

// ---- "nanti saya kabari di sini" (pure) -----------------------------------------
// Stored text -> the ids on the list, in list order. Anything else (old, corrupt,
// hand-edited) is dropped, never trusted.
export function parseIds(raw) {
  let arr = null;
  try { arr = JSON.parse(raw); } catch { /* not ours */ }
  if (!Array.isArray(arr)) return [];
  return FEATURE_IDS.filter((id) => arr.includes(id));
}

// The ids this person voted for that have SHIPPED and that they have not been told
// about yet, in SHIPPED order. `shipped` is a parameter only so a test can ship
// something; the app never passes it.
export function untoldShipped(voted, told, shipped = SHIPPED) {
  return shipped.filter((id) => voted.includes(id) && !told.includes(id));
}
