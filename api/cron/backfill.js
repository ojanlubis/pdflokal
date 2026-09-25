/*
 * PDFLokal — api/cron/backfill.js  (ONE-OFF: copy Neon's history into Turso)
 * ============================================================================
 * Founder ask 2026-09-25: back the rail up and backfill Turso before Neon's
 * free compute runs out (~09-27), so Neon can be unlinked. Turso has carried
 * every event since CUTOFF (dual-write, `acd9f23`); everything before it lives
 * only in Neon. DELETE THIS FILE once the backfill is verified — it is not a
 * cron, it lives here only because api/cron/ is behind CRON_SECRET.
 *
 * WHY ON VERCEL AND NOT A LAPTOP SCRIPT: the database credentials are Vercel
 * "sensitive" env vars. Running here, they never leave the platform.
 *
 * Calls (all GET, all need `Authorization: Bearer $CRON_SECRET`):
 *   ?table=events&day=YYYY-MM-DD   one UTC day, clipped at CUTOFF
 *   ?table=feedback                every feedback row before CUTOFF
 *   ?table=routine_runs            the cloud routine's record (creates the table)
 * Add `&write=1` to copy; without it the call only compares.
 *
 * IDEMPOTENT BY CONSTRUCTION: rows keep their Neon id. Turso's sequences were
 * seeded far above Neon's (events 10,000,000, feedback 100,000) for exactly
 * this, so a copied id can never collide with a live one. A window that is
 * already fully copied is skipped; a PARTIAL window is refused, never topped
 * up blindly.
 *
 * VERIFIED BY FINGERPRINT, not by count: a count proves rows arrived, only a
 * hash over every column proves they arrived unchanged. Neon's side is hashed
 * from Neon, Turso's from a fresh read of Turso.
 *
 * ⚠ ONE DELIBERATE LOSS: feedback and routine_runs timestamps carry
 * microseconds in Neon (server-side now()); they are cut to milliseconds, the
 * format every other Turso row uses. Mixing the two would break ORDER BY on the
 * TEXT column ('.123456Z' sorts before '.123Z'). Both hashes use the ms form.
 */
import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { cronAuthorized } from '../_cron.js';
import { tursoWrite, tursoQuery, placeholders, arg } from '../_turso.js';

// Turso's first event (measured 2026-09-25: min(ts) on pdflokal-events).
// Every Neon row strictly before it is missing from Turso; every row at or
// after it is already there (Sep 16-23: 79,826 = 79,826).
export const CUTOFF = '2026-09-16T07:47:45.515Z';
const ID_CEILING = { events: 10000000, feedback: 100000 };

// Stable JSON: keys sorted at every depth. Postgres jsonb reorders keys and
// the live writer does not, so raw text can never be compared across stores.
export function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export function fingerprint(lines) {
  const h = createHash('sha256');
  for (const line of lines) h.update(`${line}\n`);
  return h.digest('hex');
}

