-- Re-index raw_sources_fts to include key_decisions and open_questions.
DELETE FROM raw_sources_fts;

-- Summarized sources: all LLM-generated fields
INSERT INTO raw_sources_fts (raw_source_id, user_id, text)
SELECT
  id,
  user_id,
  COALESCE(summary, '') || ' ' ||
  COALESCE(keywords, '') || ' ' ||
  COALESCE(key_entities, '') || ' ' ||
  COALESCE(key_decisions, '') || ' ' ||
  COALESCE(open_questions, '')
FROM raw_sources
WHERE summarized_at IS NOT NULL AND source_type != 'gcalendar';

-- Calendar events: raw content only (never LLM-summarized)
INSERT INTO raw_sources_fts (raw_source_id, user_id, text)
SELECT id, user_id, COALESCE(content, '')
FROM raw_sources
WHERE source_type = 'gcalendar';
