-- Add inferred location to Layer 1 SMOs (city, state/province, country)
-- Populated by the LLM from calendar event locations during SMO generation.
-- Nullable: null when no calendar location data is available.
ALTER TABLE smos ADD COLUMN location TEXT;
