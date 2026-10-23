/*
 * PDFLokal — api/votes.js  (THE FEATURE VOTE'S BALLOT BOX: one ballot per visitor, and the counts)
 * ============================================================================
 * The feature vote's server side (founder rulings 2026-10-02 and 2026-10-06; the
 * list and the rules are js/core/features.js).
 *
 *   POST /api/votes  {visitor_id, features:[ids], has_text, lang}   cast THE ballot
 *   GET  /api/votes                                                 the counts
 *
 * ONE BALLOT PER visitor_id, TOTAL (his ruling 2026-10-06). It is enforced where it
 * cannot be walked around, in the DATABASE: `feature_ballots.visitor_id` is the
 * table's PRIMARY KEY (scripts/turso-feedback-migration.sql), and the insert is
 * `on conflict do nothing`, so a second ballot from the same visitor writes ZERO
 * rows and is answered 409 "already_voted". The client's own memory
 * (js/v2/vote-memory.js) only hides the offer; it is a convenience a cleared
 * browser walks past, and this is what catches it. A visitor_id is one BROWSER, not
 * one person: stated, not hidden (his own call: "we are not on that scale").
 *
 * ONE STATEMENT = ONE ATOMIC BALLOT. The 1 to 3 chosen ids are ONE json-array column
 * of ONE row, so a partial ballot cannot land: the row is there whole or not at all.
 *
 * VALIDATED HERE, never trusted from the client: visitor_id must be a real UUID (a
 * missing or malformed one is rejected, 400); `features` goes through the one
 * validator cleanVote() (ids from the list only, at most MAX_VOTES, no duplicates);
 * a ballot with no features must say it carries an idea (has_text), because a
 * ballot is a choice or an idea, never nothing; nothing else from the body is read,
 * and nothing in it is free text (the idea itself goes to api/feedback.js, capped
 * and tag-stripped). Every value is a bound parameter; no SQL is built from input.
 *
 * TURSO ANSWERS HTTP 200 EVEN WHEN IT REFUSES A STATEMENT (api/_turso.js, measured
 * 2026-09-16). The write goes through tursoInsert -> tursoWrite, which checks
 * transport, THEN every statement's own result, THEN the affected-row count; this
 * file never looks at an HTTP status alone. Any failure is a 503, never a "recorded".
 *
 * THE READ IS AGGREGATE ONLY: counts per feature and the number of voters. No
 * visitor_id, no row, no idea text ever leaves it (ideas live in another table this
 * query never touches). Under MIN_VOTERS voters it says {voters:null}: a "top 3"
 * drawn from nine ballots is noise wearing a ranking. Cached at the CDN for 10
 * minutes, so Turso sees a handful of reads an hour however many people vote.
 *
 * WHERE: the pdflokal-FEEDBACK database (TURSO_FEEDBACK_URL / _TOKEN), beside
 * feature_requests: the one the rail's read-only watch token cannot read. The
 * `feature_vote` rail event (js/core/telemetry-schema.js) is analytics only now;
 * nothing counts it.
 */
export const config = { runtime: 'nodejs', api: { bodyParser: false } };

import { tursoQuery, tursoInsert } from './_turso.js';
import { FEATURE_IDS, cleanVote } from '../js/core/features.js';

