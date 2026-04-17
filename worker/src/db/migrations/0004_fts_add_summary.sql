-- Recreate smo_fts with summary and open_questions added to the indexed fields.
-- FTS5 virtual tables cannot be altered, so we drop and recreate.

DROP TABLE IF EXISTS smo_fts;

CREATE VIRTUAL TABLE smo_fts USING fts5(
  smo_id        UNINDEXED,
  user_id       UNINDEXED,
  layer         UNINDEXED,
  headline,
  summary,
  keywords,
  key_entities,
  themes_text,
  open_questions,
  content=''
);

-- Repopulate from existing data
INSERT INTO smo_fts (smo_id, user_id, layer, headline, summary, keywords, key_entities, themes_text, open_questions)
SELECT
  s.id,
  s.user_id,
  s.layer,
  s.headline,
  s.summary,
  s.keywords,
  s.key_entities,
  COALESCE(
    (SELECT GROUP_CONCAT(t.headline || ' ' || t.summary, ' ')
     FROM themes t WHERE t.smo_id = s.id),
    ''
  ),
  COALESCE(s.open_questions, '')
FROM smos s;
