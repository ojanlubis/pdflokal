-- PDFLokal — neon-rail-migration.sql   (the whole rail, on Neon)
-- =============================================================================
-- Applied 2026-08-23 to Neon project `lively-cloud-08397659` ("pdflokal",
-- aws-ap-southeast-1, Postgres 18), database `neondb`. This file REPLACES the
-- three Supabase migrations it was ported from — telemetry-migration.sql,
-- feedback-migration.sql, feedback-sample-migration.sql — which described the
-- same two tables on Supabase project gvtknjudulezpoyhlmzx. Those three were a
-- historical sequence (a table, then a sibling table, then two columns added);
-- this is their SNAPSHOT, because a fresh database has no history to replay.
-- Runbook and the why of the move: seat `specs/spec-rail-to-neon.md`.
--
-- WHAT CHANGED IN THE PORT, and it is entirely about who can reach the data:
--
--   Supabase put PostgREST in front of the database, so anything reachable by
--   the anon key was reachable by the whole internet. Every `revoke ... from
--   anon, authenticated`, the `enable row level security` with deliberately
--   zero policies, and `security_invoker` on the views existed to shut that
--   front door. **Neon has no front door.** There is no PostgREST, no anon
--   role, no authenticated role, and (deliberately — see the runbook) no Neon
--   Data API. The only way in is the connection string, which lives in Vercel's
--   encrypted env and is read by two serverless functions.
--
--   So the roles and revokes are DROPPED — not relaxed, absent: `revoke ... from
--   anon` would simply error, the role does not exist. RLS is dropped for the
--   same reason: it protected against a reader that cannot exist here, and an
--   RLS policy nothing evaluates is decoration that a future reader would
--   mistake for a control.
--
--   `security_invoker` on the views is KEPT. It costs nothing, and it is the one
--   line that would still be load-bearing if a Data API were ever added — the
--   default (view runs as its OWNER) is precisely what let a Supabase anon key
--   read aggregates off an RLS-denied table before it was hardened on
--   2026-07-20. Keeping it means that hardening does not have to be
--   rediscovered.