const TS = `to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const TABLES = {
  events: {
    neonSql: `select id::text as id, ${TS} as ts, session_id::text as session_id, app_version,
                     event, props, visitor_id::text as visitor_id
              from events where ts >= $1 and ts < $2 order by id`,
    tursoSql: `select id, ts, session_id, app_version, event, props, visitor_id
               from events where ts >= ? and ts < ? and id < ${ID_CEILING.events} order by id`,
    insertCols: ['id', 'ts', 'session_id', 'app_version', 'event', 'props', 'visitor_id'],
    toRow: (r) => [Number(r.id), r.ts, r.session_id, r.app_version, r.event, JSON.stringify(r.props ?? {}), r.visitor_id],
    line: (r) => [r[0], r[1], r[2], r[3], r[4], canon(typeof r[5] === 'string' ? JSON.parse(r[5]) : r[5]), r[6] ?? ''].join('\t'),
    chunk: 200,
    db: 'events',
  },
  feedback: {
    neonSql: `select id::text as id, ${TS} as ts, session_id::text as session_id, app_version, rating,
                     note, sample_before, sample_after, screenshot
              from feedback where ts >= $1 and ts < $2 order by id`,
    tursoSql: `select id, ts, session_id, app_version, rating, note, sample_before, sample_after, screenshot
               from feedback where ts >= ? and ts < ? and id < ${ID_CEILING.feedback} order by id`,
    insertCols: ['id', 'ts', 'session_id', 'app_version', 'rating', 'note', 'sample_before', 'sample_after', 'screenshot'],
    toRow: (r) => [Number(r.id), r.ts, r.session_id, r.app_version, r.rating, r.note, r.sample_before, r.sample_after, r.screenshot],
    // Hash the long columns rather than concatenating megabytes of base64.
    line: (r) => r.map((v, i) => (i >= 6 && v != null ? fingerprint([v]) : (v ?? ''))).join('\t'),
    chunk: 2, // screenshots run to 280 KB each
    db: 'feedback',
  },
  routine_runs: {
    neonSql: `select id::text as id, ${TS} as ts, routine, status, window_hours::float8 as window_hours,
                     findings, note
              from routine_runs where ts >= $1 and ts < $2 order by id`,
    tursoSql: `select id, ts, routine, status, window_hours, findings, note
               from routine_runs where ts >= ? and ts < ? order by id`,
    insertCols: ['id', 'ts', 'routine', 'status', 'window_hours', 'findings', 'note'],
    toRow: (r) => [Number(r.id), r.ts, r.routine, r.status, r.window_hours, JSON.stringify(r.findings ?? {}), r.note],
    line: (r) => [r[0], r[1], r[2], r[3], r[4] == null ? '' : Number(r[4]), canon(typeof r[5] === 'string' ? JSON.parse(r[5]) : r[5]), r[6] ?? ''].join('\t'),
    chunk: 20,
    db: 'events',
  },
};

// The cloud routine's record moves with the rail. Additive, same columns as
// Neon's, spelled for SQLite (scripts/turso-events-migration.sql carries it too).
const ROUTINE_RUNS_DDL = `create table if not exists routine_runs (
  id integer primary key autoincrement,
  ts text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  routine text not null,
  status text not null,
  window_hours real,
  findings text not null default '{}' check (json_valid(findings)),
  note text
)`;

function tursoConfig(db) {
  return db === 'feedback'
    ? { url: process.env.TURSO_FEEDBACK_URL, token: process.env.TURSO_FEEDBACK_TOKEN }
    : { url: process.env.TURSO_EVENTS_URL, token: process.env.TURSO_EVENTS_TOKEN };
}

function windowFor(table, day) {
  if (table !== 'events') return ['1970-01-01T00:00:00.000Z', table === 'routine_runs' ? '9999-12-31T00:00:00.000Z' : CUTOFF];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '')) return null;
  const from = `${day}T00:00:00.000Z`;
  const next = new Date(Date.parse(from) + 86400000).toISOString();
  if (from >= CUTOFF) return null;
  return [from, next < CUTOFF ? next : CUTOFF];
}

export default async function handler(req, res) {
  if (!cronAuthorized(req)) {
    res.status(401).end();
    return;
  }
  const url = new URL(req.url, 'http://x');
  const table = url.searchParams.get('table');
  const spec = TABLES[table];
  const win = spec && windowFor(table, url.searchParams.get('day'));
  if (!spec || !win) {
    res.status(400).json({ error: 'bad table or day' });
    return;
  }
  const write = url.searchParams.get('write') === '1';
  const turso = tursoConfig(spec.db);
  const out = { table, from: win[0], to: win[1], write };

  if (table === 'routine_runs' && write) {
    const ddl = await tursoQuery({ ...turso, sql: ROUTINE_RUNS_DDL });
    if (!ddl.ok) {
      res.status(500).json({ ...out, error: `ddl ${ddl.reason}` });
      return;
    }
  }

  const sql = neon(process.env.DATABASE_URL);
  const neonRows = (await sql.query(spec.neonSql, win, { fullResults: true })).rows;
  out.neon_n = neonRows.length;
  const neonLines = neonRows.map((r) => spec.line(spec.toRow(r).map((v, i) => (i === 0 ? String(v) : v))));
  out.neon_fp = fingerprint(neonLines);

  const readTurso = () => tursoQuery({ ...turso, sql: spec.tursoSql, args: win.map(arg) });
  let before = await readTurso();
  if (!before.ok) {
    res.status(500).json({ ...out, error: `turso read ${before.reason}` });
    return;
  }
  out.turso_before = before.rows.length;

  if (write && before.rows.length === 0 && neonRows.length > 0) {
    out.inserted = 0;
    for (let i = 0; i < neonRows.length; i += spec.chunk) {
      const part = neonRows.slice(i, i + spec.chunk).map(spec.toRow);
      const w = await tursoWrite({
        ...turso,
        sql: `insert into ${table} (${spec.insertCols.join(',')}) values ${placeholders(part.length, spec.insertCols.length)}`,
        // id binds as an INTEGER, never through arg()'s float: it is the
        // primary key, and the copy is only verifiable if it lands exactly.
        args: part.flatMap((row) => [{ type: 'integer', value: String(row[0]) }, ...row.slice(1).map(arg)]),
        expected: part.length,
        timeoutMs: 20000,
      });
      if (!w.ok) {
        res.status(500).json({ ...out, error: `insert ${w.reason} at row ${i}` });
        return;
      }
      out.inserted += w.written;
    }
    before = await readTurso();
  } else if (write && before.rows.length > 0 && before.rows.length !== neonRows.length) {
    out.refused = 'partial window: Turso holds some of these rows but not all — resolve by hand';
  }

  const tursoLines = before.rows.map((r) => spec.line(r.map((v, i) => (i === 0 ? String(v) : v))));
  out.turso_n = before.rows.length;
  out.turso_fp = fingerprint(tursoLines);
  out.match = out.neon_n === out.turso_n && out.neon_fp === out.turso_fp;
  // Diagnosis for a mismatch: the first differing line from each side. Events
  // only — its props are content-blind by the rail's own law; feedback notes
  // must never be echoed here.
  if (!out.match && table === 'events') {
    const i = neonLines.findIndex((l, k) => l !== tursoLines[k]);
    if (i !== -1) out.first_diff = { index: i, neon: neonLines[i], turso: tursoLines[i] ?? null };
  }
  res.status(200).json(out);
}
