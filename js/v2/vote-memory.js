/*
 * PDFLokal — v2/vote-memory.js  (what this browser remembers about the feature vote)
 * ============================================================================
 * Four localStorage rows, ALL in privasi.html's #storage-ours. Shared by the card
 * (feature-vote.js) and the maker card (maker-card.js, which tells a voter their
 * feature shipped), so neither owns the keys and neither can drift from the other.
 *
 *   pdflokal_vote_done   once a vote was sent: 'voted' (round 1) or 'voted:2' (round 2); never asked again IN THAT ROUND
 *   pdflokal_vote_nanti  the day (YYYY-MM-DD) of the last "Nanti aja": asked again at most daily
 *   pdflokal_vote_ids    the ids this person voted for, all rounds (so the app can say when one ships)
 *   pdflokal_vote_told   the shipped ids already announced to them (so it is said once)
 *
 * ROUND 2 (2026-10-23): "voted" is per round, in the VALUE, so no new row is needed.
 * A round-1 voter holds 'voted', which is not 'voted:2': they are asked again. A round-1
 * "Nanti aja" day still quiets today, which is the right reading of "not now".
 *
 * The server never sees any of it: a vote is counted from the ballot box (api/votes.js),
 * keyed on visitor_id, so clearing storage only costs this browser its memory.
 * Every access is in try/catch: private mode degrades to "asks again", never a throw.
 */
import { parseIds, CURRENT_ROUND } from '../core/features.js';

export const DONE_KEY = 'pdflokal_vote_done';
export const NANTI_KEY = 'pdflokal_vote_nanti';
export const IDS_KEY = 'pdflokal_vote_ids';
export const TOLD_KEY = 'pdflokal_vote_told';

function get(k) { try { return localStorage.getItem(k); } catch { return null; } }
function set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: it just asks again */ } }

// The value DONE_KEY holds for a vote in `round`. Round 1 wrote the bare 'voted'.
export const doneValue = (round = CURRENT_ROUND) => (round === 1 ? 'voted' : `voted:${round}`);
export const isVoted = () => get(DONE_KEY) === doneValue();
export const nantiDay = () => get(NANTI_KEY);
export const votedIds = () => parseIds(get(IDS_KEY));
export const toldIds = () => parseIds(get(TOLD_KEY));

export function rememberNanti(day) { set(NANTI_KEY, day); }
// The ids are ADDED to what earlier rounds remembered: a round-1 voter who picked a
// feature that has since shipped must still be told, even after voting again.
export function rememberVote(ids) {
  set(IDS_KEY, JSON.stringify([...new Set([...votedIds(), ...ids])]));
  set(DONE_KEY, doneValue());
}
export function rememberTold(ids) { set(TOLD_KEY, JSON.stringify([...new Set([...toldIds(), ...ids])])); }
