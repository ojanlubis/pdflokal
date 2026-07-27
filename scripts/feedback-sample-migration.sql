-- PDFLokal — feedback-sample-migration.sql  (Increment D — consent-gated
-- sample, spec-edit-fidelity-instrumentation.md, 2026-07-27)
-- =============================================================================
-- Adds the two opt-in crop columns to the EXISTING `feedback` table
-- (feedback-migration.sql, 2026-07-22). Additive only — no new table, no
-- column drops, nothing touches `events` (the string-free rail stays
-- string-free; this is the feedback table's own free-field territory,
-- widened by two more optional strings).
--
-- What these columns hold: a PNG data URL (`data:image/png;base64,...`) of
-- the pristine ("before") and stamped ("after") render of the ONE line the
-- user edited, cropped to that line's own box — sent ONLY when the user
-- tapped 👎, saw the exact crops rendered in the pill, and tapped Kirim.
-- 👍, "Nggak usah", abandoning, or closing the pill all send rating (+note)
-- with these two columns left NULL — exactly like every 👎 before this
-- increment. Never the page, never the file (decisions.md 2026-07-23/
-- 2026-07-27 — "filemu nggak pernah pergi ke server" stays true).
--
-- Caps mirror js/core/feedback-sample.js + api/feedback.js's own re-check
-- (never trust the client alone): 40KB raw PNG bytes per crop -> base64 is
-- ~1.333x that -> ceil(40*1024/3)*4 = 54616 base64 chars + the 23-char
-- "data:image/png;base64," prefix = 54639. The per-column check below rounds
-- up to 60000 for headroom (canvas encoders can vary slightly). The combined
-- raw cap is 70KB (deliberately LESS than 2x the per-crop cap — a real
-- second gate, not a restatement of the first; see core/feedback-sample.js's
-- own WHY) -> ceil(70*1024/3)*4 = 95576 base64 chars + two prefixes (46) =
-- 95622; the combined check below rounds up to 115000 for the same headroom.
--
-- Run once, by hand, against the SAME Supabase project feedback-migration.sql
-- was applied to (gvtknjudulezpoyhlmzx, FKD org) — via the SQL editor or the
-- MCP's apply_migration. 🤚 FOUNDER'S HAND: a live migration is deploy-class;
-- the PM/builder session never applies it. NOT YET APPLIED as of this file's
-- authorship — samples cannot land in the table until this runs.

alter table feedback
  add column if not exists sample_before text,
  add column if not exists sample_after text;

-- Shape + size guard, defense in depth alongside the app-layer caps. Both
-- columns share ONE constraint so "one present, one missing" (a partial
-- sample — never storable, per api/feedback.js's validateSample()) is
-- rejected at the DB layer too, not just the API layer.
alter table feedback
  add constraint feedback_sample_pairing_chk
    check (
      (sample_before is null and sample_after is null)
      or (sample_before is not null and sample_after is not null)
    );

alter table feedback
  add constraint feedback_sample_before_shape_chk
    check (
      sample_before is null
      or (sample_before like 'data:image/png;base64,%' and char_length(sample_before) <= 60000)
    );

alter table feedback
  add constraint feedback_sample_after_shape_chk
    check (
      sample_after is null
      or (sample_after like 'data:image/png;base64,%' and char_length(sample_after) <= 60000)
    );

alter table feedback
  add constraint feedback_sample_total_chk
    check (
      char_length(coalesce(sample_before, '')) + char_length(coalesce(sample_after, '')) <= 115000
    );

-- ---- read side: how often the bonus sample actually lands ------------------
-- v_feedback (feedback-migration.sql) already gives the daily thumbs split;
-- this sibling view adds "of the 👎s, how many carried a sample" — the
-- founder's own ~1-2% send-rate expectation, made checkable at a glance.
create or replace view v_feedback_sample
with (security_invoker = on) as
select
  date_trunc('day', ts) as day,
  count(*) filter (where rating = 'down') as down_n,
  count(*) filter (where rating = 'down' and sample_before is not null) as down_with_sample
from feedback
group by 1
order by 1 desc;

revoke all on v_feedback_sample from anon, authenticated;
