-- pdflokal telemetry rail — FEEDBACK, on Turso (libSQL / SQLite).
-- Port of the `feedback` half of scripts/neon-rail-migration.sql, 2026-09-16.
--
-- ⚠️ ITS OWN DATABASE ON PURPOSE, and this is the whole reason the split
-- exists. This table is the ONE user-authored free field in the product, plus
-- consent-gated PNG crops of an edited line and a JPEG the user pasted
-- themselves. Turso has no GRANT and no row policies — a token is read-only or
-- read-write for a WHOLE database — so the Neon read-only role that granted
-- `select` on `events` and deliberately NOT on `feedback` cannot be expressed
-- inside one Turso database. A separate database IS that grant.
-- The floor alarm gets a read-only token for pdflokal-events and never sees this.

create table if not exists feedback (
  id integer primary key autoincrement,
  ts text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  session_id text not null,
  app_version text not null,
  rating text not null,
  note text,
  sample_before text,
  sample_after text,
  -- ONE JPEG data URL the user pasted themselves (core/feedback-shot.js).
  -- Deliberately its own column and its own check, not folded into
  -- sample_before/after — a PNG crop pair our own code produces and a
  -- user-chosen JPEG are different objects with different consent stories.
  screenshot text,

  constraint feedback_rating_chk check (rating in ('up', 'down')),
  constraint feedback_session_id_shape_chk check (
    session_id glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  constraint feedback_ts_shape_chk check (
    ts glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
  ),

  -- char_length() -> length(). Equivalent on TEXT (both count characters);
  -- length() counts BYTES on a BLOB, which is why nothing here may ever be
  -- stored as one.
  constraint feedback_note_len_chk check (note is null or length(note) <= 1000),

  -- The pairing check is the one with teeth: a half-sample is never storable,
  -- because the defect IS the comparison (his ruling, 2026-07-27).
  constraint feedback_sample_pairing_chk check (
    (sample_before is null and sample_after is null)
    or (sample_before is not null and sample_after is not null)
  ),

  -- ⚠️ GLOB, NOT LIKE — the single most dangerous line in this port. Postgres
  -- LIKE is case-SENSITIVE; SQLite LIKE is case-INSENSITIVE for ASCII. Ported
  -- literally as LIKE, this check would start accepting 'DATA:IMAGE/PNG;BASE64,'
  -- and every other casing, silently widening a constraint whose job is to
  -- guarantee the column holds what it claims. GLOB is case-sensitive and is the
  -- faithful port. `%` becomes `*`.
  constraint feedback_sample_before_shape_chk check (
    sample_before is null
    or (sample_before glob 'data:image/png;base64,*' and length(sample_before) <= 60000)
  ),
  constraint feedback_sample_after_shape_chk check (
    sample_after is null
    or (sample_after glob 'data:image/png;base64,*' and length(sample_after) <= 60000)
  ),
  constraint feedback_sample_total_chk check (
    length(coalesce(sample_before, '')) + length(coalesce(sample_after, '')) <= 115000
  ),
  constraint feedback_screenshot_shape_chk check (
    screenshot is null
    or (screenshot glob 'data:image/jpeg;base64,*' and length(screenshot) <= 280000)
  )
);

-- Neon's live max feedback id is 1,116 (measured 2026-09-16). Seeded at 100,000
-- so a backfill keeps every original id with no possible collision. Cannot be
-- done after the first insert — same law as the events database.
insert into sqlite_sequence (name, seq)
  select 'feedback', 100000
  where not exists (select 1 from sqlite_sequence where name = 'feedback');

create index if not exists feedback_ts_idx on feedback (ts desc);
create index if not exists feedback_rating_idx on feedback (rating);

-- ---- read side ----------------------------------------------------------
-- Daily thumbs split + how many carried a note. Read the NOTES themselves
-- straight from the table — they are the actual signal; this is the rate.
create view if not exists v_feedback as
select date(ts) as day, rating, count(*) as n, count(note) as with_note
from feedback group by 1, 2;

-- Of the thumbs-down, how many carried a sample — his own ~1-2% send-rate
-- expectation, made checkable at a glance. `count(*) filter (where ...)` ports
-- as-is: SQLite has supported FILTER on aggregates since 3.30.
create view if not exists v_feedback_sample as
select date(ts) as day,
       count(*) filter (where rating = 'down') as down_n,
       count(*) filter (where rating = 'down' and sample_before is not null) as down_with_sample
from feedback group by 1;

-- Retention, same as events and equally unscheduled:
--   delete from feedback where ts < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-180 days');
