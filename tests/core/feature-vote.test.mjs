/*
 * THE FEATURE VOTE (founder ruling 2026-10-02), headless: the list, the rules,
 * the rail event, the aggregation, the free-text idea and the watch's separation.
 * ============================================================================
 * What each group exists to catch, so none of them can pass by looking at nothing:
 *   - the list:      an id renamed, duplicated or added without its checkbox
 *   - the rules:     more than 3, an unknown id, a duplicate: each must fail the
 *                    WHOLE vote on every layer that takes one (schema, feedback)
 *   - the trigger:   the card must wait for the SECOND download and never share a
 *                    session with the share/tip card (pure shouldOfferVote)
 *   - aggregation:   api/votes.js's REAL SQL, run on a real SQLite, one vote per
 *                    feature per visitor, latest vote wins, synthetic sessions out
 *   - the idea:      stored tagged, rating 'up', never with images; kept OUT of the
 *                    thumbs counts and the "new feedback" email
 * The SQLite-backed groups need node:sqlite (Node 22.13+); on an older Node they
 * are reported as skipped, loudly, rather than passing by omission.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FEATURES, FEATURE_IDS, GROUPS, MAX_VOTES, MIN_DOWNLOADS, cleanVote, shouldOfferVote,
} from '../../js/core/features.js';
import { validateEvent } from '../../js/core/telemetry-schema.js';
import tHandler, { __setQueryForTests as setTQuery } from '../../api/t.js';
import fbHandler, { __setQueryForTests as setFbQuery } from '../../api/feedback.js';
import votesHandler, { VOTES_SQL, shapeVotes, MIN_VOTERS } from '../../api/votes.js';
import { topThree } from '../../js/v2/feature-vote.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch { /* skipped below, by name */ }
const sqliteTest = (name, fn) => test(name, { skip: sqlite ? false : 'node:sqlite unavailable on this Node' }, fn);

// ---- the list ---------------------------------------------------------------

test('the list: 14 features, unique stable ids, two groups, 4 conversions + 10 tools', () => {
  assert.equal(FEATURES.length, 14);
  assert.equal(new Set(FEATURE_IDS).size, 14, 'ids are unique');
  for (const id of FEATURE_IDS) assert.match(id, /^[a-z]+(-[a-z]+)*$/, `${id}: ids are lowercase-kebab, never labels`);
  assert.deepEqual(GROUPS, ['konversi', 'alat']);
  assert.equal(FEATURES.filter((f) => f.group === 'konversi').length, 4);
  assert.equal(FEATURES.filter((f) => f.group === 'alat').length, 10);
  assert.equal(MAX_VOTES, 3);
  assert.ok(Object.isFrozen(FEATURES) && Object.isFrozen(FEATURES[0]), 'a vote cannot be bent by editing the list at runtime');
});