-- ---- events: the machine-typed rail, string-free by law -----------------------
-- (spec-telemetry.md §1/§5/§6. `props` never carries a user-authored string;
-- that is the feedback table's territory, below.)

create table if not exists events (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  session_id uuid not null,
  app_version text not null,
  event text not null,
  props jsonb not null default '{}'::jsonb
);

-- Read patterns are always "recent, by event, filtered on a prop". props is
-- jsonb with no GIN index on purpose — the read volume (PM sessions, ad hoc)
-- does not justify the write-side cost. Add `using gin (props)` if a specific
-- prop lookup ever becomes a hot path.
create index if not exists events_ts_idx on events (ts desc);
create index if not exists events_event_idx on events (event);

-- ---- feedback: the ONE user-authored free field in the product ---------------
-- Deliberately a separate table so the events rail's "no string field ever"
-- invariant is never touched (spec-telemetry.md §2). `sample_before`/
-- `sample_after` are the consent-gated PNG crops of a single edited line —
-- sent only when the user tapped 👎, SAW the exact crops, and tapped Kirim.
-- Never the page, never the file.

create table if not exists feedback (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  session_id uuid not null,
  app_version text not null,
  rating text not null check (rating in ('up', 'down')),
  note text check (note is null or char_length(note) <= 1000),
  sample_before text,
  sample_after text,

  -- Defense in depth: js/core/feedback-sample.js and api/feedback.js both
  -- enforce these caps before a row is ever built. The DB enforces them again
  -- because "never trust the client alone" applies to our own client too.
  --
  -- The pairing check is the one with teeth: a half-sample is never storable,
  -- because the defect IS the comparison (his ruling, 2026-07-27). 60000 and
  -- 115000 are the base64 lengths of the 40KB-per-crop and 70KB-combined raw
  -- caps, rounded up for encoder variance — full arithmetic in the file this
  -- was ported from (git: app/scripts/feedback-sample-migration.sql).
  constraint feedback_sample_pairing_chk check (
    (sample_before is null and sample_after is null)
    or (sample_before is not null and sample_after is not null)
  ),
  constraint feedback_sample_before_shape_chk check (
    sample_before is null
    or (sample_before like 'data:image/png;base64,%' and char_length(sample_before) <= 60000)
  ),
  constraint feedback_sample_after_shape_chk check (
    sample_after is null
    or (sample_after like 'data:image/png;base64,%' and char_length(sample_after) <= 60000)
  ),
  constraint feedback_sample_total_chk check (
    char_length(coalesce(sample_before, '')) + char_length(coalesce(sample_after, '')) <= 115000
  )
);

create index if not exists feedback_ts_idx on feedback (ts desc);
create index if not exists feedback_rating_idx on feedback (rating);

-- ---- identity sequences: leave room for the backfill --------------------------
-- ⚠️ THE ONE STEP THAT CANNOT BE DONE LATER WITHOUT PAIN. The 47,396 events and
-- 37 feedback rows carried over from Supabase keep their original ids (they are
-- referenced by nothing, but a re-run of the backfill must be a no-op, and
-- `on conflict (id) do nothing` is what makes it one). Supabase's high-water
-- marks at port time: events 47529, feedback 38.
--
-- Starting new ids at 1,000,000 / 1,000 does two jobs: no new row can ever
-- collide with a backfilled one, and the id itself says where the row came from
-- — under a million means it lived on Supabase. Ordering across the boundary
-- stays honest because every new row postdates every old one.
alter table events alter column id restart with 1000000;
alter table feedback alter column id restart with 1000;

-- ---- read side: 4 views, so a PM session sees the shape in one SELECT ---------

-- Daily volume per event — the first thing to look at before writing any spec:
-- is the wild sending anything at all.
create or replace view v_daily_events
with (security_invoker = on) as
select
  date_trunc('day', ts) as day,
  event,
  count(*) as n
from events
group by 1, 2
order by 1 desc, 2;

-- The honesty rate: how often the real world declines each rung of the ladder,
-- and why, verbatim per the code's own named reasons (js/core/telemetry-schema.js).
create or replace view v_decline_reasons
with (security_invoker = on) as
select
  event,
  props->>'reason' as reason,
  count(*) as n
from events
where event in ('surgery', 'insert', 'block_edit')
  and props ? 'reason'
group by 1, 2
order by 1, n desc;

-- commit_paint latency percentiles by device class. `duration` is stored as a
-- number inside props, so it is cast numeric here rather than compared as text.
create or replace view v_commit_latency
with (security_invoker = on) as
select
  props->>'device' as device,
  percentile_cont(0.5) within group (order by (props->>'duration')::numeric) as p50_ms,
  percentile_cont(0.9) within group (order by (props->>'duration')::numeric) as p90_ms,
  percentile_cont(0.99) within group (order by (props->>'duration')::numeric) as p99_ms,
  count(*) as n
from events
where event = 'commit_paint'
  and props ? 'duration'
group by 1
order by 1;

-- Daily thumbs split + how many carried a note. Read the NOTES themselves
-- straight from the table — they are the actual signal; this is the at-a-glance rate.
create or replace view v_feedback
with (security_invoker = on) as
select
  date_trunc('day', ts) as day,
  rating,
  count(*) as n,
  count(note) as with_note
from feedback
group by 1, 2
order by 1 desc, 2;

-- Of the 👎s, how many carried a sample — his own ~1-2% send-rate expectation,
-- made checkable at a glance.
create or replace view v_feedback_sample
with (security_invoker = on) as
select
  date_trunc('day', ts) as day,
  count(*) filter (where rating = 'down') as down_n,
  count(*) filter (where rating = 'down' and sample_before is not null) as down_with_sample
from feedback
group by 1
order by 1 desc;

-- ---- retention (spec §2/§7): 180 days, instrumentation not a warehouse --------
-- NOT scheduled here, and it never was on Supabase either. Run periodically:
--   delete from events   where ts < now() - interval '180 days';
--   delete from feedback where ts < now() - interval '180 days';
