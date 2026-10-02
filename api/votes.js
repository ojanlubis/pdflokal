/*
 * PDFLokal — api/votes.js  (WHAT PEOPLE VOTED FOR: counts per feature)
 * ============================================================================
 * The feature vote's read side (founder ruling 2026-10-02; the list and the
 * rules are js/core/features.js). The card calls this after someone votes and
 * shows the top three ("Yang paling banyak diminta"). GET-only, takes no input.
 *
 * WHAT IS COUNTED: `feature_vote` events on the rail, ONE VOTE PER FEATURE PER
 * VISITOR. The dedupe is here, at read time, and it is the only place it can be
 * done honestly: the client's own memory (pdflokal_vote_done) is a convenience
 * a cleared browser or a second device walks straight past. A visitor is
 * `visitor_id`, the one persistent id on this rail (js/v2/telemetry.js); when a
 * browser could not keep one (private mode) the vote falls back to its
 * `session_id`, so that browser can vote again on its next page load. Stated, not
 * hidden: a visitor_id is one BROWSER, not one person.
 *
 * LATEST VOTE WINS. If one visitor sends two votes, only the newest counts: it
 * is what they meant last, it keeps a visitor at most MAX_VOTES features however
 * many events they send, and a second send never stacks on the first.
 *
 * PRIVACY: only aggregates leave this function. No id, no row, no input, no text:
 * the free-text ideas live in another database this file cannot read.
 *
 * HONESTY GATE: under MIN_VOTERS voters the answer is `{voters:null}` and the
 * card just says thanks. A "top 3" drawn from four votes is noise wearing a
 * ranking, and on a preview deploy the rail is not written at all (same fence
 * as api/visitors.js's MIN_SHOWN).
 *
 * COST: cached at the CDN for 10 minutes, so Turso sees a handful of reads an
 * hour however many people vote. On any failure it answers {voters:null} with
 * a short cache and the card says thanks: a missing ranking is honest, a wrong
 * one is not.
 */
import { tursoQuery } from './_turso.js';
import { FEATURE_IDS } from '../js/core/features.js';

export const MIN_VOTERS = 10;

// seat specs/telemetry-alerts.md "Synthetic sessions": excluded from every read.
const MARKER = '00000000-0000-4000-8000-00000000c0de';

// ONE statement, one round trip. `last` is each voter's newest vote; the first
// arm counts voters who picked something (a text-only send has no features),
// the second counts each feature. 'voters' cannot collide with a feature id.
export const VOTES_SQL = `
  with v as (
    select props,
           row_number() over (partition by coalesce(visitor_id, session_id) order by id desc) as rn
    from events
    where event = 'feature_vote' and session_id <> ?
  ), last as (select props from v where rn = 1)
  select 'voters' as k, count(*) as n from last where json_array_length(props, '$.features') > 0
  union all
  select j.value as k, count(*) as n from last, json_each(last.props, '$.features') j group by j.value`;

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

export async function readVotes({ url, token } = {}) {
  const r = await tursoQuery({ url, token, sql: VOTES_SQL, args: [{ type: 'text', value: MARKER }], timeoutMs: 4000 });
  return r.ok ? shapeVotes(r.rows) : null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).end();
    return;
  }
  const out = await readVotes({
    url: process.env.TURSO_EVENTS_URL,
    token: process.env.TURSO_EVENTS_TOKEN,
  });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', out === null
    ? 'public, s-maxage=60'
    : 'public, max-age=300, s-maxage=600, stale-while-revalidate=3600');
  res.status(200).end(JSON.stringify(out ?? { voters: null, counts: null }));
}
