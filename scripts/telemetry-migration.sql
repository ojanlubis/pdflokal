-- PDFLokal — telemetry-migration.sql  (spec-telemetry.md §1/§5/§6)
-- =============================================================================
-- One table (events), RLS on with ZERO policies (service key bypasses RLS
-- entirely; anon/authenticated get nothing — no policy means no access), and
-- the three canonical read-side views the spec asks for so PM sessions can
-- query distributions/funnels/latency in one SELECT, not archaeology.
--
-- Run this once, by hand, against the Supabase project Fauzan creates/blesses
-- for telemetry (🤚 spec §1) — via the Supabase SQL editor or the MCP's
-- apply_migration. Nothing here depends on any other pdflokal table.

create table if not exists events (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  session_id uuid not null,
  app_version text not null,
  event text not null,
  props jsonb not null default '{}'::jsonb
);

-- Read patterns are always "recent, by event, filtered on a prop" — index the
-- two columns every view below actually filters/groups on. props is jsonb
-- without a GIN index on purpose: v1's read volume (PM sessions, ad hoc) does
-- not justify the write-side cost yet: add one (`using gin (props)`) if a
-- specific prop lookup becomes a hot path.
create index if not exists events_ts_idx on events (ts desc);
create index if not exists events_event_idx on events (event);

alter table events enable row level security;
revoke all on table events from anon, authenticated;
-- No policies are created — intentionally. RLS with zero policies denies
-- ALL access to anon and authenticated roles by default in PostgREST. The
-- service-role key api/t.js uses BYPASSES RLS entirely (Supabase's
-- service_role always does, policies or not), so inserts from the endpoint
-- keep working; nothing else — no client, no anon key — can read or write.

-- ---- read side (spec §5): 3 canonical views, one query not archaeology --------

-- Daily volume per event — the first thing any PM session should look at
-- before writing a new spec: is the wild sending anything at all.
create or replace view v_daily_events
with (security_invoker = on) as
select
  date_trunc('day', ts) as day,
  event,
  count(*) as n
from events
group by 1, 2
order by 1 desc, 2;

-- Decline-reason distribution across every ladder event that carries a
-- `reason` prop (surgery / insert / block_edit) — the honesty rate: how often
-- the real world declines each rung, and why, verbatim per the code's own
-- named reasons (js/core/telemetry-schema.js's SCHEMA).
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

-- commit_paint latency percentiles by device class — the spike's missing
-- Android column, now live from day one of the ladder merge. duration is
-- stored as a number (ms, already clamped+rounded by durationBucket()) inside
-- props, so it's cast numeric here rather than compared as text.
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

-- WHY security_invoker + revokes (hardening, applied 2026-07-20): a default
-- Postgres view runs with its OWNER's privileges, which BYPASSES the events
-- table's RLS — through PostgREST the anon key could have read the aggregate
-- views even though the table denies everything. security_invoker=on makes
-- each view respect the CALLER's rights (PG15+), and the revokes close direct
-- REST access to the views themselves. Applied to project gvtknjudulezpoyhlmzx
-- as migration telemetry_events_v1 (this file is its source of truth).
revoke all on v_daily_events, v_decline_reasons, v_commit_latency from anon, authenticated;

-- ---- retention (spec §2/§7): 180 days, instrumentation not a warehouse --------
-- This is NOT scheduled by this migration (no pg_cron dependency assumed).
-- Run on a schedule (pg_cron, or a periodic call from a PM/ops session):
--   delete from events where ts < now() - interval '180 days';
