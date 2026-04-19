export interface Env {
  DB: D1Database;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL: string;
  SESSION_SECRET: string;
  APP_URL: string;
  API_URL: string;
}

export interface User {
  id: string;
  google_sub: string;
  email: string;
  created_at: string;
}

export interface OAuthToken {
  id: string;
  user_id: string;
  provider: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scopes: string;
}

export interface ApiKey {
  id: string;
  user_id: string;
  key_hash: string;
  label: string;
  last_used: string | null;
  created_at: string;
}

export interface RawSource {
  id: string;
  user_id: string;
  source_type: 'gmail' | 'gdrive' | 'workflowy' | 'slack' | 'gcalendar' | 'chat';
  external_id: string;
  content: string;
  metadata: string;
  source_date: string;
  ingested_at: string;
  // Per-source mini-summary fields (NULL until summarized)
  summary: string | null;
  key_decisions: string | null;   // JSON array
  key_entities: string | null;    // JSON array
  keywords: string | null;        // JSON array
  open_questions: string | null;
  summarized_at: string | null;   // set on success; remains NULL on failure so re-runs can retry
  summary_error: string | null;   // set on failure for debuggability
}

export interface Smo {
  id: string;
  user_id: string;
  layer: 1 | 2 | 3;
  headline: string;
  summary: string;
  keywords: string;       // JSON array
  key_entities: string;   // JSON array
  key_decisions: string | null;  // JSON array
  open_questions: string | null;
  location: string | null;
  date_range_start: string;
  date_range_end: string;
  created_at: string;
}

export interface Theme {
  id: string;
  smo_id: string;
  user_id: string;
  headline: string;
  summary: string;
  sort_order: number;
}

export interface SessionPayload {
  sub: string;   // user.id
  email: string;
  iat: number;
  exp: number;
}
