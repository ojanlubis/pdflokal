-- pdflokal FEEDBACK database (Turso / libSQL / SQLite): the feature vote, ROUND 2.
-- Founder's call 2026-10-23: round 2 is a fresh ballot box. Round 1's rows stay EXACTLY
-- as they are; everyone, round-1 voters included, is asked again.
--
-- ADDITIVE AND IDEMPOTENT: one new table and one index, `if not exists` on both, so
-- running this twice is a no-op. It never ALTERs, DROPs or DELETEs anything: not
-- feature_ballots (round 1), not feature_requests (the free-text ideas, which keep
-- their one table across rounds: an idea is told apart by its ts), not feedback.
-- Apply it to the pdflokal-FEEDBACK database (the one holding feature_ballots), the
-- one the rail's read-only watch token cannot read.
-- ⚠️ MUST BE APPLIED BEFORE THE CODE THAT WRITES IT SHIPS (merge the PR after this).
-- Until the table exists a round-2 ballot's insert fails (logged by code only), the
-- endpoint answers 503 and the card says the vote did not go through; nothing is lost
-- silently, but nobody can vote.
--
-- Same shape and same CHECK constraints as feature_ballots
-- (scripts/turso-feedback-migration.sql), because it is the same object. Only the
-- features of round 2 differ, and the column does not enforce the list (the endpoint does).
create table if not exists feature_ballots_r2 (
  -- Lowercase UUID: api/votes.js lowercases it, so 'ABC...' and 'abc...' are one voter.
  -- PRIMARY KEY = the one-ballot rule, per round: a visitor who voted in round 1 has no
  -- row here, so they can vote once more; a second round-2 ballot is refused by the DATABASE.
  visitor_id text primary key,
  ts text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- The page language the ballot was cast on ('id' or 'en'); null if not sent.
  lang text,
  -- 1 when the same send also carried a free-text idea (the idea itself is in feature_requests).
  has_text integer not null default 0,
  -- JSON array of feature ids from js/core/features.js, at most 3, e.g. ["form-fill","batch"].
  features text not null default '[]',

  constraint feature_ballots_r2_visitor_id_shape_chk check (
    visitor_id glob '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
  ),
  constraint feature_ballots_r2_ts_shape_chk check (
    ts glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]*Z'
  ),
  constraint feature_ballots_r2_lang_chk check (lang is null or lang in ('id', 'en')),
  constraint feature_ballots_r2_has_text_chk check (has_text in (0, 1)),
  constraint feature_ballots_r2_features_chk check (
    json_valid(features) and json_type(features) = 'array' and json_array_length(features) <= 3
  ),
  -- A ballot is a choice or an idea, never nothing.
  constraint feature_ballots_r2_not_empty_chk check (json_array_length(features) > 0 or has_text = 1)
);
create index if not exists feature_ballots_r2_ts_idx on feature_ballots_r2 (ts desc);
