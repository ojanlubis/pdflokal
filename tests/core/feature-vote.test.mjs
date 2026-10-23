/*
 * THE FEATURE VOTE v2 (founder rulings 2026-10-02 and 2026-10-06), headless: the list,
 * the rules, the schedule, the ballot box, the idea, the "kabari" notice.
 * ============================================================================
 * What each group exists to catch, so none of them can pass by looking at nothing:
 *   - the list:      an id renamed, duplicated, reordered, or a label array that
 *                    no longer lines up with it
 *   - his words:     the strings he gave verbatim are still verbatim
 *   - the rules:     more than 3, an unknown id, a duplicate: each must fail the
 *                    WHOLE vote on every layer that takes one (schema, ballot, idea)
 *   - the schedule:  every download until "Nanti aja", once a day after, never
 *                    after a vote, never beside the share/coffee card (pure, and a
 *                    simulated week of downloads so the pieces are tested together)
 *   - the notice:    a shipped feature is told to its voters once, never to others
 *   - the ballot box: api/votes.js's REAL SQL on a real SQLite with the real
 *                    migration applied: one ballot per visitor, refused writes are
 *                    503 not "recorded", the HTTP-200-with-an-error trap is caught
 *   - the idea:      filed in its own table, tag-stripped, kept out of thumbs
 * The SQLite-backed groups need node:sqlite (Node 22.13+); on an older Node they
 * are reported as skipped, loudly, rather than passing by omission.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FEATURES, FEATURE_IDS, MAX_VOTES, IDEA_MAX, SHIPPED, cleanVote, cleanIdea, shouldOfferVote, dayKey, parseIds, untoldShipped,
  CURRENT_ROUND, FEATURE_STATUS, isSelectable, orderForCard,
} from '../../js/core/features.js';
import { validateEvent } from '../../js/core/telemetry-schema.js';
import tHandler, { __setQueryForTests as setTQuery } from '../../api/t.js';
import fbHandler, { __setQueryForTests as setFbQuery } from '../../api/feedback.js';
import votesHandler, {
  __setDbForTests as setDb, BALLOT_SQL, VOTES_SQL, shapeVotes, cleanBallot, MIN_VOTERS,
} from '../../api/votes.js';
import { topThree } from '../../js/v2/feature-vote.js';
import { shouldShowCard, noticeText } from '../../js/v2/maker-card.js';
import * as mem from '../../js/v2/vote-memory.js';
import ID from '../../js/locales/id.js';
import EN from '../../js/locales/en.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch { /* skipped below, by name */ }
const sqliteTest = (name, fn) => test(name, { skip: sqlite ? false : 'node:sqlite unavailable on this Node' }, fn);

// ---- the list ---------------------------------------------------------------

test('the list: his 8 in his order plus round 2\'s batch appended, unique stable ids, no groups, frozen', () => {
  assert.deepEqual(FEATURE_IDS, [
    'pdf-word', 'pdf-excel', 'save-edits', 'lock-unlock', 'form-fill', 'camera-scan', 'canvas-image', 'watermark', 'batch',
  ]);
  assert.equal(new Set(FEATURE_IDS).size, 9, 'ids are unique');
  for (const id of FEATURE_IDS) assert.match(id, /^[a-z]+(-[a-z]+)*$/, `${id}: ids are lowercase-kebab, never labels`);
  for (const f of FEATURES) assert.deepEqual(Object.keys(f), ['id'], 'a feature is its id and nothing else: no group headings');
  assert.equal(MAX_VOTES, 3);
  assert.ok(Object.isFrozen(FEATURES) && Object.isFrozen(FEATURES[0]), 'a vote cannot be bent by editing the list at runtime');
});

test('the labels line up with the list in BOTH languages, are his draft words, and carry no em dash', () => {
  for (const [name, dict] of [['id', ID], ['en', EN]]) {
    const labels = dict.featureVote.labels;
    assert.equal(labels.length, FEATURE_IDS.length, `${name}: one label per feature, in list order`);
    for (const l of labels) assert.ok(typeof l === 'string' && l.trim() !== '', `${name}: no blank label`);
    assert.equal(new Set(labels).size, labels.length, `${name}: labels are distinct`);
  }
  assert.deepEqual(ID.featureVote.labels, [
    'PDF ke Word', 'PDF ke Excel', 'Simpan editan buat dilanjut nanti', 'Kunci dan buka PDF yang pakai password',
    'Isi formulir PDF', 'Scan dokumen pakai kamera HP', 'Tempel gambar atau logo', 'Tambah watermark',
    'Proses banyak file sekaligus',
  ], 'the draft copy, verbatim (reference/vote-v2-copy-draft-2026-10-06.md; the last is round 2\'s batch)');
  assert.equal(EN.featureVote.labels.at(-1), 'Process many files at once');
  const all = JSON.stringify(ID.featureVote) + JSON.stringify(EN.featureVote);
  assert.ok(!/[—–]/.test(all), 'no em or en dash in anything a visitor reads');
});

test('his own words are verbatim (spelling and line breaks are his: do not fix them)', () => {
  assert.equal(ID.featureVote.inviteTitle, 'Voting Fitur PDFLokal', 'the brand is written PDFLokal, not "PDF Lokal"');
  assert.equal(ID.featureVote.invite, 'Halo guyss. Mau bikin fitur baru tp bingung apaan. Bantu voting doong. terimakasii');
  assert.equal(ID.featureVote.thanks, 'Makasi votingnyaa. Kalo udah jadi nnti dikabarin di sini yaa');
  assert.equal(ID.featureVote.shipped, '{feature} udah jadi nih. Kamu salah satu yang milih ini, makasii');
  assert.equal(ID.featureVote.badgeWip, 'Lagi dikerjakan', 'round 2: the founder\'s own words, final');
  const src = read('js/locales/id.js');
  assert.match(src, /DRAFT-APPROVED-BY-HIM/, 'the approved strings are marked');
  assert.match(src, /start: 'Pilih fitur', \/\/ DRAFT/);
  assert.match(src, /later: 'Nanti aja', \/\/ DRAFT/);
  // round 2's new strings are DRAFT-marked at their own line (the seat lists them for him)
  assert.match(src, /DRAFT-APPROVED-BY-HIM[^\n]*done[^\n]*\n\s*badgeShipped: 'Done',/, 'his word, marked approved, not DRAFT');
  assert.match(src, /'Proses banyak file sekaligus', \/\/ DRAFT/);
  assert.equal(ID.featureVote.badgeShipped, 'Done');
  assert.equal(EN.featureVote.badgeShipped, 'Done');
  assert.match(read('js/locales/en.js'), /badgeWip: '[^']+', \/\/ DRAFT/);
});

test('the card is a skeleton in index.html (no hard-coded option labels) and the menu link is in the nav and the drawer, / and /en', () => {
  const html = read('index.html');
  const dlg = html.match(/<dialog id="fv-form"[\s\S]*?<\/dialog>/)?.[0];
  assert.ok(dlg, 'the #fv-form dialog is in index.html (vacuity guard)');
  for (const step of ['invite', 'choose', 'done']) assert.ok(dlg.includes(`data-fv-step="${step}"`), step);
  assert.equal([...dlg.matchAll(/type="checkbox"/g)].length, 0, 'the checkboxes are built from the ONE list, not written twice');
  assert.ok(dlg.includes('src="/images/topi.svg"') && dlg.includes('src="/images/ojan.jpg"'), 'the maker card\'s own photo and hat assets');
  // Both anchors must exist: a missing title is indexOf -1, and anything is
  // "below" -1, so the order check alone passed with the title deleted.
  const titleAt = html.indexOf('id="fv-invite-title"');
  const photoAt = html.indexOf('class="fv-kepala"');
  assert.ok(titleAt >= 0 && photoAt >= 0, 'VACUITY: the invite title and his photo are both in index.html');
  assert.ok(photoAt > titleAt, 'his photo is BELOW his words');
  for (const f of ['index.html', 'en/index.html']) {
    const h = read(f);
    const nav = h.match(/<nav class="ld-nav"[\s\S]*?<\/nav>/)[0];
    const drawer = h.match(/<div class="ld-burger-menu"[\s\S]*?<div class="ld-burger-lang">/)[0];
    assert.match(nav, /data-feature-vote-open/, `${f}: desktop nav`);
    assert.match(drawer, /data-feature-vote-open/, `${f}: mobile drawer`);
    assert.ok(/<dialog id="fv-form"/.test(h), `${f}: the dialog is on the page`);
  }
});

