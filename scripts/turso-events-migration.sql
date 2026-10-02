-- pdflokal telemetry rail — EVENTS, on Turso (libSQL / SQLite).
-- Port of scripts/neon-rail-migration.sql (deleted 2026-10-01; git log -- scripts/neon-rail-migration.sql), 2026-09-16. That file was the
-- record of the Neon rail; this one is the Turso truth.
--
-- WHY TWO DATABASES. Turso has no GRANT, no roles and no row policies: a token
-- is read-only or read-write for a WHOLE database. The Neon rail's read-only
-- role was deliberately `select` on `events` ONLY, never `feedback`, because
-- feedback holds user-authored notes and document crops. The only way to keep
-- that boundary here is a separate database — see turso-feedback-migration.sql.
-- Nothing is lost: no query in this system ever joins the two.

-- ---- events -------------------------------------------------------------
-- String-free by law (spec-telemetry.md §1/§5/§6): `props` never carries a
-- user-authored string. That is the feedback database's territory.
create table if not exists events (
  -- Postgres `bigint generated always as identity` -> AUTOINCREMENT. The seed
  -- below is the step that CANNOT be fixed later without pain.
  id integer primary key autoincrement,

  -- ⚠️ Postgres `timestamptz` has no SQLite equivalent. Stored as TEXT, and
  -- every comparison in every view depends on the format being identical on
  -- every row: ISO-8601, UTC, milliseconds, trailing Z. The CHECK is the only
  -- thing standing between that invariant and a silently unsortable column.
  ts text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

  session_id text not null,
  app_version text not null,
  event text not null,

  -- Postgres `jsonb` -> TEXT holding JSON. SQLite's json_* functions read TEXT
  -- directly; json_valid() replaces the type system that used to reject
  -- malformed input at the door.
  props text not null default '{}',

  -- Nullable BY LAW, same as Neon: no row written before 2026-09-10 carries a
  -- visitor_id and none can be backfilled.
  visitor_id text,

  -- ⚠️ SQLite has no `uuid` type, so shape enforcement that Postgres did for
  -- free must be spelled out. GLOB, never LIKE: SQLite's LIKE is
  -- case-INSENSITIVE for ASCII by default, so a LIKE-based check would accept
  -- uppercase hex that the Postgres `uuid` type also accepted but normalised —
  -- here nothing normalises, so two spellings of one id would be two ids.
  constraint events_session_id_shape_chk check (
    session_id glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  constraint events_visitor_id_shape_chk check (
    visitor_id is null or visitor_id glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  constraint events_props_json_chk check (json_valid(props)),
  constraint events_ts_shape_chk check (
    ts glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
  )
);

-- ⚠️ THE STEP THAT CANNOT BE DONE LATER. Neon's live max id is 1,120,535
-- (measured 2026-09-16). Seeding Turso at 10,000,000 means a backfill can carry
-- every Neon row across KEEPING ITS ORIGINAL id — so the copy stays verifiable
-- row-for-row and a re-run is a no-op — with ten million ids of clearance
-- between the two populations. Doing this after the first insert is not
-- possible without rewriting ids.
insert into sqlite_sequence (name, seq)
  select 'events', 10000000
  where not exists (select 1 from sqlite_sequence where name = 'events');

-- Read patterns are "recent, by event, filtered on a prop" — unchanged from
-- Neon. ⚠️ NEW COST ON THIS VENDOR: Turso bills rows READ, and a scan bills
-- every row it touches, so an index is now a bill-control device and not only a
-- speed one. No index on props, same call as Neon.
create index if not exists events_ts_idx on events (ts desc);
create index if not exists events_event_idx on events (event);
create index if not exists events_visitor_id_idx on events (visitor_id) where visitor_id is not null;

-- ---- read side ----------------------------------------------------------
-- date_trunc('day', ts) -> date(ts). Same boundary, since ts is UTC text.
create view if not exists v_daily_events as
select date(ts) as day, event, count(*) as n
from events group by 1, 2;

-- ⚠️ `props ? 'reason'` could not be ported literally: `?` is SQLite's
-- bind-parameter character, not an operator. json_extract(...) is not null is
-- the equivalent, with one real difference — a key present with a JSON null
-- counted as present in Postgres and does not here.
create view if not exists v_decline_reasons as
select event, json_extract(props, '$.reason') as reason, count(*) as n
from events
where event in ('surgery', 'insert', 'block_edit')
  and json_extract(props, '$.reason') is not null
group by 1, 2;

-- ⚠️ THE ONE VIEW THAT IS NOT A PORT. SQLite has no percentile_cont, so this
-- is NEAREST-RANK, while Neon's was LINEARLY INTERPOLATED. On the same data the
-- two disagree by up to one sample's width. DO NOT COMPARE A NUMBER FROM THIS
-- VIEW WITH ONE READ OFF NEON and call the difference a change in the product —
-- same rule as dating an instrument before reading a series across a stream
-- swap.
create view if not exists v_commit_latency as
with d as (
  select json_extract(props, '$.device') as device,
         cast(json_extract(props, '$.duration') as real) as ms
  from events
  where event = 'commit_paint'
    and json_extract(props, '$.duration') is not null
),
r as (
  select device, ms,
         row_number() over (partition by device order by ms) as rn,
         count(*) over (partition by device) as n
  from d
)
select device,
       max(case when rn = max(1, cast(round(n * 0.50) as integer)) then ms end) as p50_ms,
       max(case when rn = max(1, cast(round(n * 0.90) as integer)) then ms end) as p90_ms,
       max(case when rn = max(1, cast(round(n * 0.99) as integer)) then ms end) as p99_ms,
       n
from r
group by device, n;

-- Daily returning-vs-new by visitor_id. Only counts rows that carry one, so
-- `day`'s minimum IS the boundary of what this question can be asked about —
-- read that before trusting any number from it.
create view if not exists v_visitor_retention as
with by_day as (
  select visitor_id,
         date(ts) as day,
         min(date(ts)) over (partition by visitor_id) as first_day
  from events
  where visitor_id is not null
)
select day,
       count(distinct visitor_id) as visitors,
       count(distinct case when day = first_day then visitor_id end) as new_visitors,
       count(distinct case when day > first_day then visitor_id end) as returning_visitors
from by_day
group by day;

-- ---- retention (spec §2/§7): 180 days, instrumentation not a warehouse ----
-- NOT scheduled here, and it never was on Supabase or Neon either. Run
-- periodically. ⚠️ `now() - interval '180 days'` has no SQLite form:
--   delete from events where ts < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-180 days');

-- routine_runs — the cloud routine's record (and, since 2026-09-25, the daily
-- Vercel watch's: routine = 'vercel-watch'). Moved from Neon with its 11 rows,
-- ids kept. Additive. Applied 2026-09-25 by the one-off api/cron/backfill.js.
create table if not exists routine_runs (
  id integer primary key autoincrement,
  ts text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  routine text not null,
  status text not null,
  window_hours real,
  findings text not null default '{}' check (json_valid(findings)),
  note text
);

-- telemetry_rejects — what api/t.js DISCARDS, counted by cause (2026-10-02;
-- api/_rejects.js has the why, the units and the content law). One row per
-- (Jakarta day, reason, event, prop) with `n` bumped by upsert, so the table
-- grows with the number of distinct CAUSES and never with traffic.
-- ⚠️ CONTENT-BLIND: reason is from a closed list in code; event and prop are
-- a SCHEMA-declared name or '' (never a sender-supplied string); '' and not NULL
-- because SQLite treats NULLs in a primary key as distinct, which would turn the
-- upsert into one insert per drop. The length checks are a backstop, not the law.
-- ⚠️ DEPLOY ORDER: apply this BEFORE (or with) the api/t.js that writes it. Until
-- it exists every dropped batch logs `[telemetry] reject-count FAILED
-- error=sql_SQLITE_ERROR` and counts nothing; the endpoint itself is unaffected.
-- Run: turso db shell <events-db> < scripts/turso-events-migration.sql  (idempotent)
create table if not exists telemetry_rejects (
  day text not null,
  reason text not null,
  event text not null default '',
  prop text not null default '',
  n integer not null default 0,
  primary key (day, reason, event, prop),
  constraint telemetry_rejects_day_shape_chk check (day glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  constraint telemetry_rejects_n_chk check (n >= 0),
  constraint telemetry_rejects_len_chk check (length(reason) <= 32 and length(event) <= 48 and length(prop) <= 48)
) without rowid;

-- Read it: skew-shaped (unknown_prop, missing_prop: a cached client older or
-- newer than the schema) vs bug-shaped (bad_value, unknown_event) is the
-- strict-vs-tolerant question. Request-level reasons count REQUESTS, event-level
-- ones count EVENTS (api/_rejects.js, UNITS):
--   select day, reason, event, prop, n from telemetry_rejects order by day desc, n desc;
