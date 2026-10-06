/*
 * PDFLokal — v2/vote-memory.js  (what this browser remembers about the feature vote)
 * ============================================================================
 * Four localStorage rows, ALL in privasi.html's #storage-ours. Shared by the card
 * (feature-vote.js) and the maker card (maker-card.js, which tells a voter their
 * feature shipped), so neither owns the keys and neither can drift from the other.
 *
 *   pdflokal_vote_done   'voted' once a vote was sent (never asked again)
 *   pdflokal_vote_nanti  the day (YYYY-MM-DD) of the last "Nanti aja": asked again at most daily
 *   pdflokal_vote_ids    the ids this person voted for (so the app can say when one ships)
 *   pdflokal_vote_told   the shipped ids already announced to them (so it is said once)
 *
 * The server never sees any of it: a vote is counted from the rail (api/votes.js),
 * keyed on visitor_id, so clearing storage only costs this browser its memory.
 * Every access is in try/catch: private mode degrades to "asks again", never a throw.
 */
import { parseIds } from '../core/features.js';

export const DONE_KEY = 'pdflokal_vote_done';
export const NANTI_KEY = 'pdflokal_vote_nanti';
export const IDS_KEY = 'pdflokal_vote_ids';
export const TOLD_KEY = 'pdflokal_vote_told';

function get(k) { try { return localStorage.getItem(k); } catch { return null; } }
function set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: it just asks again */ } }

export const isVoted = () => get(DONE_KEY) === 'voted';
export const nantiDay = () => get(NANTI_KEY);
export const votedIds = () => parseIds(get(IDS_KEY));
export const toldIds = () => parseIds(get(TOLD_KEY));

export function rememberNanti(day) { set(NANTI_KEY, day); }
export function rememberVote(ids) { set(IDS_KEY, JSON.stringify(ids)); set(DONE_KEY, 'voted'); }
export function rememberTold(ids) { set(TOLD_KEY, JSON.stringify([...new Set([...toldIds(), ...ids])])); }