// ---- the rules --------------------------------------------------------------

test('cleanVote: a valid vote passes; empty is allowed (a text-only idea)', () => {
  assert.deepEqual(cleanVote(['form-fill']), { ok: true, ids: ['form-fill'] });
  assert.deepEqual(cleanVote(['pdf-excel', 'watermark', 'batch']), { ok: true, ids: ['pdf-excel', 'watermark', 'batch'] });
  assert.deepEqual(cleanVote([]), { ok: true, ids: [] });
});

// ---- round 2 (2026-10-23): badged options, the per-option status map ---------------

test('ROUND 2: the current round is 2; pdf-word is "wip", save-edits and canvas-image are "shipped" (his call 2026-10-23)', () => {
  assert.equal(CURRENT_ROUND, 2);
  assert.deepEqual({ ...FEATURE_STATUS }, { 'pdf-word': 'wip', 'canvas-image': 'shipped', 'save-edits': 'shipped' });
  assert.ok(Object.isFrozen(FEATURE_STATUS), 'the status map cannot be bent at runtime');
  for (const id of ['pdf-word', 'canvas-image', 'save-edits']) assert.equal(isSelectable(id), false, `${id} is not pickable`);
  for (const id of ['form-fill', 'pdf-excel', 'camera-scan', 'lock-unlock', 'watermark', 'batch']) assert.equal(isSelectable(id), true, `${id} is pickable`);
  for (const status of Object.values(FEATURE_STATUS)) assert.ok(['wip', 'shipped'].includes(status), 'only wip or shipped have a badge');
});

test('ROUND 2: a badged option is refused by the ONE validator, alone or inside an otherwise good vote, and a shipped one stays unpickable', () => {
  for (const id of ['pdf-word', 'canvas-image', 'save-edits']) {
    assert.equal(cleanVote([id]).ok, false, `${id}: badged`);
    assert.equal(cleanVote(['form-fill', id]).ok, false, `${id}: one badged id fails the WHOLE vote, never dropped quietly`);
  }
  // the seat flips an entry to 'shipped': still badged, still not pickable (the map is the rule)
  assert.equal(isSelectable('pdf-word', { ...FEATURE_STATUS, 'pdf-word': 'shipped' }), false);
  assert.equal(isSelectable('pdf-word', {}), true, 'vacuity guard: with no entry it is an ordinary option')
});

test('ROUND 2: the card order puts the selectable options first and the status rows AFTER them, each group in list order', () => {
  assert.deepEqual(orderForCard().map((f) => f.id), [
    'pdf-excel', 'lock-unlock', 'form-fill', 'camera-scan', 'watermark', 'batch', // selectable, list order
    'pdf-word', 'save-edits', 'canvas-image', // status rows, list order
  ]);
  // driven by the map, not by a hard-coded list: flip one more and it moves down
  const more = orderForCard(FEATURES, { ...FEATURE_STATUS, watermark: 'shipped' }).map((f) => f.id);
  assert.deepEqual(more.slice(-4), ['pdf-word', 'save-edits', 'canvas-image', 'watermark']);
  assert.equal(more.length, FEATURES.length, 'a sort never loses or doubles an option');
  // vacuity guard: with no statuses the order is the list's own
  assert.deepEqual(orderForCard(FEATURES, {}).map((f) => f.id), FEATURE_IDS);
});

test('cleanVote: a bad id, a retired v1 id, more than 3, a duplicate, or a non-array fails the WHOLE vote', () => {
  assert.equal(cleanVote(['form-fill', 'nope']).ok, false, 'unknown id');
  for (const gone of ['crop', 'lock', 'pdf-ppt', 'word-pdf', 'redact', 'page-numbers', 'grayscale']) {
    assert.equal(cleanVote([gone]).ok, false, `${gone} was on v1's list, not on v2's`);
  }
  assert.equal(cleanVote(['PDF-WORD']).ok, false, 'ids are exact');
  assert.equal(cleanVote(['pdf-excel', 'watermark', 'camera-scan', 'lock-unlock']).ok, false, 'four');
  assert.equal(cleanVote(['pdf-excel', 'pdf-excel']).ok, false, 'duplicate');
  assert.equal(cleanVote('pdf-excel').ok, false);
  assert.equal(cleanVote(null).ok, false);
  assert.equal(cleanVote([1]).ok, false);
  assert.equal(cleanVote([{ id: 'pdf-excel' }]).ok, false);
  assert.equal(cleanVote(['__proto__']).ok, false);
});

test('cleanIdea: tags and brackets go, control characters go, trimmed, capped; nothing left is ""', () => {
  assert.equal(cleanIdea('  tolong tambah OCR  '), 'tolong tambah OCR');
  assert.equal(cleanIdea('<script>alert(1)</script>halo'), 'alert(1)halo');
  assert.equal(cleanIdea('a <b>tebal</b> b'), 'a tebal b');
  assert.equal(cleanIdea('1 < 2 > 0'), '1  0', 'a bracket pair reads as a tag and goes whole');
  assert.equal(cleanIdea('a < b'), 'a  b');
  assert.equal(cleanIdea('<img src=x onerror=y>'), '');
  assert.equal(cleanIdea('x\u0000y\u0007z'), 'xyz');
  assert.equal(cleanIdea('z'.repeat(900)).length, IDEA_MAX);
  assert.equal(cleanIdea(null), '');
  assert.equal(cleanIdea(5), '');
});

// ---- the schedule (pure) ----------------------------------------------------

const D1 = '2026-10-06';
const D2 = '2026-10-07';
const base = { whole: true, voted: false, nantiDay: null, today: D1, supportShownThisSession: false };

test('SCHEDULE: every whole-document download is offered, until "Nanti aja"', () => {
  assert.equal(shouldOfferVote(base), true, 'the very first download');
  assert.equal(shouldOfferVote(base), true, 'and the next one: nothing was answered');
  assert.equal(shouldOfferVote({ ...base, whole: false }), false, 'a picked subset (Ekstrak, chosen pages) is not a whole-document download');
});

test('SCHEDULE: after "Nanti aja", at most once per calendar day', () => {
  assert.equal(shouldOfferVote({ ...base, nantiDay: D1 }), false, 'the same day');
  assert.equal(shouldOfferVote({ ...base, nantiDay: D1, today: D2 }), true, 'the next day');
  assert.equal(shouldOfferVote({ ...base, nantiDay: '2026-09-01', today: D2 }), true, 'a long absence');
  assert.equal(shouldOfferVote({ ...base, nantiDay: '' }), true, 'no answer recorded is no answer');
});

test('SCHEDULE: never after voting, never beside the share/coffee card', () => {
  assert.equal(shouldOfferVote({ ...base, voted: true }), false);
  assert.equal(shouldOfferVote({ ...base, voted: true, nantiDay: '2020-01-01', today: D2 }), false, 'a vote outlives every day');
  assert.equal(shouldOfferVote({ ...base, supportShownThisSession: true }), false);
});

test('dayKey: a local calendar day, zero-padded, changes at midnight', () => {
  assert.equal(dayKey(new Date(2026, 9, 6, 23, 59)), '2026-10-06');
  assert.equal(dayKey(new Date(2026, 9, 7, 0, 1)), '2026-10-07');
  assert.equal(dayKey(new Date(2026, 0, 3)), '2026-01-03');
  assert.match(dayKey(), /^\d{4}-\d{2}-\d{2}$/);
});

