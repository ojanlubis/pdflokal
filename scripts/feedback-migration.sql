-- PDFLokal — feedback-migration.sql  (BETA edit-feedback loop, 2026-07-22)
-- =============================================================================
-- The thumbs pill's sink. DELIBERATELY separate from the `events` table
-- (telemetry-migration.sql): `events` is machine-typed and string-free by law;
-- THIS table holds the one user-authored free field (a typed note), walled off
-- so the events rail's "no string field ever" invariant is never touched
-- (spec-telemetry.md §2). Same project, same service-role env vars api/
-- feedback.js and api/t.js both use.
--
-- Run once, by hand, against the SAME Supabase project telemetry_events_v1 was
-- applied to (gvtknjudulezpoyhlmzx, FKD org) — via the SQL editor or the MCP's
-- apply_migration. 🤚 FOUNDER'S HAND: a live migration is deploy-class; the PM
-- session never applies it. Additive and low-risk (a fresh table), but it's
-- production infra.

create table if not exists feedback (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  session_id uuid not null,
  app_version text not null,
  rating text not null check (rating in ('up', 'down')),
  -- The one free field. Capped in the DB too (defense in depth — the client
  -- and api/feedback.js both slice to 1000 first). NULL when the user rated
  -- without writing a note (every 👍, and a 👎 they didn't elaborate on).
  note text check (note is null or char_length(note) <= 1000)
);

-- Read patterns: "recent, by rating, notes first". Index the two columns the
-- view below groups on.
create index if not exists feedback_ts_idx on feedback (ts desc);
create index if not exists feedback_rating_idx on feedback (rating);

alter table feedback enable row level security;
revoke all on table feedback from anon, authenticated;
-- No policies — intentional. RLS with zero policies denies anon/authenticated
-- entirely; the service-role key api/feedback.js uses BYPASSES RLS, so inserts
-- from the endpoint keep working and nothing else can read or write. Same
-- posture as the events table.

-- ---- read side: one view so a PM session sees the pulse in one SELECT --------
-- Daily thumbs split + how many carried a note. Read the NOTES themselves
-- straight from the table with the service key (SQL editor / MCP) — they're the
-- actual signal; this view is just the at-a-glance rate.
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

-- security_invoker + revoke: same hardening the events views carry (a default
-- view runs as its owner and would bypass the table's RLS through PostgREST).
revoke all on v_feedback from anon, authenticated;

-- ---- retention: same 180-day posture as events (not scheduled here) ----------
--   delete from feedback where ts < now() - interval '180 days';
