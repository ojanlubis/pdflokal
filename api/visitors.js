/*
 * PDFLokal — api/visitors.js  (HOW MANY PEOPLE USED PDFLOKAL IN THE LAST DAY)
 * ============================================================================
 * The header's "N orang" count (founder ask 2026-09-23: a sense that other
 * people use this too). GET-only, takes no input.
 *
 * WHAT IS COUNTED: distinct `visitor_id` on the events rail over the last 24
 * hours. A visitor_id is one BROWSER, not one person — the same person on a
 * phone and a laptop is two, and cleared storage is a new one. Stated here
 * and in the page's tooltip so the number never claims more than it is.
 *
 * WHY A ROLLING 24 HOURS, not the calendar day he asked for: a calendar day
 * resets at midnight WIB and reads "2 orang" at 00:10 — a counter that says
 * the room is empty is the opposite of what he asked for. The rolling window
 * is a daily total without the midnight cliff (measured 2026-09-16..22:
 * ~100-210 visitors/day).
 *
 * PRIVACY: only an aggregate leaves this function. No id, no row, no input.
 *
 * COST: cached at the CDN for 10 minutes, so Turso sees a handful of reads an
 * hour no matter the traffic. On any failure it answers {visitors:null} with
 * a short cache, and the page shows nothing — a missing count is honest, a
 * wrong one is not.
 */
import { tursoScalar } from './_turso.js';

// Below this the count is not shown at all: a tiny number reads as an empty
// room, and on a preview deploy the rail is not written.
export const MIN_SHOWN = 10;

export async function countVisitors({ now = Date.now(), url, token } = {}) {
  const since = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const r = await tursoScalar({
    url, token,
    sql: 'select count(distinct visitor_id) from events where ts >= ? and visitor_id is not null',
    args: [{ type: 'text', value: since }],
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
    : 'public, max-age=300, s-maxage=600, stale-while-revalidate=3600');
  res.status(200).end(JSON.stringify({ visitors }));
}