test('SCHEDULE, a simulated week: offered each time until Nanti; quiet that day; back tomorrow; gone after a vote', () => {
  let nanti = null; let voted = false;
  const offered = (today, whole = true) => shouldOfferVote({ whole, voted, nantiDay: nanti, today, supportShownThisSession: false });
  assert.deepEqual([offered(D1), offered(D1), offered(D1)], [true, true, true], 'three downloads, no answer: three offers');
  nanti = D1;                                   // "Nanti aja" on day 1
  assert.deepEqual([offered(D1), offered(D1)], [false, false]);
  assert.equal(offered(D2), true, 'day 2: asked again');
  nanti = D2;                                   // "Nanti aja" again
  assert.equal(offered(D2), false);
  assert.equal(offered('2026-10-08'), true);
  voted = true;
  assert.deepEqual(['2026-10-08', '2026-10-09', '2027-01-01'].map((d) => offered(d)), [false, false, false], 'never again');
});

// ---- "nanti saya kabari di sini" (pure) -------------------------------------

test('SHIPPED is empty today (nothing is released, so nobody is told anything)', () => {
  assert.deepEqual([...SHIPPED], []);
  assert.deepEqual(untoldShipped(['pdf-word'], []), []);
});

test('untoldShipped: only voted AND shipped AND not yet told, in SHIPPED order; told once means told', () => {
  const shipped = ['watermark', 'pdf-word'];
  assert.deepEqual(untoldShipped(['pdf-word', 'watermark', 'save-edits'], [], shipped), ['watermark', 'pdf-word']);
  assert.deepEqual(untoldShipped(['save-edits'], [], shipped), [], 'voted for something that has not shipped');
  assert.deepEqual(untoldShipped([], [], shipped), [], 'did not vote');
  assert.deepEqual(untoldShipped(['pdf-word', 'watermark'], ['watermark'], shipped), ['pdf-word'], 'already told about one');
  // the lifecycle: told after the first showing, so the second call finds nothing
  let told = [];
  const first = untoldShipped(['pdf-word'], told, shipped);
  told = [...told, ...first];
  assert.deepEqual(first, ['pdf-word']);
  assert.deepEqual(untoldShipped(['pdf-word'], told, shipped), [], 'once');
});

test('parseIds: only ids on the list survive, in list order; corrupt storage is []', () => {
  assert.deepEqual(parseIds('["watermark","pdf-word","crop"]'), ['pdf-word', 'watermark']);
  assert.deepEqual(parseIds('not json'), []);
  assert.deepEqual(parseIds('{"a":1}'), []);
  assert.deepEqual(parseIds(null), []);
});

test('the maker card: a notice is a reason to show; its line names the feature; with none the old rule is unchanged', () => {
  const entries = [{ id: 'u1' }];
  assert.equal(shouldShowCard(entries, 'u1'), false, 'seen, nothing shipped');
  assert.equal(shouldShowCard(entries, 'u1', ['pdf-word']), true, 'seen update, but a feature they voted for shipped');
  assert.equal(shouldShowCard([], null, ['pdf-word']), true, 'no updates at all: the notice alone');
  assert.equal(shouldShowCard([], null, []), false);
  assert.equal(shouldShowCard(entries, 'u0'), true, 'a new update still shows it');
  assert.equal(noticeText('pdf-word'), 'PDF ke Word udah jadi nih. Kamu salah satu yang milih ini, makasii');
  assert.equal(noticeText('watermark'), 'Tambah watermark udah jadi nih. Kamu salah satu yang milih ini, makasii');
});

// ---- the rail event ---------------------------------------------------------

test('feature_vote schema: valid shapes pass, bad id / >3 / duplicate / wrong type / extra prop fail', () => {
  const ok = (p) => validateEvent('feature_vote', p).ok;
  assert.equal(ok({ features: ['pdf-word', 'lock-unlock'], has_text: false }), true);
  assert.equal(ok({ features: [], has_text: true }), true);
  assert.deepEqual(validateEvent('feature_vote', { features: ['watermark'], has_text: true }).clean, { features: ['watermark'], has_text: true });
  assert.equal(ok({ features: ['nope'], has_text: false }), false, 'bad id');
  assert.equal(ok({ features: ['crop'], has_text: false }), false, 'a v1 id');
  assert.equal(ok({ features: ['pdf-word', 'watermark', 'save-edits', 'lock-unlock'], has_text: false }), false, '>3');
  assert.equal(ok({ features: ['watermark', 'watermark'], has_text: false }), false, 'duplicates');
  assert.equal(ok({ features: 'watermark', has_text: false }), false, 'a string is not a set');
  assert.equal(ok({ features: ['watermark'] }), false, 'has_text is required');
  assert.equal(ok({ features: ['watermark'], has_text: 'yes' }), false);
  assert.equal(ok({ features: ['watermark'], has_text: false, note: 'free text' }), false, 'no free string, ever, on the rail');
  assert.equal(ok({ features: [{ id: 'watermark' }], has_text: false }), false);
});

test('feature_vote schema: `round` is an OPTIONAL int (a cached pre-round-2 client still lands its event), type-checked when present', () => {
  const ok = (p) => validateEvent('feature_vote', p).ok;
  assert.equal(ok({ features: ['batch'], has_text: false }), true, 'no round: an old client');
  assert.equal(ok({ features: ['batch'], has_text: false, round: 2 }), true);
  assert.deepEqual(validateEvent('feature_vote', { features: ['batch'], has_text: false, round: 2 }).clean, { features: ['batch'], has_text: false, round: 2 });
  assert.equal(ok({ features: ['batch'], has_text: false, round: '2' }), false, 'a string is not a round');
  assert.equal(ok({ features: ['batch'], has_text: false, round: -1 }), false);
  assert.equal(ok({ features: ['batch'], has_text: false, round: 2, extra: 1 }), false, 'still no unknown prop');
  assert.equal(ok({ features: ['pdf-word'], has_text: false, round: 1 }), true, 'round 1 ids stay valid on the rail (history)');
  assert.match(read('js/v2/feature-vote.js'), /tel\('feature_vote', \{ features: ids, has_text: text !== '', round: CURRENT_ROUND \}\);/, 'the client sends the round');
  assert.match(read('js/v2/telemetry.js'), /round: CURRENT_ROUND, features: vote\.ids/, 'and the ballot carries it');
});

// ---- the client's memory, per round (js/v2/vote-memory.js) -----------------------------
function withStorage(seed, fn) {
  const store = new Map(Object.entries(seed));
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); },
  } });
  try { return fn(store); } finally { if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete globalThis.localStorage; }
}

test('ROUND 2 memory: a round-1 voter ("voted") is NOT counted as voted in round 2, so they are asked again; a round-2 vote is remembered', () => {
  withStorage({ pdflokal_vote_done: 'voted', pdflokal_vote_ids: '["pdf-word","watermark"]' }, (store) => {
    assert.equal(mem.isVoted(), false, 'round 1\'s "voted" does not silence round 2');
    assert.equal(shouldOfferVote({ ...base, voted: mem.isVoted() }), true, 'and so the schedule offers the card');
    mem.rememberVote(['form-fill']);
    assert.equal(store.get('pdflokal_vote_done'), 'voted:2');
    assert.equal(mem.isVoted(), true, 'now it is');
    assert.deepEqual(mem.votedIds(), ['pdf-word', 'form-fill', 'watermark'], 'earlier rounds\' ids are kept (a shipped one is still announced), in list order');
  });
  withStorage({ pdflokal_vote_done: 'voted:2' }, () => assert.equal(mem.isVoted(), true));
  withStorage({}, () => assert.equal(mem.isVoted(), false, 'nobody: not voted'));
  withStorage({ pdflokal_vote_done: 'voted:3' }, () => assert.equal(mem.isVoted(), false, 'a later round is a different round'));
  assert.equal(mem.doneValue(1), 'voted', 'round 1 wrote the bare word');
  assert.equal(mem.doneValue(2), 'voted:2');
});

test('ROUND 2 memory: "already voted" (the server knew them) claims no ids but still counts as voted this round, and a round-1 "Nanti aja" does not hide the round', () => {
  withStorage({ pdflokal_vote_done: 'voted', pdflokal_vote_ids: '["watermark"]' }, () => {
    mem.rememberVote([]);
    assert.deepEqual(mem.votedIds(), ['watermark'], 'nothing added, nothing lost');
    assert.equal(mem.isVoted(), true);
  });
  // round 1's nanti is a DAY: it quiets that day only, exactly as the schedule always did
  assert.equal(shouldOfferVote({ ...base, nantiDay: '2026-10-22', today: '2026-10-23' }), true);
});