test('the list and index.html are the same set, in the same groups and order', () => {
  const html = read('index.html');
  const dlg = html.match(/<dialog id="fv-form"[\s\S]*?<\/dialog>/)?.[0];
  assert.ok(dlg, 'the #fv-form dialog is in index.html (vacuity guard)');
  for (const group of GROUPS) {
    const fieldset = dlg.match(new RegExp(`<fieldset class="fv-group">\\s*<legend>${group === 'konversi' ? 'Konversi' : 'Alat'}</legend>([\\s\\S]*?)</fieldset>`))?.[1];
    assert.ok(fieldset, `fieldset for ${group}`);
    const ids = [...fieldset.matchAll(/<input type="checkbox" name="feature" value="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids, FEATURES.filter((f) => f.group === group).map((f) => f.id), `${group}: checkboxes == list`);
  }
});

test('the founder-drafted labels are on the page, in Indonesian and in /en English, with no em dash', () => {
  const id = {
    'pdf-word': ['PDF ke Word', 'PDF to Word'], 'pdf-excel': ['PDF ke Excel', 'PDF to Excel'],
    'pdf-ppt': ['PDF ke PowerPoint', 'PDF to PowerPoint'], 'word-pdf': ['Word ke PDF', 'Word to PDF'],
    'form-fill': ['Isi formulir PDF', 'Fill PDF forms'], 'camera-scan': ['Scan pakai kamera HP', 'Scan with phone camera'],
    'canvas-image': ['Tempel gambar di halaman', 'Put images on a page'], redact: ['Sensor permanen', 'Permanent redaction'],
    watermark: ['Watermark', 'Watermark'], 'page-numbers': ['Nomor halaman', 'Page numbers'],
    lock: ['Kunci PDF dengan password', 'Lock PDF with a password'], batch: ['Banyak file sekaligus', 'Many files at once'],
    crop: ['Potong halaman', 'Crop pages'], grayscale: ['Hitam putih', 'Black and white'],
  };
  const idHtml = read('index.html');
  const enHtml = read('en/index.html');
  for (const [fid, [idLabel, enLabel]] of Object.entries(id)) {
    assert.ok(idHtml.includes(`value="${fid}"><span>${idLabel}</span>`), `${fid}: Indonesian label`);
    assert.ok(enHtml.includes(`value="${fid}"><span>${enLabel}</span>`), `${fid}: English label on /en`);
    assert.ok(!/[—–]/.test(idLabel + enLabel));
  }
  for (const s of ['Fitur apa yang paling kamu butuh?', 'Pilih maksimal 3', 'Belum ada di sini? Tulis aja', 'Usulkan fitur']) assert.ok(idHtml.includes(s), s);
  for (const s of ['Which feature do you need most?', 'Pick up to 3', 'Not listed? Write it', 'Suggest a feature']) assert.ok(enHtml.includes(s), s);
});

test('the menu link is in BOTH the desktop nav and the mobile drawer, on / and /en', () => {
  for (const f of ['index.html', 'en/index.html']) {
    const html = read(f);
    const nav = html.match(/<nav class="ld-nav"[\s\S]*?<\/nav>/)[0];
    const drawer = html.match(/<div class="ld-burger-menu"[\s\S]*?<div class="ld-burger-lang">/)[0];
    assert.match(nav, /data-feature-vote-open/, `${f}: desktop nav`);
    assert.match(drawer, /data-feature-vote-open/, `${f}: mobile drawer`);
  }
});

// ---- the rules --------------------------------------------------------------

test('cleanVote: a valid vote passes; empty is allowed (a text-only idea)', () => {
  assert.deepEqual(cleanVote(['pdf-word']), { ok: true, ids: ['pdf-word'] });
  assert.deepEqual(cleanVote(['pdf-word', 'watermark', 'crop']), { ok: true, ids: ['pdf-word', 'watermark', 'crop'] });
  assert.deepEqual(cleanVote([]), { ok: true, ids: [] });
});

test('cleanVote: a bad id, more than 3, a duplicate, or a non-array fails the WHOLE vote', () => {
  assert.equal(cleanVote(['pdf-word', 'nope']).ok, false, 'unknown id');
  assert.equal(cleanVote(['PDF-WORD']).ok, false, 'ids are exact');
  assert.equal(cleanVote(['pdf-word', 'watermark', 'crop', 'lock']).ok, false, 'four');
  assert.equal(cleanVote(['pdf-word', 'pdf-word']).ok, false, 'duplicate');
  assert.equal(cleanVote('pdf-word').ok, false);
  assert.equal(cleanVote(null).ok, false);
  assert.equal(cleanVote([1]).ok, false);
  assert.equal(cleanVote([{ id: 'pdf-word' }]).ok, false);
  assert.equal(cleanVote(['__proto__']).ok, false);
});

// ---- the trigger (pure) -----------------------------------------------------

test('TRIGGER: not on the first download, yes on the second, and across visits (the count is persisted)', () => {
  assert.equal(MIN_DOWNLOADS, 2);
  const base = { state: null, supportShownThisSession: false };
  assert.equal(shouldOfferVote({ ...base, downloads: 0 }), false);
  assert.equal(shouldOfferVote({ ...base, downloads: 1 }), false, 'the first download is never the moment');
  assert.equal(shouldOfferVote({ ...base, downloads: 2 }), true);
  assert.equal(shouldOfferVote({ ...base, downloads: 7 }), true, 'a missed second (share card took it) is offered later');
  assert.equal(shouldOfferVote({ ...base, downloads: NaN }), false);
  assert.equal(shouldOfferVote({ ...base, downloads: '2' }), false, 'a string is not a count');
});

test('TRIGGER: never in a session where the share/tip card already spoke, never after a vote or a dismiss', () => {
  const due = { downloads: 5, state: null, supportShownThisSession: false };
  assert.equal(shouldOfferVote(due), true, 'control: due');
  assert.equal(shouldOfferVote({ ...due, supportShownThisSession: true }), false);
  assert.equal(shouldOfferVote({ ...due, state: 'voted' }), false);
  assert.equal(shouldOfferVote({ ...due, state: 'dismissed' }), false);
});

// ---- the rail event ---------------------------------------------------------

test('feature_vote schema: valid shapes pass, bad id / >3 / duplicate / wrong type / extra prop fail', () => {
  const ok = (p) => validateEvent('feature_vote', p).ok;
  assert.equal(ok({ features: ['pdf-word', 'lock'], has_text: false }), true);
  assert.equal(ok({ features: [], has_text: true }), true);
  assert.deepEqual(validateEvent('feature_vote', { features: ['crop'], has_text: true }).clean, { features: ['crop'], has_text: true });
  assert.equal(ok({ features: ['nope'], has_text: false }), false, 'bad id');
  assert.equal(ok({ features: ['pdf-word', 'watermark', 'crop', 'lock'], has_text: false }), false, '>3');
  assert.equal(ok({ features: ['crop', 'crop'], has_text: false }), false, 'duplicates');
  assert.equal(ok({ features: 'crop', has_text: false }), false, 'a string is not a set');
  assert.equal(ok({ features: ['crop'] }), false, 'has_text is required');
  assert.equal(ok({ features: ['crop'], has_text: 'yes' }), false);
  assert.equal(ok({ features: ['crop'], has_text: false, note: 'free text' }), false, 'no free string, ever, on the rail');
  assert.equal(ok({ features: [{ id: 'crop' }], has_text: false }), false);
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

test('api/t.js: a valid vote is written with its ids and the visitor; bad ones are never written', async () => {
  const good = await postVote({ features: ['pdf-word', 'watermark'], has_text: true });
  assert.equal(good.res.code, 204);
  assert.equal(good.calls.length, 1, 'a valid vote reaches the insert');
  const [ts, session, , event, props, visitor] = good.calls[0].params;
  assert.ok(ts && session === SESSION && event === 'feature_vote');
  assert.deepEqual(JSON.parse(props), { features: ['pdf-word', 'watermark'], has_text: true });
  assert.equal(visitor, VISITOR, 'the visitor id rides along: it is what the dedupe keys on');

  for (const bad of [
    { features: ['not-a-feature'], has_text: false },
    { features: ['pdf-word', 'watermark', 'crop', 'lock'], has_text: false },
    { features: ['crop', 'crop'], has_text: false },
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
    kind: 'feature_request', features: ['pdf-word', 'crop'], note: '  tolong tambah OCR  ', visitor_id: VISITOR, lang: 'en',
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
  assert.deepEqual(JSON.parse(p[FR.features]), ['pdf-word', 'crop']);
  assert.equal(p[FR.note], 'tolong tambah OCR', 'trimmed, and untagged: no prefix trick any more');
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
    { kind: 'feature_request', features: ['pdf-word'] },
    { kind: 'feature_request', features: ['pdf-word'], note: '   ' },
    { kind: 'feature_request', features: ['nope'], note: 'x' },
    { kind: 'feature_request', features: ['pdf-word', 'watermark', 'crop', 'lock'], note: 'x' },
    { kind: 'feature_request', features: ['crop', 'crop'], note: 'x' },
    { kind: 'feature_request', features: 'crop', note: 'x' },
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

sqliteTest('the migration: idempotent, and the REAL insert from api/feedback.js lands in feature_requests with feedback left empty', async () => {
  const db = new sqlite.DatabaseSync(':memory:');
  const migration = read('scripts/turso-feedback-migration.sql');
  db.exec(migration);
  db.exec(migration); // CREATE ... IF NOT EXISTS: running it twice is a no-op, not an error
  const { calls } = await postFeedback({ kind: 'feature_request', features: ['pdf-word', 'crop'], note: 'tolong tambah OCR', visitor_id: VISITOR, lang: 'id' });
  assert.equal(calls.length, 1);
  db.prepare(calls[0].text).run(...calls[0].params); // the very statement the endpoint sends
  assert.equal(db.prepare('select count(*) n from feature_requests').get().n, 1);
  assert.equal(db.prepare('select count(*) n from feedback').get().n, 0, 'the thumbs table is untouched');
  const row = db.prepare('select * from feature_requests').get();
  assert.equal(row.note, 'tolong tambah OCR');
  assert.deepEqual(JSON.parse(row.features), ['pdf-word', 'crop']);
  // The table's own checks are real (vacuity guard): a 4-id array and an empty note are refused.
  const bad = (features, note) => () => db.prepare(
    'insert into feature_requests (session_id, app_version, features, note) values (?,?,?,?)').run(SESSION, 'abc1234', features, note);
  assert.throws(bad('["a","b","c","d"]', 'x'));
  assert.throws(bad('[]', ''));
  assert.throws(bad('{}', 'x'));
  db.close();
});

// ---- api/votes.js: the aggregation ---------------------------------------------------

const MARKER = '00000000-0000-4000-8000-00000000c0de';
function railDb() {
  const db = new sqlite.DatabaseSync(':memory:');
  db.exec('create table events (id integer primary key autoincrement, ts text, session_id text, event text, props text, visitor_id text)');
  const ins = db.prepare('insert into events (ts, session_id, event, props, visitor_id) values (?, ?, ?, ?, ?)');
  const vote = (visitor, features, { session = `s-${visitor}`, event = 'feature_vote', has_text = false } = {}) =>
    ins.run('2026-10-02T00:00:00.000Z', session, event, JSON.stringify({ features, has_text }), visitor);
  return { db, vote, ins };
}
const run = (db) => db.prepare(VOTES_SQL).all(MARKER).map((r) => [r.k, r.n]);

sqliteTest('votes SQL: one vote per feature per visitor, the LATEST vote wins, synthetic sessions and other events are out', () => {
  const { db, vote, ins } = railDb();
  vote('A', ['pdf-word', 'watermark', 'crop']);
  vote('A', ['lock']);                                   // A changes their mind: only this counts
  vote('A', ['lock']);                                   // and re-sending does not stack
  vote('B', ['pdf-word', 'lock']);
  vote('C', ['pdf-word']);
  vote('D', [], { has_text: true });                     // text-only: not a voter, no feature
  vote('E', ['crop'], { session: MARKER });              // the synthetic session is excluded
  ins.run('2026-10-02T00:00:00.000Z', 's-F', 'export', JSON.stringify({ features: ['crop'] }), 'F'); // other events ignored
  const got = Object.fromEntries(run(db));
  assert.deepEqual(got, { voters: 3, lock: 2, 'pdf-word': 2 });
  db.close();
});

sqliteTest('votes SQL: a browser with no visitor_id falls back to its session, and is deduped on it', () => {
  const { db, ins } = railDb();
  const raw = (session, features) => ins.run('2026-10-02T00:00:00.000Z', session, 'feature_vote', JSON.stringify({ features, has_text: false }), null);
  raw('s1', ['crop']);
  raw('s1', ['crop', 'lock']);   // the same page load, again: latest wins
  raw('s2', ['crop']);
  const got = Object.fromEntries(run(db));
  assert.deepEqual(got, { voters: 2, crop: 2, lock: 1 });
  db.close();
});

sqliteTest('votes SQL is not vacuous: it reports zero voters on an empty rail, and the shaper then withholds', () => {
  const { db } = railDb();
  assert.deepEqual(Object.fromEntries(run(db)), { voters: 0 });
  assert.equal(shapeVotes(run(db)), null);
  db.close();
});

test('shapeVotes: under MIN_VOTERS nothing is shown; above it the counts, with retired ids ignored', () => {
  assert.equal(MIN_VOTERS, 10);
  assert.equal(shapeVotes([['voters', 9], ['pdf-word', 9]]), null, 'a top 3 from nine votes is noise');
  const out = shapeVotes([['voters', 10], ['pdf-word', 7], ['crop', 3], ['retired-feature', 99]]);
  assert.equal(out.voters, 10);
  assert.equal(out.counts['pdf-word'], 7);
  assert.equal(out.counts.crop, 3);
  assert.equal(out.counts.lock, 0, 'every current feature is present, zero if unvoted');
  assert.ok(!('retired-feature' in out.counts));
  assert.equal(shapeVotes([['voters', 'x']]), null);
  assert.equal(shapeVotes([['voters', 12], ['crop', NaN]]), null, 'a garbage cell never becomes a ranking');
});

test('api/votes.js: GET only; cached at the CDN; failure answers {voters:null} with a short cache and no data', async () => {
  const post = mkRes();
  await votesHandler({ method: 'POST' }, post);
  assert.equal(post.code, 405);

  const real = globalThis.fetch;
  const saved = { u: process.env.TURSO_EVENTS_URL, t: process.env.TURSO_EVENTS_TOKEN };
  process.env.TURSO_EVENTS_URL = 'libsql://ev.turso.io'; process.env.TURSO_EVENTS_TOKEN = 't';
  const cell = (type, value) => ({ type, value: String(value) });
  const reply = (rows) => ({ ok: true, status: 200, json: async () => ({ results: [
    { type: 'ok', response: { type: 'execute', result: { cols: [{ name: 'k' }, { name: 'n' }], rows } } },
    { type: 'ok', response: { type: 'close' } }] }) });
  try {
    globalThis.fetch = async () => reply([[cell('text', 'voters'), cell('integer', 12)], [cell('text', 'pdf-word'), cell('integer', 8)], [cell('text', 'crop'), cell('integer', 3)]]);
    const good = mkRes();
    await votesHandler({ method: 'GET' }, good);
    assert.equal(good.code, 200);
    assert.match(good.headers['cache-control'], /s-maxage=600/);
    const body = JSON.parse(good.body);
    assert.equal(body.voters, 12);
    assert.equal(body.counts['pdf-word'], 8);
    // PRIVACY: aggregates only.
    assert.deepEqual(Object.keys(body).sort(), ['counts', 'voters']);
    assert.doesNotMatch(good.body, /visitor|session|[0-9a-f]{8}-[0-9a-f]{4}/);

    globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const bad = mkRes();
    await votesHandler({ method: 'GET' }, bad);
    assert.equal(bad.code, 200);
    assert.deepEqual(JSON.parse(bad.body), { voters: null, counts: null });
    assert.match(bad.headers['cache-control'], /s-maxage=60$/);
  } finally {
    globalThis.fetch = real;
    for (const [k, v] of [['TURSO_EVENTS_URL', saved.u], ['TURSO_EVENTS_TOKEN', saved.t]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// ---- the card's own pure part ------------------------------------------------------

test('topThree: most votes first, ties in list order, zeros never shown, garbage is empty', () => {
  const counts = Object.fromEntries(FEATURE_IDS.map((id) => [id, 0]));
  assert.deepEqual(topThree(counts), [], 'nothing voted: nothing to rank');
  assert.deepEqual(topThree({ ...counts, crop: 5, 'pdf-word': 5, lock: 9, watermark: 1 }), ['lock', 'pdf-word', 'crop']);
  assert.deepEqual(topThree({ ...counts, crop: 2 }), ['crop'], 'fewer than three is fine');
  assert.deepEqual(topThree(null), []);
  assert.deepEqual(topThree({ crop: 'many' }), []);
});

test('the two new storage keys are the ones the code writes (privasi.html lists them)', () => {
  const src = read('js/v2/feature-vote.js');
  const privasi = read('privasi.html');
  for (const key of ['pdflokal_export_count', 'pdflokal_vote_done']) {
    assert.ok(src.includes(`'${key}'`), `${key} is written by feature-vote.js`);
    assert.ok(privasi.includes(`<code>${key}</code>`), `${key} has a row in /privasi`);
  }
});
