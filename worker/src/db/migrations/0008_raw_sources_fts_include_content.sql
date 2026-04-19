-- Re-index raw_sources_fts to include full source content, not just LLM-generated fields.
-- This ensures raw phrases from source material (e.g. Workflowy bullets) are searchable.

DELETE FROM raw_sources_fts;

-- Summarized sources: summary + keywords + key_entities + raw content
INSERT INTO raw_sources_fts (raw_source_id, user_id, text)
SELECT
  id,
  user_id,
  COALESCE(summary, '') || ' ' || COALESCE(keywords, '') || ' ' || COALESCE(key_entities, '') || ' ' || COALESCE(content, '')
FROM raw_sources
WHERE summarized_at IS NOT NULL AND source_type != 'gcalendar';

-- Calendar events: raw content only (never LLM-summarized)
INSERT INTO raw_sources_fts (raw_source_id, user_id, text)
SELECT id, user_id, COALESCE(content, '')
FROM raw_sources
WHERE source_type = 'gcalendar';