function mkReq(bodyObj, { method = 'POST' } = {}) {
  const chunks = [Buffer.from(typeof bodyObj === 'string' ? bodyObj : JSON.stringify(bodyObj), 'utf8')];
  return { method, headers: {}, on(evt, cb) { if (evt === 'data') chunks.forEach((c) => cb(c)); if (evt === 'end') cb(); return this; } };
}
const mkRes = () => {
  const r = { code: null, headers: {}, body: undefined };
  r.status = (c) => { r.code = c; return r; };
  r.end = (b) => { r.body = b; return r; };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; };
  return r;
};

const SESSION = '3f1c9a52-0b6e-4a7d-9c11-2f7e5d8a4b30';
const VISITOR = '9a1e0c44-2b7d-4f10-8c55-1d3e6f7a8b90';
const VISITOR2 = '1b2c3d4e-5f60-4a71-8b92-a3b4c5d6e7f8';

async function postVote(props) {
  const calls = [];
  // Only the `events` insert is a written vote. A dropped batch also writes one
  // telemetry_rejects upsert (api/_rejects.js): it is the counter of what was NOT
  // written, so it is answered but never counted as a call.
  setTQuery(async (text, params) => {
    if (/insert into telemetry_rejects/i.test(String(text))) return { rowCount: params.length / 5 };
    calls.push({ text, params });
    return { rowCount: params.length / 6 };
  });
  const saved = process.env.TURSO_EVENTS_URL;
  const res = mkRes();
  try {
    await tHandler(mkReq({
      session_id: SESSION, app_version: 'abc1234', visitor_id: VISITOR,
      events: [{ event: 'feature_vote', props }],
    }), res);
  } finally { setTQuery(null); if (saved === undefined) delete process.env.TURSO_EVENTS_URL; }
  return { calls, res };
}

test('api/t.js: a valid vote event is written with its ids and the visitor; bad ones are never written', async () => {
  const good = await postVote({ features: ['pdf-excel', 'watermark'], has_text: true });
  assert.equal(good.res.code, 204);
  assert.equal(good.calls.length, 1, 'a valid vote reaches the insert');
  const [ts, session, , event, props, visitor] = good.calls[0].params;
  assert.ok(ts && session === SESSION && event === 'feature_vote');
  assert.deepEqual(JSON.parse(props), { features: ['pdf-excel', 'watermark'], has_text: true });
  assert.equal(visitor, VISITOR);

  for (const bad of [
    { features: ['not-a-feature'], has_text: false },
    { features: ['pdf-excel', 'watermark', 'camera-scan', 'lock-unlock'], has_text: false },
    { features: ['watermark', 'watermark'], has_text: false },
  ]) {
    const r = await postVote(bad);
    assert.equal(r.res.code, 204, 'the client never sees an error');
    assert.equal(r.calls.length, 0, `dropped, not written: ${JSON.stringify(bad)}`);
  }
});

// ---- the free-text idea (api/feedback.js) ---------------------------------------
// It is filed in its OWN table, feature_requests, and writes ZERO rows to `feedback`.

async function postFeedback(body) {
  const calls = [];
  setFbQuery(async (text, params) => { calls.push({ text: String(text), params }); return { rowCount: 1 }; });
  const res = mkRes();
  try { await fbHandler(mkReq({ session_id: SESSION, app_version: 'abc1234', ...body }), res); } finally { setFbQuery(null); }
  return { calls, res };
}
// insert into feature_requests (ts, session_id, visitor_id, app_version, lang, features, note)
const FR = { ts: 0, session: 1, visitor: 2, version: 3, lang: 4, features: 5, note: 6 };
const intoTable = (call) => /insert into (\w+)/i.exec(call.text)[1];

test('feedback kind feature_request: filed in feature_requests with ids, visitor, lang, and writes ZERO rows to feedback', async () => {
  const { calls, res } = await postFeedback({
    kind: 'feature_request', features: ['pdf-excel', 'watermark'], note: '  tolong tambah OCR  ', visitor_id: VISITOR, lang: 'en',
  });
  assert.equal(res.code, 204);
  assert.equal(calls.length, 1, 'exactly one statement');
  assert.equal(intoTable(calls[0]), 'feature_requests');
  assert.equal(calls.filter((c) => intoTable(c) === 'feedback').length, 0, 'ZERO rows to the thumbs table');
  const p = calls[0].params;
  assert.equal(p[FR.session], SESSION);
  assert.equal(p[FR.visitor], VISITOR);
  assert.equal(p[FR.version], 'abc1234');
  assert.equal(p[FR.lang], 'en');
  assert.deepEqual(JSON.parse(p[FR.features]), ['pdf-excel', 'watermark']);
  assert.equal(p[FR.note], 'tolong tambah OCR', 'trimmed, and untagged: no prefix trick any more');
});

