-- Track summarization failures so we can distinguish "never tried" from "tried and failed".
-- summary_error is set on failure; summarized_at remains NULL on failure so re-runs can retry.
ALTER TABLE raw_sources ADD COLUMN summary_error TEXT;
