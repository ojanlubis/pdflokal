/*
 * PDFLokal — core/features.js  (THE FEATURE VOTE: the list, the rules)
 * ============================================================================
 * Founder ruling 2026-10-02: users vote on the planned features (at most 3) and
 * may write an idea of their own. We build everything; the RELEASE order follows
 * the vote.
 *
 * ONE LIST, AND IT IS DATA ONLY. A feature is an id and a group. Its LABEL is not
 * here: it is the text of its checkbox in index.html (and its English in
 * i18n/markup.en.json), so a label can be reworded without touching one stored
 * vote. The id is what the rail records, what api/votes.js counts and what the
 * founder reads; it is never shown and never renamed. tests/core/feature-vote.test.mjs
 * pins that the checkboxes in index.html and this list are the same set.
 *
 * Imported VERBATIM by js/core/telemetry-schema.js (so api/t.js drops a vote
 * naming an id that is not here), by api/feedback.js, by api/votes.js and by
 * js/v2/feature-vote.js. Client and server cannot disagree about what a feature is.
 *
 * ADDING A FEATURE: one row here, one checkbox in index.html, one pair in
 * i18n/markup.en.json. Old cached clients simply never send it.
 * RETIRING ONE: delete the row and the checkbox; its past votes stay on the rail
 * and api/votes.js ignores ids that are no longer on this list.
 */

export const MAX_VOTES = 3;

// The card is offered once, after the user's SECOND successful download (founder
// brief 2026-10-02): the first download is the share card's moment and the
// moment a stranger has just got what they came for; the second means they came
// back, or did a second job, and so have an opinion about what is missing.
export const MIN_DOWNLOADS = 2;

// The free-text idea is capped like the feedback form's note (js/v2/feedback-form.js).
export const IDEA_MAX = 500;

export const GROUPS = Object.freeze(['konversi', 'alat']);

export const FEATURES = Object.freeze([
  // Konversi
  { id: 'pdf-word', group: 'konversi' },
  { id: 'pdf-excel', group: 'konversi' },
  { id: 'pdf-ppt', group: 'konversi' },
  { id: 'word-pdf', group: 'konversi' },
  // Alat
  { id: 'form-fill', group: 'alat' },
  { id: 'camera-scan', group: 'alat' },
  { id: 'canvas-image', group: 'alat' },
  { id: 'redact', group: 'alat' },
  { id: 'watermark', group: 'alat' },
  { id: 'page-numbers', group: 'alat' },
  { id: 'lock', group: 'alat' },
  { id: 'batch', group: 'alat' },
  { id: 'crop', group: 'alat' },
  { id: 'grayscale', group: 'alat' },
].map((f) => Object.freeze(f)));

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
// state: null (never answered) | 'voted' | 'dismissed'.
// supportShownThisSession: the share/tip card already took this page load.
// A dismissed card does NOT come back: none of the existing cards has a "long
// gap" pattern worth copying (the share card is daily, the Play Store card was
// daily and nagged), and a vote you waved away once is an answer. The menu link
// is the door that stays.
export function shouldOfferVote({ downloads, state, supportShownThisSession }) {
  if (state === 'voted' || state === 'dismissed') return false;
  if (supportShownThisSession) return false;
  return Number.isInteger(downloads) && downloads >= MIN_DOWNLOADS;
}

// ---- the free-text idea, as it is stored -----------------------------------
// The idea goes into the SAME `feedback` table as the thumbs (api/feedback.js),
// whose `rating` column is a NOT NULL up|down check and which has no `kind`
// column. A migration on a live table is the founder's to run, and a deploy that
// writes a column before it exists loses every row (the feedback loop is rare
// enough that a dead one reads as a product nobody complains about), so the kind
// rides the note itself: `[fitur:pdf-word,watermark] the text`. This prefix is
// the SINGLE SOURCE OF TRUTH for it: api/feedback.js writes it, and the daily
// watch (api/_watch.js, api/cron/watch.js, api/routine.js) uses
// NOT_FEATURE_REQUEST_SQL to leave these rows out of the thumbs counts and the
// "new feedback" email.
export const REQUEST_NOTE_PREFIX = '[fitur:';
export const NOT_FEATURE_REQUEST_SQL = `coalesce(substr(note, 1, ${REQUEST_NOTE_PREFIX.length}), '') <> '${REQUEST_NOTE_PREFIX}'`;
export const IS_FEATURE_REQUEST_SQL = `coalesce(substr(note, 1, ${REQUEST_NOTE_PREFIX.length}), '') = '${REQUEST_NOTE_PREFIX}'`;

export function requestNote(ids, text) {
  return `${REQUEST_NOTE_PREFIX}${ids.join(',')}] ${text}`;
}
