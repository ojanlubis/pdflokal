/*
 * PDFLokal — api/visitors.js  (HOW MANY PEOPLE USED PDFLOKAL TODAY)
 * ============================================================================
 * The header's "N orang" count (founder ask 2026-09-23: a sense that other
 * people use this too). GET-only, takes no input.
 *
 * WHAT IS COUNTED: distinct `visitor_id` that sent telemetry since midnight
 * WIB (counted on arrival, see COST) (Asia/Jakarta, UTC+7, no DST) — the calendar day the label "visitor
 * hari ini" says. A visitor_id is one BROWSER, not one person — the same
 * person on a phone and a laptop is two, and cleared storage is a new one.
 * Stated here and in the page's tooltip so the number never claims more than
 * it is.
 *
 * WHY THE CALENDAR DAY: his ruling 2026-09-25, overturning the rolling 24
 * hours shipped in #139 — the label says "hari ini", so the count must mean
 * it. The midnight cliff that window was avoiding is handled by MIN_SHOWN:
 * after 00:00 the count hides until the day has 10 visitors, it never reads
 * "2".
 *
 * PRIVACY: only an aggregate leaves this function. No id, no row, no input.
 *
 * COST: one row read per cache miss. The count is a TALLY kept on the write
 * path (api/t.js inserts one (day, visitor_id) per visitor per WIB day; the
 * trigger in scripts/turso-visitor-days-migration.sql bumps
 * visitor_day_counts), so reading it never scans events. History: on
 * 2026-10-06 the old scan had read 203M rows in 6 days (89% of the free
 * month) because the planner walked every visitor row (~276k a call); pinning
 * the ts index cut it to ~20k a call, the tally to one. That is why the CDN can
 * refresh it every minute. On any failure it answers {visitors:null} with a
 * short cache, and the page shows nothing: a missing count is honest, a wrong
 * one is not.
 */
import { tursoScalar } from './_turso.js';

// Below this the count is not shown at all: a tiny number reads as an empty
// room, and on a preview deploy the rail is not written.
export const MIN_SHOWN = 10;

const WIB_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Midnight WIB of `now`'s Jakarta date, as the UTC ISO string the rail's `ts`
// is stored in (api/t.js), so the string comparison in SQL is a time one.
export function startOfDayWIB(now) {
  return new Date(Math.floor((now + WIB_MS) / DAY_MS) * DAY_MS - WIB_MS).toISOString();
}

// The WIB calendar date of `now`, YYYY-MM-DD: the key of the daily tally that
// api/t.js maintains (visitor_days -> visitor_day_counts).
export function wibDay(now) {
  return new Date(now + WIB_MS).toISOString().slice(0, 10);
}

// ONE ROW READ (2026-10-06). The tally is kept on the write path (api/t.js +
// the visitor_days trigger, scripts/turso-visitor-days-migration.sql), so the
// count no longer scans the day's events: that scan was ~20k rows a call even
// with the ts index, and ~276k before it, against a 500M rows-read month.
export async function countVisitors({ now = Date.now(), url, token } = {}) {
  const r = await tursoScalar({
    url, token,
    sql: 'select n from visitor_day_counts where day = ?',
    args: [{ type: 'text', value: wibDay(now) }],
  });
  const n = r.ok ? Number(r.value) : NaN;
  return Number.isInteger(n) && n >= MIN_SHOWN ? n : null;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).end();
    return;
  }
  const visitors = await countVisitors({
    url: process.env.TURSO_EVENTS_URL,
    token: process.env.TURSO_EVENTS_TOKEN,
  });
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', visitors === null
    ? 'public, s-maxage=60'
    : 'public, max-age=60, s-maxage=60, stale-while-revalidate=300');
  res.status(200).end(JSON.stringify({ visitors }));
}
