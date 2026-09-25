/*
 * PDFLokal — api/routine.js  (the cloud routine's window onto the rail)
 * ============================================================================
 * The cloud maintenance routine (docs/routine-brief.md) used to query Neon
 * through a connector. Neon's free compute ends ~2026-09-27 and the rail now
 * lives in Turso, which no routine connector can reach — so the routine reads
 * THIS instead: one GET with every number its brief asks for, and one POST to
 * write its own `routine_runs` row. Founder ask 2026-09-25: "update the
 * routine".
 *
 * AUTH: `Authorization: Bearer $ROUTINE_KEY`, its own key (not CRON_SECRET),
 * so either can be revoked alone. Fails closed without it.
 *
 * WHAT IT WILL NEVER RETURN: feedback.sample_before / sample_after /
 * screenshot (crops of the user's own document; brief §0.3), any row-level
 * event data, any session or visitor id. Aggregates, plus feedback `note`
 * text, which the brief forwards to his inbox and nowhere else.
 *
 * WHAT IT WILL NEVER WRITE: anything but `routine_runs` rows with
 * routine = 'cloud-maintenance'. The daily watch's rows ('vercel-watch') are
 * not the routine's to write.
 */
import { cronAuthorized } from './_cron.js';
import { tursoQuery, tursoWrite, arg } from './_turso.js';

const MARKER = '00000000-0000-4000-8000-00000000c0de'; // seat spec: excluded from every read
const MAX_WINDOW_H = 24 * 14;

// Same fail-closed bearer check as the crons, against a different key.
const authorized = (req) => cronAuthorized(req, process.env.ROUTINE_KEY);

const ev = () => ({ url: process.env.TURSO_EVENTS_URL, token: process.env.TURSO_EVENTS_TOKEN });
const fb = () => ({ url: process.env.TURSO_FEEDBACK_URL, token: process.env.TURSO_FEEDBACK_TOKEN });

async function rows(db, sql, args = []) {
  const r = await tursoQuery({ ...db, sql, args: args.map(arg) });
  if (!r.ok) throw new Error(`read ${r.reason}`);
  return r.rows.map((row) => Object.fromEntries(r.cols.map((c, i) => [c, row[i]])));
}

const num = (v) => (v == null ? null : Number(v));
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

export async function digest(since, now = new Date()) {
  const until = now.toISOString();
  const span = now.getTime() - Date.parse(since);
  const prevSince = new Date(Date.parse(since) - span).toISOString();
  const E = ev();

  const [lastRun] = await rows(E,
    `select id, ts, status, window_hours, findings from routine_runs
     where routine = 'cloud-maintenance' order by id desc limit 1`);
  const watch = await rows(E,
    `select ts, status, findings, note from routine_runs
     where routine = 'vercel-watch' order by id desc limit 8`);

  const [alive] = await rows(E,
    `select max(ts) as last_event,
            sum(ts >= ?) as n_window,
            sum(ts < ?) as n_prev
     from events where ts >= ? and ts < ? and session_id <> ?`,
    [since, since, prevSince, until, MARKER]);

  const sessionsByDay = await rows(E,
    `select substr(datetime(ts, '+7 hours'), 1, 10) as day_wib,
            count(distinct session_id) as sessions, count(*) as events,
            count(distinct visitor_id) as browsers
     from events where ts >= ? and ts < ? and session_id <> ? group by day_wib order by day_wib`,
    [prevSince, until, MARKER]);

  const [windowTotals] = await rows(E,
    `select count(distinct session_id) as sessions,
            count(distinct case when event = 'doc_open' then session_id end) as opened,
            count(distinct case when event = 'export' then session_id end) as exported
     from events where ts >= ? and ts < ? and session_id <> ?`,
    [since, until, MARKER]);
  const [prevTotals] = await rows(E,
    `select count(distinct session_id) as sessions
     from events where ts >= ? and ts < ? and session_id <> ?`,
    [prevSince, since, MARKER]);

  const tools = await rows(E,
    `select json_extract(props,'$.tool') as tool, json_extract(props,'$.action') as action,
            count(*) as n, count(distinct session_id) as sessions
     from events where event = 'tool_use' and ts >= ? and ts < ? and session_id <> ?
     group by 1, 2 order by n desc limit 15`,
    [since, until, MARKER]);

  const arrivals = await rows(E,
    `select json_extract(props,'$.device') as device, json_extract(props,'$.intent') as intent,
            json_extract(props,'$.text_layer') as text_layer, count(*) as n
     from events where event = 'doc_open' and ts >= ? and ts < ? and session_id <> ?
     group by 1, 2, 3 order by n desc limit 15`,
    [since, until, MARKER]);

  const failures = await rows(E,
    `with w as (
       select json_extract(props,'$.stage') as stage, json_extract(props,'$.reason') as reason,
              json_extract(props,'$.class') as class, json_extract(props,'$.blocked') as blocked,
              count(*) as n, count(distinct session_id) as sessions
       from events where event = 'failure' and ts >= ? and ts < ? and session_id <> ?
       group by 1, 2, 3, 4),
     f as (
       select json_extract(props,'$.stage') as stage, json_extract(props,'$.reason') as reason,
              min(ts) as first_seen
       from events where event = 'failure' group by 1, 2)
     select w.*, f.first_seen from w left join f using (stage, reason) order by w.n desc`,
    [since, until, MARKER]);

  const feedback = await rows(fb(),
    `select ts, rating, note from feedback where ts >= ? and ts < ? order by ts desc`,
    [since, until]);

  return {
    now: until,
    window: { since, hours: Math.round((span / 3600000) * 10) / 10, prev_since: prevSince },
    last_run: lastRun ? { ...lastRun, findings: parse(lastRun.findings) } : null,
    watch: watch.map((w) => ({ ...w, findings: parse(w.findings) })),
    alive: { last_event: alive?.last_event ?? null, n_window: num(alive?.n_window) ?? 0, n_prev: num(alive?.n_prev) ?? 0 },
    sessions: { window: num(windowTotals?.sessions), prev: num(prevTotals?.sessions) },
    sessions_by_day: sessionsByDay.map((d) => ({ ...d, sessions: num(d.sessions), events: num(d.events), browsers: num(d.browsers) })),
    opened: num(windowTotals?.opened),
    exported: num(windowTotals?.exported),
    tools: tools.map((t) => ({ ...t, n: num(t.n), sessions: num(t.sessions) })),
    arrivals: arrivals.map((a) => ({ ...a, n: num(a.n) })),
    failures: failures.map((f) => ({ ...f, n: num(f.n), sessions: num(f.sessions) })),
    feedback,
  };
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return parse(req.body);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return parse(Buffer.concat(chunks).toString('utf8'));
}