export const MIN_VOTERS = 10;
const MAX_BODY_BYTES = 2048;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ⚠️ TEST SEAM, the shape api/t.js and api/feedback.js carry: tests (and
// scripts/preview-vote.mjs) hand in `(sql, values) => { rowCount } | { rows }` and
// the REAL SQL below runs on a real SQLite.
let dbOverride = null;
export function __setDbForTests(fn) { dbOverride = fn; }

// The statement a ballot is written with. `on conflict do nothing` is the ONE-BALLOT
// rule: the second ballot from a visitor changes nothing and says so (0 rows).
export const BALLOT_SQL = 'insert into feature_ballots (visitor_id, lang, has_text, features) values (?, ?, ?, ?) '
  + 'on conflict (visitor_id) do nothing';

// ONE statement, one round trip: the first arm counts ballots that picked something
// (a text-only ballot has no features), the second counts each feature.
// 'voters' cannot collide with a feature id.
export const VOTES_SQL = `
  select 'voters' as k, count(*) as n from feature_ballots where json_array_length(features) > 0
  union all
  select j.value as k, count(*) as n from feature_ballots, json_each(feature_ballots.features) j group by j.value`;

// rows -> { voters, counts } | null. Pure, so the test drives the real decision.
export function shapeVotes(rows) {
  let voters = 0;
  const counts = Object.fromEntries(FEATURE_IDS.map((id) => [id, 0]));
  for (const [k, n] of rows) {
    const v = Number(n);
    if (!Number.isFinite(v)) return null;
    if (k === 'voters') voters = v;
    else if (Object.hasOwn(counts, k)) counts[k] = v; // a retired id is simply not shown
  }
  return voters >= MIN_VOTERS ? { voters, counts } : null;
}

// Pure: the request body -> the ballot to write, or null when it is not one.
// Reads exactly four fields and nothing else.
export function cleanBallot(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const visitor = body.visitor_id;
  if (typeof visitor !== 'string' || !UUID_RE.test(visitor)) return null;
  const vote = cleanVote(body.features);
  if (!vote.ok) return null;
  if (typeof body.has_text !== 'boolean') return null;
  if (vote.ids.length === 0 && !body.has_text) return null;
  return {
    visitor: visitor.toLowerCase(),
    features: vote.ids,
    hasText: body.has_text,
    lang: body.lang === 'en' ? 'en' : body.lang === 'id' ? 'id' : null,
  };
}

export async function readVotes({ url, token, override = dbOverride } = {}) {
  if (override) {
    try {
      const out = await override(VOTES_SQL, []);
      return Array.isArray(out?.rows) ? shapeVotes(out.rows) : null;
    } catch { return null; }
  }
  const r = await tursoQuery({ url, token, sql: VOTES_SQL, timeoutMs: 4000 });
  return r.ok ? shapeVotes(r.rows) : null;
}

// Result: 'recorded' | 'already' | 'failed'. Never throws.
export async function writeBallot(ballot, { url, token, override = dbOverride } = {}) {
  const out = await tursoInsert({
    url, token,
    sql: BALLOT_SQL,
    values: [ballot.visitor, ballot.lang, ballot.hasText ? 1 : 0, JSON.stringify(ballot.features)],
    expected: 1,
    override,
  });
  if (out.dark || out.error) {
    // The code only (api/_turso.js is content-blind on purpose).
    console.error(`[votes] ballot insert FAILED ${out.dark ? 'unconfigured' : `error=${out.error}`}`);
    return 'failed';
  }
  if (out.written === 1) return 'recorded';
  if (out.written === 0) return 'already'; // the primary key refused it: this visitor has voted
  console.error(`[votes] ballot insert SHORT written=${out.written ?? 'unknown'}`);
  return 'failed';
}

function readBody(req, maxBytes) {
  return new Promise((resolve) => {
    let size = 0;
    let over = false;
    const chunks = [];
    req.on('data', (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > maxBytes) { over = true; return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

function json(res, code, obj, cache = 'no-store') {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache);
  res.status(code).end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  const cfg = { url: process.env.TURSO_FEEDBACK_URL, token: process.env.TURSO_FEEDBACK_TOKEN };

  if (req.method === 'POST') {
    let ballot = null;
    try {
      const raw = await readBody(req, MAX_BODY_BYTES);
      ballot = raw === null ? null : cleanBallot(JSON.parse(raw));
    } catch { ballot = null; }
    if (!ballot) { json(res, 400, { ok: false, error: 'invalid' }); return; }
    const result = await writeBallot(ballot, cfg);
    if (result === 'recorded') json(res, 200, { ok: true });
    else if (result === 'already') json(res, 409, { ok: false, error: 'already_voted' });
    else json(res, 503, { ok: false, error: 'unavailable' });
    return;
  }

  if (req.method !== 'GET') {
    res.status(405).end();
    return;
  }
  const out = await readVotes(cfg);
  json(res, 200, out ?? { voters: null, counts: null }, out === null
    ? 'public, s-maxage=60'
    : 'public, max-age=300, s-maxage=600, stale-while-revalidate=3600');
}
