-- pdflokal-events · the daily visitor TALLY (2026-10-06). ADDITIVE and idempotent.
--
-- WHY: "N orang hari ini" (api/visitors.js) used to COUNT the day's events on every
-- cache miss (~20k rows read a call; ~276k before d89e654). Turso bills rows READ
-- and the free plan is 500M a month. The tally is maintained on the write path
-- (api/t.js) and read as ONE row, so the count can refresh every minute for less
-- than the hourly scan cost.
--
-- HOW: api/t.js inserts (day, visitor_id) once per visitor per WIB day; a repeat is
-- a no-op (primary key + on conflict do nothing). The trigger fires only when a row
-- is really inserted, so visitor_day_counts.n is exactly count(*) of the day's rows.
-- visitor_days holds one id per visitor-day (~300 rows/day); it is the same id the
-- events rail already carries, so it adds no new identifier.
--
-- Reverse: drop trigger visitor_days_tally; drop table visitor_day_counts; drop table visitor_days;

create table if not exists visitor_days (
  day text not null,          -- WIB calendar date, YYYY-MM-DD, at arrival
  visitor_id text not null,
  primary key (day, visitor_id),
  constraint visitor_days_day_chk check (day glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
) without rowid;

create table if not exists visitor_day_counts (
  day text primary key,
  n integer not null default 0 check (n >= 0)
) without rowid;

create trigger if not exists visitor_days_tally after insert on visitor_days
begin
  insert into visitor_day_counts (day, n) values (new.day, 1)
    on conflict (day) do update set n = n + 1;
end;