export default async function handler(req, res) {
  if (!authorized(req)) {
    res.status(401).end();
    return;
  }

  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://x');
    const now = new Date();
    let since = url.searchParams.get('since');
    // Default window: since the routine's own last run (brief §1.1), capped.
    if (!since || Number.isNaN(Date.parse(since))) since = new Date(now.getTime() - 72 * 3600000).toISOString();
    since = new Date(Math.max(Date.parse(since), now.getTime() - MAX_WINDOW_H * 3600000)).toISOString();
    try {
      res.status(200).json(await digest(since, now));
    } catch (err) {
      // The rail cannot be read — that is the finding, say so plainly.
      res.status(503).json({ error: 'rail_unreadable', reason: String(err?.message ?? 'unknown').slice(0, 60) });
    }
    return;
  }

  if (req.method === 'POST') {
    const b = await readBody(req);
    if (!b || typeof b !== 'object') {
      res.status(400).json({ error: 'json body required' });
      return;
    }
    // Update the email outcome on a row this routine already wrote (brief §7).
    if (b.id != null && typeof b.email === 'string') {
      const w = await tursoWrite({
        ...ev(),
        sql: `update routine_runs set findings = json_set(findings, '$.email', ?)
              where id = ? and routine = 'cloud-maintenance'`,
        args: [arg(b.email.slice(0, 40)), { type: 'integer', value: String(Number(b.id)) }],
        expected: 1,
      });
      res.status(w.ok ? 200 : 500).json(w.ok ? { id: Number(b.id), email: b.email } : { error: w.reason });
      return;
    }
    const findings = JSON.stringify(b.findings ?? {});
    if (!['ok', 'warn', 'fail'].includes(b.status) || findings.length > 20000) {
      res.status(400).json({ error: 'status must be ok|warn|fail; findings under 20 KB' });
      return;
    }
    const w = await tursoWrite({
      ...ev(),
      sql: `insert into routine_runs (routine, status, window_hours, findings, note)
            values ('cloud-maintenance', ?, ?, ?, ?)`,
      args: [b.status, b.window_hours == null ? null : Number(b.window_hours), findings, String(b.note ?? '').slice(0, 300)].map(arg),
      expected: 1,
    });
    if (!w.ok) {
      res.status(500).json({ error: w.reason });
      return;
    }
    const [row] = await rows(ev(), `select max(id) as id from routine_runs where routine = 'cloud-maintenance'`);
    res.status(200).json({ id: num(row?.id) });
    return;
  }

  res.status(405).end();
}
