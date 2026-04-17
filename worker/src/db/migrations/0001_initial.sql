-- ─────────────────────────────────────────────
-- Users
-- ─────────────────────────────────────────────
CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  google_sub  TEXT UNIQUE NOT NULL,
  email       TEXT NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ─────────────────────────────────────────────
-- OAuth tokens (one row per user per provider)
-- ─────────────────────────────────────────────
CREATE TABLE oauth_tokens (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  provider      TEXT NOT NULL DEFAULT 'google',
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    DATETIME NOT NULL,
  scopes        TEXT NOT NULL,
  UNIQUE(user_id, provider)
);

-- ─────────────────────────────────────────────
-- API keys (for agent/CLI access)
-- ─────────────────────────────────────────────
CREATE TABLE api_keys (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  key_hash    TEXT UNIQUE NOT NULL,
  label       TEXT NOT NULL,
  last_used   DATETIME,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_api_keys_user ON api_keys(user_id);

-- ─────────────────────────────────────────────
-- Per-user config (key-value)
-- ─────────────────────────────────────────────
CREATE TABLE config (
  user_id  TEXT NOT NULL REFERENCES users(id),
  key      TEXT NOT NULL,
  value    TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- ─────────────────────────────────────────────
-- Raw source material
-- ─────────────────────────────────────────────
CREATE TABLE raw_sources (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  source_type  TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  content      TEXT NOT NULL,
  metadata     TEXT NOT NULL,
  source_date  DATE NOT NULL,
  ingested_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, source_type, external_id)
);

CREATE INDEX idx_raw_sources_user_date ON raw_sources(user_id, source_date);

-- ─────────────────────────────────────────────
-- Structured Memory Objects (all layers)
-- ─────────────────────────────────────────────
CREATE TABLE smos (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  layer             INTEGER NOT NULL,
  headline          TEXT NOT NULL,
  summary           TEXT NOT NULL,
  keywords          TEXT NOT NULL,
  key_entities      TEXT NOT NULL,
  open_questions    TEXT,
  date_range_start  DATE NOT NULL,
  date_range_end    DATE NOT NULL,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_smos_user_layer_date ON smos(user_id, layer, date_range_start);

-- ─────────────────────────────────────────────
-- Themes (1–5 per SMO)
-- ─────────────────────────────────────────────
CREATE TABLE themes (
  id          TEXT PRIMARY KEY,
  smo_id      TEXT NOT NULL REFERENCES smos(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id),
  headline    TEXT NOT NULL,
  summary     TEXT NOT NULL,
  sort_order  INTEGER NOT NULL
);

CREATE INDEX idx_themes_smo ON themes(smo_id);

-- ─────────────────────────────────────────────
-- Source pointers (SMO → raw_sources or lower-layer SMOs)
-- ─────────────────────────────────────────────
CREATE TABLE source_pointers (
  smo_id       TEXT NOT NULL REFERENCES smos(id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  PRIMARY KEY (smo_id, target_type, target_id)
);

-- ─────────────────────────────────────────────
-- Full-text search index (FTS5)
-- ─────────────────────────────────────────────
CREATE VIRTUAL TABLE smo_fts USING fts5(
  smo_id       UNINDEXED,
  user_id      UNINDEXED,
  layer        UNINDEXED,
  headline,
  keywords,
  key_entities,
  themes_text,
  content=''
);
