#!/usr/bin/env node
/*
 * rail-backfill.mjs — copy the old Supabase rail into Neon.
 * ============================================================================
 * One job, run more than once: first for the bulk (34 days, ~47k events), then
 * again as a TOP-UP after the cutover, for anything Supabase received between
 * the bulk read and the deploy. That is why it is idempotent rather than a
 * one-shot — `on conflict (id) do nothing` means a second run costs time and
 * changes nothing, so a partial or interrupted run is always safe to repeat.
 *
 * WHY IDS ARE CARRIED OVER RATHER THAN REGENERATED. Nothing references them —
 * but a re-run has to be able to recognise a row it already wrote, and `id` is
 * the only thing that survives a round trip unchanged. `ts` cannot do that job:
 * events in one batch used to share a flush timestamp, so it is not unique.
 * Neon's identity sequences start at 1,000,000 / 1,000 (see
 * neon-rail-migration.sql) precisely so these ids can land underneath without
 * ever colliding with a live insert.
 *
 * READS the old rail over PostgREST with the service key, keyset-paginated by
 * id — NOT offset, which drifts if rows arrive mid-run. Writes with the same
 * driver the endpoints use.
 *
 * ENV (all four required; nothing is defaulted, because a silent default here
 * would write production data somewhere unintended):
 *   TELEMETRY_SUPABASE_URL, TELEMETRY_SUPABASE_SERVICE_KEY   — the source
 *   DATABASE_URL                                             — the destination
 * Run:  node scripts/rail-backfill.mjs [--dry]
 *
 * ⚠️ The counts it prints are the whole point. "Done" is not a result; `copied`
 * versus `already there` versus the source total is. A run that reports fewer
 * rows than the source has is a hole, and the script says so and exits non-zero
 * rather than letting a green-looking finish stand in for a complete copy.
 */
import { neon } from '@neondatabase/serverless';

const SRC = process.env.TELEMETRY_SUPABASE_URL;
const KEY = process.env.TELEMETRY_SUPABASE_SERVICE_KEY;
const DST = process.env.DATABASE_URL;
const DRY = process.argv.includes('--dry');

if (!SRC || !KEY || !DST) {
  console.error('missing env: need TELEMETRY_SUPABASE_URL, TELEMETRY_SUPABASE_SERVICE_KEY, DATABASE_URL');
  process.exit(2);
}

const sql = neon(DST);

// Page sizes differ by an order of magnitude on purpose: a feedback row may
// carry two ~60KB base64 crops, so 1000 of them would be ~120MB in one request
// and the driver's cap is 64MB. An events row is ~250 bytes.
const TABLES = [
  {
    name: 'events',
    page: 1000,
    idFloor: 1000000,
    cols: ['id', 'ts', 'session_id', 'app_version', 'event', 'props'],
    casts: { id: '::bigint', ts: '::timestamptz', session_id: '::uuid', props: '::jsonb' },
    encode: (r) => [r.id, r.ts, r.session_id, r.app_version, r.event, JSON.stringify(r.props ?? {})],
  },
  {
    name: 'feedback',
    page: 25,
    idFloor: 1000,
    cols: ['id', 'ts', 'session_id', 'app_version', 'rating', 'note', 'sample_before', 'sample_after'],
    casts: { id: '::bigint', ts: '::timestamptz', session_id: '::uuid' },
    encode: (r) => [r.id, r.ts, r.session_id, r.app_version, r.rating, r.note, r.sample_before, r.sample_after],
  },
];

async function sourceCount(table) {
  // PostgREST returns the exact count in Content-Range when asked for it.
  const r = await fetch(`${SRC}/rest/v1/${table}?select=id&limit=1`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Prefer: 'count=exact', Range: '0-0' },
  });
  if (!r.ok) throw new Error(`count ${table}: HTTP ${r.status}`);
  const range = r.headers.get('content-range') || '';
  const total = Number(range.split('/')[1]);
  if (!Number.isFinite(total)) throw new Error(`count ${table}: unparseable content-range "${range}"`);
  return total;
}

async function fetchPage(table, cols, afterId, limit) {
  const url = `${SRC}/rest/v1/${table}?select=${cols.join(',')}`
    + `&id=gt.${afterId}&order=id.asc&limit=${limit}`;
  const r = await fetch(url, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  if (!r.ok) throw new Error(`read ${table} after id=${afterId}: HTTP ${r.status}`);
  return r.json();
}

async function copyTable(t) {
  const total = await sourceCount(t.name);
  // ⚠️ COUNT ONLY THE BACKFILL RANGE (id < idFloor), not the whole table. The
  // rail is LIVE while this runs: real events are landing above the floor the
  // entire time, so a plain count(*) difference would credit this script with
  // rows it never wrote — a number that flatters itself is worse than none.
  const inRange = `select count(*)::int as n from ${t.name} where id < ${t.idFloor}`;
  const before = Number((await sql.query(inRange))[0].n);
  let read = 0;
  let afterId = 0;

  for (;;) {
    const rows = await fetchPage(t.name, t.cols, afterId, t.page);
    if (rows.length === 0) break;
    read += rows.length;
    afterId = rows[rows.length - 1].id;

    if (!DRY) {
      const n = t.cols.length;
      const placeholders = rows
        .map((_, i) => `(${t.cols.map((c, j) => `$${i * n + j + 1}${t.casts[c] ?? ''}`).join(',')})`)
        .join(',');
      const params = rows.flatMap(t.encode);
      // `overriding system value` is required to write into a
      // `generated always as identity` column. `do nothing` is what makes a
      // re-run a no-op instead of a duplicate-key crash.
      await sql.query(
        `insert into ${t.name} (${t.cols.join(',')}) overriding system value
         values ${placeholders} on conflict (id) do nothing`,
        params,
      );
    }
    process.stdout.write(`\r  ${t.name}: read ${read}/${total}`);
  }

  const after = Number((await sql.query(inRange))[0].n);
  const live = Number((await sql.query(`select count(*)::int as n from ${t.name} where id >= ${t.idFloor}`))[0].n);
  const copied = after - before;
  process.stdout.write('\n');
  // In DRY mode nothing was written, so `copied` is 0 by construction and an
  // "already_present" figure derived from it would be a fabrication. Say what
  // actually happened instead — a report that quietly means something different
  // in one mode is the same defect this script exists to avoid.
  console.log(DRY
    ? `  ${t.name}: source=${total} read=${read} (dry — nothing written; neon holds ${after} backfilled + ${live} live)`
    : `  ${t.name}: source=${total} read=${read} copied=${copied} already_present=${read - copied} backfilled_total=${after} live_since_cutover=${live}`);

  // The check that makes this script's output mean something. A read that came
  // up short of the source count means pagination lost rows — which looks
  // exactly like a successful finish if nobody compares the two numbers.
  if (read !== total) {
    console.error(`  ✗ ${t.name}: READ ${read} OF ${total} — the copy is INCOMPLETE`);
    return false;
  }
  return true;
}

console.log(DRY ? 'DRY RUN — reading only, writing nothing' : 'backfilling Supabase → Neon');
let ok = true;
for (const t of TABLES) ok = (await copyTable(t)) && ok;
console.log(ok ? 'complete' : 'INCOMPLETE — see above');
process.exit(ok ? 0 : 1);
