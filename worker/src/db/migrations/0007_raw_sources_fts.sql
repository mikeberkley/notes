-- FTS index for raw source summaries, enabling search to surface parent SMOs
-- through their linked source content (not just the SMO-level summary/keywords).
CREATE VIRTUAL TABLE IF NOT EXISTS raw_sources_fts USING fts5(
  raw_source_id UNINDEXED,
  user_id UNINDEXED,
  text,
  tokenize='porter ascii'
);

-- Backfill: LLM-summarized sources (gmail, gdrive, workflowy, slack)
INSERT INTO raw_sources_fts (raw_source_id, user_id, text)
SELECT
  id,
  user_id,
  COALESCE(summary, '') || ' ' || COALESCE(keywords, '') || ' ' || COALESCE(key_entities, '')
FROM raw_sources
WHERE summarized_at IS NOT NULL;

-- Backfill: calendar events (short structured content, never LLM-summarized)
INSERT INTO raw_sources_fts (raw_source_id, user_id, text)
SELECT id, user_id, content
FROM raw_sources
WHERE source_type = 'gcalendar';
