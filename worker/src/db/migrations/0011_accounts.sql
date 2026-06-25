-- Add multi-account support
ALTER TABLE users ADD COLUMN ingestion_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN owner_user_id TEXT REFERENCES users(id);