test('feedback kind feature_request: no HTML is ever stored; a note that is only markup is no idea at all', async () => {
  const { calls } = await postFeedback({ kind: 'feature_request', note: 'tambah <b>OCR</b><script>x()</script> dong' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[FR.note], 'tambah OCRx() dong');
  assert.ok(!/[<>]/.test(calls[0].params[FR.note]));
  const none = await postFeedback({ kind: 'feature_request', note: '<img src=x onerror=y>' });
  assert.equal(none.calls.length, 0, 'nothing is left of it, so nothing is filed');
});

test('feedback kind feature_request: never carries images; a bad visitor_id or lang is NULL, not a dropped idea', async () => {
  const png = `data:image/png;base64,${'A'.repeat(40)}`;
  const jpg = `data:image/jpeg;base64,${'A'.repeat(40)}`;
  const { calls } = await postFeedback({
    kind: 'feature_request', features: [], note: 'x', visitor_id: 'not-a-uuid', lang: 'fr',
    sample_before: png, sample_after: png, screenshot: jpg,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.length, 7, 'seven columns, none of them an image');
  assert.equal(calls[0].params[FR.visitor], null);
  assert.equal(calls[0].params[FR.lang], null);
  assert.ok(!JSON.stringify(calls[0].params).includes('base64'));
});

test('feedback kind feature_request: a text-only idea files with no ids; the text is capped at 500', async () => {
  const { calls } = await postFeedback({ kind: 'feature_request', note: 'z'.repeat(900) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params[FR.note], 'z'.repeat(500));
  assert.equal(calls[0].params[FR.features], '[]');
});

test('feedback kind feature_request: no text, a bad id, more than 3, a duplicate: dropped whole, never repaired', async () => {
  for (const body of [
    { kind: 'feature_request', features: ['pdf-excel'] },
    { kind: 'feature_request', features: ['pdf-excel'], note: '   ' },
    { kind: 'feature_request', features: ['nope'], note: 'x' },
    { kind: 'feature_request', features: ['pdf-excel', 'watermark', 'camera-scan', 'lock-unlock'], note: 'x' },
    { kind: 'feature_request', features: ['watermark', 'watermark'], note: 'x' },
    { kind: 'feature_request', features: 'watermark', note: 'x' },
  ]) {
    const { calls, res } = await postFeedback(body);
    assert.equal(res.code, 204);
    assert.equal(calls.length, 0, `dropped: ${JSON.stringify(body)}`);
  }
});

test('a normal thumbs note is untouched (rating still required, still the feedback table, no feature_requests write)', async () => {
  const none = await postFeedback({ note: 'tanpa rating' });
  assert.equal(none.calls.length, 0, 'still needs a rating');
  const down = await postFeedback({ rating: 'down', note: 'hurufnya tebal' });
  assert.equal(down.calls.length, 1);
  assert.equal(intoTable(down.calls[0]), 'feedback');
  assert.equal(down.calls[0].params[3], 'down');
  assert.equal(down.calls[0].params[4], 'hurufnya tebal');
  // `kind` is only a request when it says so exactly: a lookalike is just a thumbs note.
  const odd = await postFeedback({ kind: 'feature_requestt', rating: 'up', note: 'hi' });
  assert.equal(intoTable(odd.calls[0]), 'feedback');
});

// ---- the migration, on a real SQLite -------------------------------------------------

const MIGRATION = read('scripts/turso-feedback-migration.sql');
const MIGRATION_R2 = read('scripts/turso-feedback-vote-r2.sql');
// Production at round 2: the round-1 migration is already applied, the r2 one is applied before merge.
function freshDb() {
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(MIGRATION);
  db.exec(MIGRATION_R2);
  return db;
}
// api/votes.js's test seam backed by a REAL database: the endpoint's own SQL runs on it.
function dbSeam(db, log = []) {
  return async (sql, values) => {
    log.push({ sql: String(sql), values });
    const stmt = db.prepare(sql);
    if (/^\s*(select|with)\b/i.test(sql)) return { rows: stmt.all(...values).map((r) => Object.values(r)) };
    return { rowCount: Number(stmt.run(...values).changes) };
  };
}
const ballotOf = (over = {}) => ({ visitor_id: VISITOR, round: CURRENT_ROUND, features: ['pdf-excel', 'watermark'], has_text: false, lang: 'id', ...over });
async function castBallot(body) {
  const res = mkRes();
  await votesHandler(mkReq(body), res);
  return { code: res.code, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
}

sqliteTest('the migration: idempotent, ADDITIVE ONLY (creates, never alters or drops), and the feature_requests insert lands with feedback left empty', async () => {
  assert.ok(!/\b(drop\s+(table|view|index)|alter\s+table|delete\s+from\s+(?!.*--))/im.test(MIGRATION.replace(/^\s*--.*$/gm, '')), 'no DROP, no ALTER, no DELETE in the executable SQL');
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(MIGRATION);
  db.exec(MIGRATION); // CREATE ... IF NOT EXISTS: running it twice is a no-op, not an error
  const { calls } = await postFeedback({ kind: 'feature_request', features: ['pdf-excel', 'watermark'], note: 'tolong tambah OCR', visitor_id: VISITOR, lang: 'id' });
  assert.equal(calls.length, 1);
  db.prepare(calls[0].text).run(...calls[0].params); // the very statement the endpoint sends
  assert.equal(db.prepare('select count(*) n from feature_requests').get().n, 1);
  assert.equal(db.prepare('select count(*) n from feedback').get().n, 0, 'the thumbs table is untouched');
  const bad = (features, note) => () => db.prepare(
    'insert into feature_requests (session_id, app_version, features, note) values (?,?,?,?)').run(SESSION, 'abc1234', features, note);
  assert.throws(bad('["a","b","c","d"]', 'x'));
  assert.throws(bad('[]', ''));
  assert.throws(bad('{}', 'x'));
  db.close();
});

sqliteTest('the migration adds exactly feature_ballots (+ its index) for the vote, beside the existing feature_requests', () => {
  const db = freshDb();
  const cols = db.prepare("select name, type, pk from pragma_table_info('feature_ballots') order by cid").all();
  assert.deepEqual(cols.map((c) => c.name), ['visitor_id', 'ts', 'lang', 'has_text', 'features']);
  assert.equal(cols.find((c) => c.name === 'visitor_id').pk, 1, 'visitor_id IS the primary key: the one-ballot rule');
  assert.ok(db.prepare("select 1 from sqlite_master where type='index' and name='feature_ballots_ts_idx'").get());
  db.close();
});

sqliteTest('ROUND 2 migration: its own file, idempotent, ADDITIVE ONLY, same shape and constraints as round 1, and it leaves round 1 byte-for-byte alone', () => {
  const exec = MIGRATION_R2.replace(/^\s*--.*$/gm, '');
  assert.ok(!/\b(drop\s|alter\s|delete\s|update\s|insert\s)/i.test(exec), 'no DROP, ALTER, DELETE, UPDATE or INSERT: it only creates');
  assert.ok(!/feature_ballots\b(?!_r2)|feature_requests|\bfeedback\b/.test(exec), 'it names no round-1 table at all, not even to read it');
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec(MIGRATION);
  // round 1 has real rows before round 2 arrives, exactly like production
  const r1 = db.prepare('insert into feature_ballots (visitor_id, lang, has_text, features) values (?,?,?,?)');
  r1.run(VISITOR, 'id', 0, '["pdf-word","watermark"]');
  r1.run(VISITOR2, 'en', 1, '[]');
  const before = JSON.stringify(db.prepare('select * from feature_ballots order by visitor_id').all());
  const schemaBefore = JSON.stringify(db.prepare("select name, sql from sqlite_master where name not like '%feature_ballots_r2%' order by name").all());
  db.exec(MIGRATION_R2);
  db.exec(MIGRATION_R2); // twice is a no-op, not an error
  assert.equal(JSON.stringify(db.prepare('select * from feature_ballots order by visitor_id').all()), before, 'round 1 rows unchanged');
  assert.equal(JSON.stringify(db.prepare("select name, sql from sqlite_master where name not like '%feature_ballots_r2%' order by name").all()), schemaBefore, 'no other table, view or index changed');
  const shape = (t) => db.prepare(`select name, type, "notnull", dflt_value, pk from pragma_table_info('${t}') order by cid`).all();
  assert.deepEqual(shape('feature_ballots_r2'), shape('feature_ballots'), 'same columns, types, defaults and primary key as round 1');
  assert.ok(db.prepare("select 1 from sqlite_master where type='index' and name='feature_ballots_r2_ts_idx'").get());
  assert.equal(db.prepare('select count(*) n from feature_ballots_r2').get().n, 0, 'it starts empty');
  // the same CHECKs bite (a copy that lost one would take this row)
  const ins = (v, f, h = 0, l = 'id') => () => db.prepare('insert into feature_ballots_r2 (visitor_id, lang, has_text, features) values (?,?,?,?)').run(v, l, h, f);
  assert.throws(ins('not-a-uuid', '["batch"]'), /CHECK|constraint/i);
  assert.throws(ins(VISITOR.toUpperCase(), '["batch"]'), /CHECK|constraint/i);
  assert.throws(ins(VISITOR, '["a","b","c","d"]'), /CHECK|constraint/i);
  assert.throws(ins(VISITOR, '[]', 0), /CHECK|constraint/i);
  assert.throws(ins(VISITOR, '["batch"]', 2), /CHECK|constraint/i);
  assert.throws(ins(VISITOR, '["batch"]', 0, 'fr'), /CHECK|constraint/i);
  ins(VISITOR, '["batch"]')();
  assert.throws(ins(VISITOR, '["batch"]'), /UNIQUE|PRIMARY|constraint/i, 'one ballot per visitor in round 2 as well');
  db.close();
});

// ---- the ballot box: api/votes.js POST ----------------------------------------------

test('cleanBallot (pure): reads five fields; a missing or bad visitor_id, a wrong round, a bad id set, or a ballot that is nothing is refused', () => {
  const good = cleanBallot(ballotOf());
  assert.deepEqual(good, { visitor: VISITOR, features: ['pdf-excel', 'watermark'], hasText: false, lang: 'id' });
  assert.equal(cleanBallot(ballotOf({ visitor_id: VISITOR.toUpperCase() })).visitor, VISITOR, 'lowercased: one voter, one spelling');
  assert.equal(cleanBallot(ballotOf({ visitor_id: undefined })), null, 'no visitor_id');
  assert.equal(cleanBallot(ballotOf({ visitor_id: null })), null);
  assert.equal(cleanBallot(ballotOf({ visitor_id: 'not-a-uuid' })), null);
  assert.equal(cleanBallot(ballotOf({ visitor_id: `${VISITOR}'; drop table feature_ballots_r2;--` })), null);
  assert.equal(cleanBallot(ballotOf({ features: ['nope'] })), null);
  assert.equal(cleanBallot(ballotOf({ features: ['crop'] })), null, 'a retired id');
  // ROUND 2: only the current round; a stale round-1 client (which sends no round) is not a ballot
  assert.equal(cleanBallot(ballotOf({ round: undefined })), null, 'no round: a round-1 client');
  assert.equal(cleanBallot(ballotOf({ round: 1 })), null, 'round 1 is closed');
  assert.equal(cleanBallot(ballotOf({ round: 3 })), null, 'a round that is not open');
  assert.equal(cleanBallot(ballotOf({ round: '2' })), null, 'a number, not a string');
  assert.equal(cleanBallot(ballotOf({ round: 2.5 })), null);
  assert.ok(cleanBallot(ballotOf({ round: 2 })), 'vacuity guard: round 2 itself is accepted');
  // ROUND 2: an option that is not up for a vote cannot be on a ballot, whatever the client says
  for (const id of ['pdf-word', 'canvas-image', 'save-edits']) {
    assert.equal(cleanBallot(ballotOf({ features: [id] })), null, `${id} is badged`);
    assert.equal(cleanBallot(ballotOf({ features: ['batch', id] })), null, `${id} in an otherwise good ballot`);
    assert.equal(cleanBallot(ballotOf({ features: [id], has_text: true })), null, `${id} with an idea attached`);
  }
  assert.deepEqual(cleanBallot(ballotOf({ features: ['batch'] })).features, ['batch'], 'the new option is pickable');
  assert.equal(cleanBallot(ballotOf({ features: ['pdf-excel', 'watermark', 'camera-scan', 'lock-unlock'] })), null, 'four');
  assert.equal(cleanBallot(ballotOf({ features: ['pdf-excel', 'pdf-excel'] })), null, 'a duplicate');
  assert.equal(cleanBallot(ballotOf({ features: 'pdf-excel' })), null);
  assert.equal(cleanBallot(ballotOf({ has_text: 'yes' })), null, 'has_text is a boolean');
  assert.equal(cleanBallot(ballotOf({ features: [], has_text: false })), null, 'a ballot is a choice or an idea, never nothing');
  assert.deepEqual(cleanBallot(ballotOf({ features: [], has_text: true })).features, [], 'an idea alone is a ballot');
  assert.equal(cleanBallot(ballotOf({ lang: 'fr' })).lang, null);
  assert.equal(cleanBallot(null), null);
  assert.equal(cleanBallot([]), null);
  assert.equal(cleanBallot('x'), null);
});

sqliteTest('BALLOT: the first lands (200) as ONE row; the second from the same visitor is 409 and changes NOTHING, whatever it asks for', async () => {
  const db = freshDb();
  const log = [];
  setDb(dbSeam(db, log));
  try {
    const first = await castBallot(ballotOf());
    assert.equal(first.code, 200);
    assert.deepEqual(first.body, { ok: true });
    assert.equal(first.headers['cache-control'], 'no-store');
    const row = db.prepare('select * from feature_ballots_r2').get();
    assert.equal(row.visitor_id, VISITOR);
    assert.deepEqual(JSON.parse(row.features), ['pdf-excel', 'watermark']);
    assert.equal(row.has_text, 0);
    assert.equal(row.lang, 'id');
    assert.match(row.ts, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);

    const before = db.prepare('select * from feature_ballots_r2').all();
    for (const again of [
      ballotOf(),                                             // the same ballot twice
      ballotOf({ features: ['form-fill'] }),                  // a changed mind
      ballotOf({ features: ['camera-scan'], has_text: true }),
      ballotOf({ visitor_id: VISITOR.toUpperCase() }),         // the same visitor spelled differently
    ]) {
      const r = await castBallot(again);
      assert.equal(r.code, 409, JSON.stringify(again));
      assert.deepEqual(r.body, { ok: false, error: 'already_voted' });
    }
    assert.deepEqual(db.prepare('select * from feature_ballots_r2').all(), before, 'the table is byte-for-byte unchanged');

    // a DIFFERENT visitor is a different ballot (vacuity guard: the 409 is the key, not a global lock)
    const other = await castBallot(ballotOf({ visitor_id: VISITOR2, features: ['form-fill'] }));
    assert.equal(other.code, 200);
    assert.equal(db.prepare('select count(*) n from feature_ballots_r2').get().n, 2);

    // every statement was the ONE parameterised insert; no input ever became SQL
    assert.ok(log.every((c) => c.sql === BALLOT_SQL), 'only the ballot statement ran');
    assert.ok(!log.some((c) => c.sql.includes(VISITOR)), 'no value was spliced into SQL');
  } finally { setDb(null); db.close(); }
});

sqliteTest('ROUND 2: a visitor who voted in round 1 is asked again and their first round-2 ballot LANDS; round 1 is never written or changed', async () => {
  const db = freshDb();
  // VISITOR cast a round-1 ballot (the table the old endpoint wrote)
  db.prepare('insert into feature_ballots (visitor_id, lang, has_text, features) values (?,?,?,?)').run(VISITOR, 'id', 0, '["pdf-word","watermark"]');
  const r1Before = JSON.stringify(db.prepare('select * from feature_ballots').all());
  const log = [];
  setDb(dbSeam(db, log));
  try {
    const r = await castBallot(ballotOf({ features: ['form-fill', 'batch'] }));
    assert.equal(r.code, 200, 'not 409: the round-1 vote does not count against round 2');
    assert.deepEqual(JSON.parse(db.prepare('select features from feature_ballots_r2 where visitor_id = ?').get(VISITOR).features), ['form-fill', 'batch']);
    assert.equal(JSON.stringify(db.prepare('select * from feature_ballots').all()), r1Before, 'round 1 untouched');
    assert.equal((await castBallot(ballotOf({ features: ['watermark'] }))).code, 409, 'but round 2 is still one ballot per visitor');
    // the only statements that ran touched the r2 table
    assert.ok(log.every((c) => /feature_ballots_r2/.test(c.sql) && !/feature_ballots\b(?!_r2)/.test(c.sql)), 'no statement named the round-1 table');
  } finally { setDb(null); db.close(); }
});

sqliteTest('ROUND 2: a ballot without the round, with round 1, or naming a badged option is 400 and writes NOTHING to either table', async () => {
  const db = freshDb();
  setDb(dbSeam(db));
  try {
    for (const body of [
      ballotOf({ round: undefined }),                     // a stale round-1 tab
      ballotOf({ round: 1 }),
      ballotOf({ round: 3 }),
      ballotOf({ features: ['pdf-word'] }),               // being built: not pickable
      ballotOf({ features: ['batch', 'save-edits'] }),
      ballotOf({ features: ['canvas-image'], has_text: true }),
    ]) {
      const r = await castBallot(body);
      assert.equal(r.code, 400, JSON.stringify(body));
      assert.deepEqual(r.body, { ok: false, error: 'invalid' });
    }
    assert.equal(db.prepare('select count(*) n from feature_ballots_r2').get().n, 0);
    assert.equal(db.prepare('select count(*) n from feature_ballots').get().n, 0);
    // vacuity guard: the same body with a good round and a pickable option lands
    assert.equal((await castBallot(ballotOf({ features: ['batch'] }))).code, 200);
  } finally { setDb(null); db.close(); }
});

sqliteTest('BALLOT: the DATABASE itself refuses a second ballot and a malformed row, with no help from the endpoint (the table is the lock)', () => {
  const db = freshDb();
  const ins = (visitor, features, has_text = 0, lang = 'id') => db.prepare(
    'insert into feature_ballots_r2 (visitor_id, lang, has_text, features) values (?,?,?,?)').run(visitor, lang, has_text, features);
  ins(VISITOR, '["pdf-excel"]');
  assert.throws(() => ins(VISITOR, '["watermark"]'), /UNIQUE|PRIMARY|constraint/i, 'a plain second insert is refused by the primary key');
  assert.throws(() => ins('not-a-uuid', '["pdf-excel"]'), /CHECK|constraint/i, 'visitor_id shape');
  assert.throws(() => ins(VISITOR.toUpperCase(), '["pdf-excel"]'), /CHECK|constraint/i, 'lowercase only: no second spelling of one voter');
  assert.throws(() => ins(VISITOR2, '["a","b","c","d"]'), /CHECK|constraint/i, 'more than 3');
  assert.throws(() => ins(VISITOR2, '{}'), /CHECK|constraint/i, 'not an array');
  assert.throws(() => ins(VISITOR2, '[]', 0), /CHECK|constraint/i, 'a ballot is a choice or an idea');
  assert.throws(() => ins(VISITOR2, '["pdf-excel"]', 2), /CHECK|constraint/i, 'has_text is 0 or 1');
  assert.throws(() => ins(VISITOR2, '["pdf-excel"]', 0, 'fr'), /CHECK|constraint/i, 'lang');
  ins(VISITOR2, '[]', 1); // an idea alone is allowed
  assert.equal(db.prepare('select count(*) n from feature_ballots_r2').get().n, 2);
  db.close();
});

sqliteTest('BALLOT: invalid requests are 400 and write nothing; no visitor_id means no ballot', async () => {
  const db = freshDb();
  setDb(dbSeam(db));
  try {
    for (const body of [
      ballotOf({ visitor_id: undefined }),
      ballotOf({ visitor_id: 'x' }),
      ballotOf({ features: ['nope'] }),
      ballotOf({ features: ['pdf-excel', 'watermark', 'camera-scan', 'lock-unlock'] }),
      ballotOf({ features: [], has_text: false }),
      'not json at all',
      '{"visitor_id":',
      [],
      'x'.repeat(5000), // over the 2 KB cap
    ]) {
      const r = await castBallot(body);
      assert.equal(r.code, 400, typeof body === 'string' ? body.slice(0, 20) : JSON.stringify(body));
      assert.deepEqual(r.body, { ok: false, error: 'invalid' });
    }
    assert.equal(db.prepare('select count(*) n from feature_ballots_r2').get().n, 0);
    const put = mkRes();
    await votesHandler({ method: 'PUT', on() { return this; } }, put);
    assert.equal(put.code, 405);
  } finally { setDb(null); db.close(); }
});

sqliteTest('BALLOT: a REFUSED write is 503 and never "recorded" (no table, a constraint the endpoint did not foresee)', async () => {
  // the migration has not been applied: the database has no such table
  const empty = new sqlite.DatabaseSync(':memory:');
  setDb(dbSeam(empty));
  const errors = []; const realErr = console.error; console.error = (...a) => errors.push(a.join(' '));
  try {
    const r = await castBallot(ballotOf());
    assert.equal(r.code, 503);
    assert.deepEqual(r.body, { ok: false, error: 'unavailable' });
    assert.ok(errors.some((e) => /\[votes\] ballot insert FAILED/.test(e)), 'logged');
    assert.ok(!errors.join('\n').includes(VISITOR), 'content-blind: the visitor id never reaches a log');
  } finally { console.error = realErr; setDb(null); empty.close(); }
});

test('BALLOT: Turso answers HTTP 200 with a refused statement INSIDE the body; that is a 503, not a success (api/_turso.js gates)', async () => {
  const real = globalThis.fetch;
  const saved = { u: process.env.TURSO_FEEDBACK_URL, t: process.env.TURSO_FEEDBACK_TOKEN };
  process.env.TURSO_FEEDBACK_URL = 'libsql://fb.turso.io'; process.env.TURSO_FEEDBACK_TOKEN = 't';
  const reply = (results) => async () => ({ ok: true, status: 200, json: async () => ({ results }) });
  const close = { type: 'ok', response: { type: 'close' } };
  const errors = []; const realErr = console.error; console.error = (...a) => errors.push(a.join(' '));
  try {
    // gate 2: the statement was refused, inside a 200
    globalThis.fetch = reply([{ type: 'error', error: { message: `SQLite error: CHECK constraint failed: ${VISITOR}`, code: 'SQLITE_CONSTRAINT' } }, close]);
    let r = await castBallot(ballotOf());
    assert.equal(r.code, 503, 'HTTP 200 with a statement error is NOT a recorded ballot');
    assert.ok(errors.some((e) => /error=sql_SQLITE_CONSTRAINT/.test(e)), 'the code is logged');
    assert.ok(!errors.join('\n').includes(VISITOR), 'the error MESSAGE (which quotes the row) is never logged');
    // gate 3: the statement ran and wrote 0 rows: the visitor has already voted
    globalThis.fetch = reply([{ type: 'ok', response: { type: 'execute', result: { affected_row_count: 0, rows: [], cols: [] } } }, close]);
    r = await castBallot(ballotOf());
    assert.equal(r.code, 409);
    // the happy path, for contrast (vacuity guard)
    globalThis.fetch = reply([{ type: 'ok', response: { type: 'execute', result: { affected_row_count: 1, rows: [], cols: [] } } }, close]);
    r = await castBallot(ballotOf());
    assert.equal(r.code, 200);
    // gate 1: transport
    globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
    r = await castBallot(ballotOf());
    assert.equal(r.code, 503);
    // a network failure
    globalThis.fetch = async () => { throw new Error('offline'); };
    r = await castBallot(ballotOf());
    assert.equal(r.code, 503);
  } finally {
    console.error = realErr; globalThis.fetch = real;
    for (const [k, v] of [['TURSO_FEEDBACK_URL', saved.u], ['TURSO_FEEDBACK_TOKEN', saved.t]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('BALLOT: with no database configured at all it is 503, never a silent success', async () => {
  const saved = { u: process.env.TURSO_FEEDBACK_URL, t: process.env.TURSO_FEEDBACK_TOKEN };
  delete process.env.TURSO_FEEDBACK_URL; delete process.env.TURSO_FEEDBACK_TOKEN;
  const realErr = console.error; console.error = () => {};
  try {
    assert.equal((await castBallot(ballotOf())).code, 503);
  } finally {
    console.error = realErr;
    for (const [k, v] of [['TURSO_FEEDBACK_URL', saved.u], ['TURSO_FEEDBACK_TOKEN', saved.t]]) { if (v !== undefined) process.env[k] = v; }
  }
});

// ---- the counts: api/votes.js GET --------------------------------------------------

sqliteTest('votes SQL on the real table: one ballot per visitor, each feature counted once per ballot, text-only ballots are not voters', () => {
  const db = freshDb();
  const ins = db.prepare('insert into feature_ballots_r2 (visitor_id, has_text, features) values (?,?,?)');
  const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  ins.run(uid(1), 0, JSON.stringify(['pdf-excel', 'watermark', 'camera-scan']));
  ins.run(uid(2), 0, JSON.stringify(['pdf-excel', 'lock-unlock']));
  ins.run(uid(3), 0, JSON.stringify(['pdf-excel']));
  ins.run(uid(4), 1, '[]'); // text-only
  const got = Object.fromEntries(db.prepare(VOTES_SQL).all().map((r) => [r.k, r.n]));
  assert.deepEqual(got, { voters: 3, 'pdf-excel': 3, watermark: 1, 'camera-scan': 1, 'lock-unlock': 1 });
  db.close();
});

sqliteTest('ROUND 2 counts: round-1 rows in feature_ballots are NEVER counted (no double count), only the r2 box is read', async () => {
  const db = freshDb();
  const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const r1 = db.prepare('insert into feature_ballots (visitor_id, has_text, features) values (?,?,?)');
  const r2 = db.prepare('insert into feature_ballots_r2 (visitor_id, has_text, features) values (?,?,?)');
  for (let i = 1; i <= 30; i += 1) r1.run(uid(i), 0, JSON.stringify(['pdf-word', 'watermark'])); // round 1: 30 voters
  for (let i = 1; i <= 12; i += 1) r2.run(uid(i), 0, JSON.stringify(i <= 8 ? ['batch'] : ['form-fill', 'watermark'])); // the SAME visitors, round 2
  const got = Object.fromEntries(db.prepare(VOTES_SQL).all().map((r) => [r.k, r.n]));
  assert.deepEqual(got, { voters: 12, batch: 8, 'form-fill': 4, watermark: 4 }, 'round 2 only: 12 voters, round 1\'s 30 and its pdf-word are absent');
  setDb(dbSeam(db));
  try {
    const res = mkRes();
    await votesHandler({ method: 'GET' }, res);
    const body = JSON.parse(res.body);
    assert.equal(body.voters, 12);
    assert.equal(body.counts.batch, 8);
    assert.equal(body.counts['pdf-word'], 0, 'a badged option has no round-2 votes, whatever round 1 said');
    assert.equal(body.counts.watermark, 4);
  } finally { setDb(null); db.close(); }
});

sqliteTest('votes SQL is not vacuous: zero voters on an empty box, and the shaper then withholds', () => {
  const db = freshDb();
  const rows = db.prepare(VOTES_SQL).all().map((r) => [r.k, r.n]);
  assert.deepEqual(Object.fromEntries(rows), { voters: 0 });
  assert.equal(shapeVotes(rows), null);
  db.close();
});

test('shapeVotes: under MIN_VOTERS nothing is shown; above it the counts, with retired ids ignored', () => {
  assert.equal(MIN_VOTERS, 10);
  assert.equal(shapeVotes([['voters', 9], ['pdf-word', 9]]), null, 'a top 3 from nine ballots is noise');
  const out = shapeVotes([['voters', 10], ['pdf-word', 7], ['watermark', 3], ['retired-feature', 99], ['crop', 4]]);
  assert.equal(out.voters, 10);
  assert.equal(out.counts['pdf-word'], 7);
  assert.equal(out.counts.watermark, 3);
  assert.equal(out.counts['lock-unlock'], 0, 'every current feature is present, zero if unvoted');
  assert.ok(!('retired-feature' in out.counts) && !('crop' in out.counts));
  assert.equal(shapeVotes([['voters', 'x']]), null);
  assert.equal(shapeVotes([['voters', 12], ['watermark', NaN]]), null, 'a garbage cell never becomes a ranking');
});

sqliteTest('GET /api/votes: aggregates only (never a visitor_id, a row or idea text), cached; a failure is {voters:null} with a short cache', async () => {
  const db = freshDb();
  const ins = db.prepare('insert into feature_ballots_r2 (visitor_id, has_text, features) values (?,?,?)');
  for (let i = 1; i <= 12; i += 1) ins.run(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, 0, JSON.stringify(i % 3 ? ['pdf-excel'] : ['watermark', 'form-fill']));
  const fr = db.prepare('insert into feature_requests (session_id, app_version, features, note) values (?,?,?,?)');
  fr.run(SESSION, 'abc1234', '[]', 'RAHASIA catatan pribadi');
  setDb(dbSeam(db));
  try {
    const good = mkRes();
    await votesHandler({ method: 'GET' }, good);
    assert.equal(good.code, 200);
    assert.match(good.headers['cache-control'], /s-maxage=600/);
    const body = JSON.parse(good.body);
    assert.equal(body.voters, 12);
    assert.equal(body.counts['pdf-excel'], 8);
    assert.equal(body.counts.watermark, 4);
    assert.deepEqual(Object.keys(body).sort(), ['counts', 'voters']);
    assert.doesNotMatch(good.body, /visitor|session|RAHASIA|[0-9a-f]{8}-[0-9a-f]{4}/);

    setDb(async () => { throw new Error('boom'); });
    const bad = mkRes();
    await votesHandler({ method: 'GET' }, bad);
    assert.equal(bad.code, 200);
    assert.deepEqual(JSON.parse(bad.body), { voters: null, counts: null });
    assert.match(bad.headers['cache-control'], /s-maxage=60$/);
  } finally { setDb(null); db.close(); }
});

// ---- the card's own pure part ------------------------------------------------------

test('topThree: most votes first, ties in list order, zeros never shown, garbage is empty', () => {
  const counts = Object.fromEntries(FEATURE_IDS.map((id) => [id, 0]));
  assert.deepEqual(topThree(counts), [], 'nothing voted: nothing to rank');
  assert.deepEqual(topThree({ ...counts, watermark: 5, 'pdf-word': 5, 'lock-unlock': 9, 'form-fill': 1 }), ['lock-unlock', 'pdf-word', 'watermark']);
  assert.deepEqual(topThree({ ...counts, watermark: 2 }), ['watermark'], 'fewer than three is fine');
  assert.deepEqual(topThree(null), []);
  assert.deepEqual(topThree({ watermark: 'many' }), []);
});

test('the storage rows the code writes are the ones /privasi lists', () => {
  const mem = read('js/v2/vote-memory.js');
  const privasi = read('privasi.html');
  for (const key of ['pdflokal_vote_done', 'pdflokal_vote_nanti', 'pdflokal_vote_ids', 'pdflokal_vote_told']) {
    assert.ok(mem.includes(`'${key}'`), `${key} is written by vote-memory.js`);
    assert.ok(privasi.includes(`<code>${key}</code>`), `${key} has a row in /privasi`);
  }
  assert.ok(!read('js/v2/feature-vote.js').includes('export_count'), 'v1\'s download counter is gone: the offer follows every download now');
});

test('the vote is one concern in the files that matter: whole-document only, and the share card is still reachable', () => {
  const app = read('js/v2/app.js');
  assert.match(app, /celebration\.onDownloadSuccess\(\{ whole \}\)/);
  // The DEFAULT is the rule: a caller that says nothing (Ekstrak, every path
  // outside the Unduh sheet) is not a whole-document download. With
  // `{ whole = true } = {}` every subset download would offer the vote and the
  // checks below stayed green.
  assert.match(app, /^function download\(blob, filename, \{ whole = false \} = \{\}\) \{$/m,
    'download() defaults `whole` to false');
  const sheet = read('js/v2/download-sheet.js');
  assert.equal([...sheet.matchAll(/deps\.download\(/g)].length, 3);
  assert.equal([...sheet.matchAll(/\{ whole: !state\.picked \}/g)].length, 3, 'every download from the Unduh sheet says whether it was the whole document');
  assert.ok(!/download\(new Blob\(\[bytes\][^;]*whole/.test(app), 'Ekstrak (a subset) never says whole');
});

test('no usable visitor_id: telemetry says so, the offer is gated on it, and the send path never submits a ballot without one', () => {
  const tel = read('js/v2/telemetry.js');
  assert.match(tel, /export function hasVisitorId\(\) \{ return visitorId !== null; \}/);
  const fv = read('js/v2/feature-vote.js');
  const gate = fv.indexOf('telemetry.hasVisitorId?.() === false) return false;');
  assert.ok(gate > fv.indexOf('maybeShow('), 'maybeShow refuses to invite without a visitor_id');
  assert.match(fv, /noVisitor \? 'no-visitor' : await/, 'send() skips the ballot without a visitor_id');
  // The exact branch, not two indexOf positions: with the guard rewritten as
  // `if (result !== 'failed')`, indexOf("result === 'recorded'") was -1 and
  // -1 < anything passed. Now the recorded-only branch must exist verbatim.
  assert.ok(fv.indexOf('rememberVote(ids)') >= 0, 'VACUITY: send() still remembers ids somewhere');
  assert.match(fv, /if \(result === 'recorded'\) \{\s*tel\('feature_vote', [^\n]*\n\s*rememberVote\(ids\);\s*\}/,
    'ids are remembered only inside the `result === \'recorded\'` branch');
  assert.equal([...fv.matchAll(/rememberVote\(ids\)/g)].length, 1, 'exactly one place remembers ids');
  assert.ok(!/else\s*\{[^}]*rememberVote\(ids\)/.test(fv), 'no other branch remembers ids');
});

test('TIMING: the offer opens at once (no stamp delay, no waiting for other cards) and replaces the share card for that download', () => {
  const fv = read('js/v2/feature-vote.js');
  assert.ok(!/SHOW_DELAY_MS|MAX_WAIT_MS|POLL_MS/.test(fv), 'the 4.4s stamp wait and the 25s card wait are gone');
  assert.match(fv, /if \(document\.querySelector\(OCCUPANTS\)\) return false;/, 'another card up: not offered, never queued');
  assert.match(fv, /dialog\[open\]:not\(#dl-sheet\)/, 'the Unduh sheet that is closing is not an occupant');
  const cel = read('js/v2/celebrate.js');
  const vote = cel.indexOf('featureVote.maybeShow(');
  const share = cel.indexOf("LAST_SHOWN_KEY, new Date().toDateString()");
  assert.ok(vote > 0 && vote < share, 'the vote is asked before the share card is scheduled, and its true return skips it');
  assert.match(cel, /featureVote\.maybeShow\([^)]*\)\) \{\s*return;/, 'taking the moment ends onDownloadSuccess: the share/tip card does not show');
});
