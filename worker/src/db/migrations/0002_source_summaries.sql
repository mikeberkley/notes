-- Add per-source mini-summary fields to raw_sources.
-- All columns are nullable — NULL means not yet summarized.
-- The SMO generation pipeline summarizes first, then falls back to raw content if NULL.

ALTER TABLE raw_sources ADD COLUMN summary         TEXT;
ALTER TABLE raw_sources ADD COLUMN key_decisions   TEXT;  -- JSON array of strings
ALTER TABLE raw_sources ADD COLUMN key_entities    TEXT;  -- JSON array of strings
ALTER TABLE raw_sources ADD COLUMN keywords        TEXT;  -- JSON array of strings
ALTER TABLE raw_sources ADD COLUMN open_questions  TEXT;  -- plain string or null
ALTER TABLE raw_sources ADD COLUMN summarized_at   DATETIME;
