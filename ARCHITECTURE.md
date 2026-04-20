# Notes App — Architecture & Implementation Reference

**Last updated:** 2026-04-19  
**Status:** Built and deployed ✅  
**Latest addition:** Intelligence layer (multi-turn Q&A over filtered memories)

---

## 1. Product Overview

A personal notes intelligence app that ingests daily content from Gmail, Google Drive, and Workflowy, uses an LLM to distill it into a structured memory hierarchy, and exposes both a search interface for human use and a read-only agent API for external AI agents and CLI tools to efficiently load context without wasting tokens. The search page includes a multi-turn intelligence layer that answers questions grounded in the currently-filtered set of memories.

**URL:** notes.lost2038.com  
**Current users:** Single (owner), schema designed for future multi-user expansion.

---

## 2. Live Infrastructure

| Resource | Value |
|---|---|
| Frontend (Cloudflare Pages) | https://notes.lost2038.com |
| API Worker | https://notes-api.lost2038.com |
| Cloudflare Account ID | `74088836dff42e8f84630c2a7a51a4aa` |
| D1 Database | `notes-db` · ID `dfebbfc2-db8e-43fb-a203-355cca9d6f45` |
| R2 Backup Bucket | `notes-db-backups` |
| Worker name | `notes-api` |
| Pages project name | `notes` |
| Google OAuth Client ID | `833938843826-7gtm93vcocguqumj89q13oc53firfpsa.apps.googleusercontent.com` |
| Google Cloud OAuth redirect URI | `https://notes-api.lost2038.com/api/auth/callback` |
| OpenRouter default model | `anthropic/claude-sonnet-4-6` |

---

## 3. System Architecture

```
┌─────────────────────────────────┐     ┌──────────────────────────────────────┐
│   Cloudflare Pages              │     │   Cloudflare Worker                  │
│   notes.lost2038.com            │────▶│   notes-api.lost2038.com             │
│                                 │     │                                      │
│   React + Vite + Tailwind       │     │   - REST API (browser, session auth) │
│   - Login page                  │     │   - Agent API (CLI/AI, API key auth) │
│   - Search page (index)         │     │   - Google OAuth flow                │
│   - SMO drill-down              │     │   - Ingestion pipeline               │
│   - Settings page               │     │   - LLM summarization                │
└─────────────────────────────────┘     │   - Cron triggers                    │
                                        └──────────────┬───────────────────────┘
 ┌──────────────────────────────┐                      │
 │  External Agents / CLI       │                      │
 │  (Claude Code, scripts, etc) │──── API key ────────▶│
 │  notes context --budget 4000 │                      │
 └──────────────────────────────┘      ┌───────────────┼───────────────────────┐
                                       │               │                       │
                                ┌──────▼──────┐  ┌─────▼───────────┐  ┌───────▼─────────────┐
                                │ Cloudflare  │  │  Google APIs    │  │  OpenRouter         │
                                │ D1 (SQLite) │  │  - Gmail        │  │  model: kimi-k2     │
                                │ R2 (backups)│  │  - Drive        │  │  (configurable)     │
                                └─────────────┘  └─────────────────┘  └─────────────────────┘
                                                 ┌─────────────────┐
                                                 │  Workflowy API  │
                                                 └─────────────────┘
```

---

## 4. Repository Structure

```
notes/                              ← repo root (Cloudflare Pages deploys from here)
├── src/                            ← React frontend (TypeScript)
│   ├── pages/
│   │   ├── Login.tsx               ← "Sign in with Google" page
│   │   ├── Search.tsx              ← index page post-auth, FTS search UI + SMO cards
│   │   ├── SMODetail.tsx           ← drill-down view with theme/source expansion
│   │   ├── SourceDetail.tsx        ← per-source detail page (/source/:id, opens in new tab)
│   │   └── Settings.tsx            ← OAuth status, Drive folder, API key mgmt
│   ├── lib/
│   │   └── api.ts                  ← typed fetch client for Worker API
│   └── App.tsx                     ← client-side router (path-based, no router lib)
├── worker/                         ← Cloudflare Worker
│   ├── src/
│   │   ├── index.ts                ← entry point, all route dispatch
│   │   ├── types.ts                ← Env interface + all shared types
│   │   ├── auth/
│   │   │   ├── google.ts           ← OAuth 2.0 redirect + callback handler
│   │   │   └── session.ts          ← HS256 JWT (hand-rolled, no deps) + cookie helpers
│   │   ├── ingestion/
│   │   │   ├── gmail.ts            ← Gmail API: list + fetch messages, extract text/plain
│   │   │   ├── gdrive.ts           ← Drive API: list files, export Docs/Slides, download others
│   │   │   ├── workflowy.ts        ← Workflowy API: /nodes-export, tree grouping, indented outline
│   │   │   └── pipeline.ts         ← orchestrates ingestion for all users
│   │   ├── llm/
│   │   │   ├── openrouter.ts       ← OpenRouter chat completions client
│   │   │   ├── prompts.ts          ← Layer 1 and Layer 2/3 rollup prompt builders
│   │   │   └── smo.ts              ← SMO generation + LOA rollup logic + JSON parsing
│   │   ├── db/
│   │   │   ├── migrations/
│   │   │   │   └── 0001_initial.sql
│   │   │   ├── queries.ts          ← typed D1 query helpers (all DB access goes here)
│   │   │   └── utils.ts            ← randomUUID, hashKey, generateRawApiKey, date helpers
│   │   ├── agent/
│   │   │   ├── router.ts           ← /agent/* route handler
│   │   │   ├── context.ts          ← context assembly + ~4-char-per-token budget logic
│   │   │   └── apikeys.ts          ← Bearer token auth middleware
│   │   ├── intelligence/
│   │   │   ├── context.ts          ← assembles SMO + source context for intelligence queries
│   │   │   └── query.ts            ← POST /api/intelligence/query SSE streaming handler
│   │   ├── cron/
│   │   │   └── scheduler.ts        ← scheduled() handler, dispatches by UTC hour:minute
│   │   └── utils/
│   │       └── responses.ts        ← json(), notFound(), unauthorized(), cors() helpers
│   ├── cli/
│   │   └── notes.js                ← notes CLI (Node ESM, no deps)
│   ├── src/
│   │   ├── auth/
│   │   │   └── session.test.ts     ← JWT create/verify/tamper/expire tests
│   │   ├── db/
│   │   │   └── utils.test.ts       ← daysAgo, isFriday, isLastFridayOfMonth tests
│   │   └── llm/
│   │       └── smo.test.ts         ← parseLLMResponse, parseSourceSummaryResponse tests
│   ├── wrangler.toml
│   ├── vitest.config.ts
│   ├── tsconfig.json
│   └── package.json
├── .github/
│   └── workflows/
│       ├── deploy.yml              ← pushes to main auto-deploy frontend to Pages
│       └── backup.yml              ← weekly D1 export to R2 (every Sunday 04:00 UTC)
├── .env.production                 ← VITE_API_URL baked in at build time
├── index.html
├── vite.config.js
├── tsconfig.json
├── tailwind.config.js
└── package.json
```

---

## 5. Database Schema (Cloudflare D1)

Migration file: `worker/src/db/migrations/0001_initial.sql`  
Applied: ✅ local + remote

```sql
-- Users
CREATE TABLE users (
  id          TEXT PRIMARY KEY,           -- UUID
  google_sub  TEXT UNIQUE NOT NULL,       -- Google OAuth "sub" claim
  email       TEXT NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- OAuth tokens (one row per user per provider)
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

-- API keys (for agent/CLI access)
CREATE TABLE api_keys (
  id          TEXT PRIMARY KEY,           -- UUID (returned to user on creation)
  user_id     TEXT NOT NULL REFERENCES users(id),
  key_hash    TEXT UNIQUE NOT NULL,       -- SHA-256 hash; plaintext never stored
  label       TEXT NOT NULL,
  last_used   DATETIME,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_api_keys_user ON api_keys(user_id);

-- Per-user config (key-value)
CREATE TABLE config (
  user_id  TEXT NOT NULL REFERENCES users(id),
  key      TEXT NOT NULL,
  value    TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
-- Keys used: gdrive_folder_id, workflowy_api_key

-- Raw source material (source of truth)
CREATE TABLE raw_sources (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  source_type    TEXT NOT NULL,             -- 'gmail' | 'gdrive' | 'workflowy'
  external_id    TEXT NOT NULL,
  content        TEXT NOT NULL,
  metadata       TEXT NOT NULL,             -- JSON: subject/sender/filename/mime_type/etc.
  source_date    DATE NOT NULL,
  ingested_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  -- Per-source mini-summary (populated before SMO generation; NULL = not yet summarized)
  summary        TEXT,
  key_decisions  TEXT,                      -- JSON array
  key_entities   TEXT,                      -- JSON array
  keywords       TEXT,                      -- JSON array
  open_questions TEXT,
  summarized_at  DATETIME,
  UNIQUE(user_id, source_type, external_id)
);
CREATE INDEX idx_raw_sources_user_date ON raw_sources(user_id, source_date);

-- Structured Memory Objects (all layers)
CREATE TABLE smos (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  layer             INTEGER NOT NULL,     -- 1=day, 2=week, 3=month
  headline          TEXT NOT NULL,
  summary           TEXT NOT NULL,
  keywords          TEXT NOT NULL,        -- JSON array
  key_entities      TEXT NOT NULL,        -- JSON array
  key_decisions     TEXT,                 -- JSON array (migration 0009)
  open_questions    TEXT,                 -- newline-separated list of items
  location          TEXT,                 -- "City, Country" inferred from calendar (migration 0006)
  date_range_start  DATE NOT NULL,
  date_range_end    DATE NOT NULL,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_smos_user_layer_date ON smos(user_id, layer, date_range_start);

-- Themes (1–5 per SMO)
CREATE TABLE themes (
  id          TEXT PRIMARY KEY,
  smo_id      TEXT NOT NULL REFERENCES smos(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id),
  headline    TEXT NOT NULL,
  summary     TEXT NOT NULL,              -- exactly 2 sentences
  sort_order  INTEGER NOT NULL
);
CREATE INDEX idx_themes_smo ON themes(smo_id);

-- Source pointers (SMO → raw_sources or lower-layer SMOs)
CREATE TABLE source_pointers (
  smo_id       TEXT NOT NULL REFERENCES smos(id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL,             -- 'raw_source' | 'smo'
  target_id    TEXT NOT NULL,
  PRIMARY KEY (smo_id, target_type, target_id)
);

-- Full-text search (FTS5) — SMO level
-- content='' was removed (migration 0005) — contentless tables don't store UNINDEXED
-- columns, breaking JOINs. The table now stores its own copy of all columns.
CREATE VIRTUAL TABLE smo_fts USING fts5(
  smo_id        UNINDEXED,
  user_id       UNINDEXED,
  layer         UNINDEXED,
  headline,
  summary,
  keywords,
  key_entities,
  themes_text,
  open_questions
);

-- Full-text search (FTS5) — source level (migration 0007, extended in 0010)
-- Indexes LLM-generated summary fields; populated by saveSourceSummary()
-- and directly for gcalendar sources (no LLM summarization).
CREATE VIRTUAL TABLE raw_sources_fts USING fts5(
  raw_source_id  UNINDEXED,
  user_id        UNINDEXED,
  text           -- summary + keywords + key_entities + key_decisions + open_questions (concatenated)
);
```

### Applied migrations

| Migration | What it does |
|---|---|
| `0001_initial.sql` | Base schema (all tables above) |
| `0002_source_summaries.sql` | Add `summary`, `key_decisions`, `key_entities`, `keywords`, `open_questions`, `summarized_at` to `raw_sources` |
| `0003_source_summary_error.sql` | Add `summary_error` column to `raw_sources` for logging LLM failures |
| `0004_fts_add_summary.sql` | Backfill `smo_fts` with summary data |
| `0005_fts_fix_contentless.sql` | Rebuild `smo_fts` as non-contentless (fix UNINDEXED column issue) |
| `0006_add_location.sql` | Add `location` column to `smos`; add `location` to `smo_fts` |
| `0007_raw_sources_fts.sql` | Create `raw_sources_fts` virtual table; populate from summarized sources |
| `0008_raw_sources_fts_include_content.sql` | Re-index `raw_sources_fts` (LLM summary fields only; content excluded for precision) |
| `0009_smos_key_decisions.sql` | Add `key_decisions TEXT` column to `smos` |
| `0010_fts_add_decisions_questions.sql` | Re-index `raw_sources_fts` to include `key_decisions` and `open_questions` fields from `raw_sources` |

---

## 6. Worker API Routes

All routes require a valid session cookie except `/api/auth/*`.  
Base URL: `https://notes-api.lost2038.com`

```
Authentication
  GET  /api/auth/google           → redirect to Google OAuth consent screen
  GET  /api/auth/callback         → handle OAuth callback, set session cookie
  POST /api/auth/logout           → clear session cookie
  GET  /api/auth/me               → { id, email } of current user

Search
  GET  /api/search?q=&layer=&from=&to=
       → [{ smo_id, layer, headline, date_range_start, date_range_end, snippet }]

SMOs
  GET  /api/smos?layer=1&date=YYYY-MM-DD    → list SMOs for a given layer/date
  GET  /api/smos/:id                         → full SMO with themes
  GET  /api/smos/:id/children                → child SMOs (for drill-down)
  GET  /api/smos/:id/sources                 → source_pointers for this SMO
  GET  /api/smos/:id/source-summaries        → filtered source list for SMO card display
       → [{ id, source_type, label, source_url, has_key_decisions }]
       Excludes gcalendar; excludes gmail sources with no key decisions.

Raw Sources
  GET  /api/raw-sources/:id                  → full raw source with all fields parsed
       Returns all DB columns including summary, key_decisions[], key_entities[],
       keywords[], open_questions, summarized_at, summary_error, metadata (parsed JSON)

Settings
  GET  /api/settings                         → { gdrive_folder_id, workflowy_api_key: '••••••••' | null,
                                                intelligence_system_prompt, intelligence_context,
                                                connections: { google } }
  PUT  /api/settings                         → update config values (gdrive_folder_id, workflowy_api_key,
                                                intelligence_system_prompt, intelligence_context)

Intelligence
  POST /api/intelligence/query
       Body: { question, history: [{role, content}], filters: {q, layer, from, to} }
       Response: text/event-stream SSE
         event: meta  → { smo_count, source_count, token_estimate }  (sent first)
         event: chunk → { text }  (streamed answer fragments)
         event: done  → {}
         event: error → { message }
       Assembles context from filtered SMOs + source summaries (see §21), then calls
       OpenRouter with full conversation history for multi-turn support.

Admin / Debug
  POST /api/admin/ingest/trigger             → manually trigger ingestion
  POST /api/admin/smo/generate?date=         → manually trigger SMO generation

API Key Management
  GET  /api/keys                             → list user's API keys
  POST /api/keys                             → create new key → { id, key } shown once
  DELETE /api/keys/:id                       → revoke a key
```

---

## 7. Agent API Routes

Auth: `Authorization: Bearer <api_key>`. All read-only.  
Base URL: `https://notes-api.lost2038.com/agent`

```
GET /agent/context?q=QUERY&budget=4000&from=YYYY-MM-DD&to=YYYY-MM-DD&layer=1
    → { context: "string", sources: [...], tokens_used: N }
    Token budget estimated at ~4 chars/token. Highest-layer results included first.

GET /agent/hierarchy?from=YYYY-MM-DD&to=YYYY-MM-DD
    → { layer3: [...], layer2: [...], layer1: [...] }
    Each item: { id, layer, headline, date_range_start, date_range_end }

GET /agent/layer/:layer?from=&to=&fields=headline,summary,themes,keywords,key_entities
    → array of SMOs. Default fields: id, layer, headline, date_range_start, date_range_end

GET /agent/smo/:id?depth=0
    → depth=0: SMO + themes
    → depth=1: SMO + themes + child headlines
    → depth=2: SMO + themes + full child SMOs with their themes

GET /agent/smo/:id/sources
    → [{ raw_source_id, source_type, metadata }]

GET /agent/raw-source/:id
    → full raw source including content
```

### CLI wrapper

```bash
notes context --query "project alpha" --budget 4000
notes context --since 1week --budget 8000
notes context --from 2026-04-01 --to 2026-04-07 --layer 2
notes hierarchy --from 2026-04-01 --to 2026-04-16
notes smo <id> --depth 1
notes config set api-key <key>
notes config set api-url https://notes-api.lost2038.com
```

Config stored in `~/.notes/config.json`.

---

## 8. Google OAuth

### Scopes (requested in a single consent screen)
```
openid  email  profile
https://www.googleapis.com/auth/gmail.readonly
https://www.googleapis.com/auth/drive.readonly
```

### Adding a new Google account (e.g. switching personal → work)

OAuth credentials are app-level, not account-level. To sign in with a different Google account:
1. Sign out via the Settings page
2. Sign back in — Google will show the account picker

The only prerequisite is the account must be listed as a **test user** in the Google Cloud Console (since the app is in testing mode):
- Google Cloud Console → APIs & Services → OAuth consent screen → Test users → Add Users

The Google Cloud project and OAuth client ID/secret do not change.

### Rotating OAuth credentials

If you ever need new credentials (e.g. secret rotation):
1. Google Cloud Console → APIs & Services → Credentials → your OAuth client → edit
2. `wrangler secret put GOOGLE_CLIENT_ID` and `wrangler secret put GOOGLE_CLIENT_SECRET` from `worker/`
3. `wrangler deploy` from `worker/`

---

## 9. Ingestion Pipeline

**Trigger:** Cron at 02:45 UTC daily (10:45 PM EDT / 11:45 PM EST).

```
For each user with a valid Google refresh token:

  Gmail ingestion (worker/src/ingestion/gmail.ts)
  ├── Query Gmail for messages with internalDate on today (UTC midnight → 11:30 PM UTC)
  ├── For each message not already in raw_sources:
  │   ├── Fetch full message, prefer text/plain, strip HTML as fallback
  │   └── Insert into raw_sources (source_type='gmail')

  Google Drive ingestion (worker/src/ingestion/gdrive.ts)
  ├── If gdrive_folder_id is configured: recursively traverse that folder only
  ├── If gdrive_folder_id is NOT configured: traverse My Drive root AND "Shared with me" in parallel
  │   ├── My Drive root: standard recursive traversal from 'root'
  │   └── Shared with me: query sharedWithMe=true; files get folderPath='Shared with me';
  │       shared folders are recursed via listFilesRecursive (children don't carry sharedWithMe=true)
  │   Sub-folders are always descended regardless of their own modifiedTime — only
  │   files are filtered by modifiedTime (Drive doesn't reliably update a folder's
  │   modifiedTime when a child file changes)
  ├── Folder path tracked during traversal — each file's metadata includes
  │   folder_path (e.g. "Research" or "Work/Research") relative to the configured root
  ├── For each file modified within the last 24 hours (rolling window, timezone-independent):
  │   ├── Google Docs / Google Slides → Drive export API as text/plain
  │   ├── .txt / .md                  → download raw
  │   └── .docx / .doc / .pdf        → Drive text export (best-effort; raw UTF-8 download as fallback)
  └── Insert into raw_sources (source_type='gdrive')
       externalId = fileId::modifiedTime (re-ingests if file is updated within the window)
       metadata = { filename, mime_type, modified_time, folder_path }

  Workflowy ingestion (worker/src/ingestion/workflowy.ts)
  ├── Skipped if workflowy_api_key not set in user config
  ├── GET /nodes-export → flat list of all nodes (rate-limited: 1 req/min)
  ├── Build parent→children map, find all nodes created in the last 24 hours
  ├── Group recently-created nodes by their root ancestor
  ├── For each root tree with recent activity:
  │   ├── Compute relevantIds = recent nodes + all their ancestors (excludes old siblings)
  │   ├── Serialize as indented outline (only relevant nodes):
  │   │     - Root node text
  │   │       - Ancestor context
  │   │         - Recently created node
  │   │       - Another recently created node
  │   └── Insert into raw_sources (source_type='workflowy')
  │         externalId = rootNodeId::date (one record per root tree per day)
  └── Note: node.note field appended below node.name if present
```

**Deduplication:** `UNIQUE(user_id, source_type, external_id)` — INSERT OR IGNORE.

---

## 10. SMO Generation Pipeline

**Trigger:** Cron at 03:30 UTC daily (11:30 PM EDT / 12:30 AM EST).

### Layer 1 — Daily SMO (every day)
1. **Per-source summarization** — for each `raw_source` not yet summarized (`summarized_at IS NULL`):
   - Call LLM with a focused single-document prompt
   - Extract and save: `summary` (2–4 sentences), `key_decisions`, `key_entities`, `keywords`, `open_questions`
   - Failures are logged and skipped — that source falls back to truncated raw content in the next step
   - Safe to re-run: already-summarized sources are skipped
2. **SMO generation** — collect all `raw_sources` for today (summaries now populated):
   - If none: generate a minimal "No notable activity" SMO (preserves daily continuity)
   - Build Layer 1 prompt from structured mini-summaries (compact, bounded size regardless of source count)
   - Call LLM → parse JSON → insert `smos` + `themes` + `source_pointers`
   - Update `smo_fts`

### Layer 2 — Weekly Rollup (every Friday)
1. Collect Layer 1 SMOs for the past 7 days (Mon–Sun ending on today)
2. Call LLM with rollup prompt → insert Layer 2 SMO pointing to Layer 1 IDs

### Layer 3 — Monthly Rollup (last Friday of month)
1. Detect last-Friday-of-month in scheduler code
2. Collect Layer 2 SMOs for the past ~4 weeks
3. Call LLM with rollup prompt → insert Layer 3 SMO

### JSON parsing
LLM responses are stripped of any markdown code fences before `JSON.parse()`. If required fields are missing the pipeline throws and logs the error without crashing the whole run. Per-source summarization failures are individually caught — that source falls back to truncated raw content (4,000 chars) in the Layer 1 prompt.

---

## 11. Search

### FTS Query Construction
- Single-word query → prefix match (`term*`) — catches stemmed variants
- Multi-word query → exact phrase match (`"exact phrase"`) — avoids false positives
- Uses FTS5 porter stemming tokenizer on `smo_fts` and `raw_sources_fts`

### Two-tier result model

**Tier 1 — Source-level matches (primary)**  
When the keyword is found in `raw_sources_fts` (summary + key_entities + keywords of raw sources), the result surfaces with:
- Clickable source label linking to the original document (Gmail, Drive, Workflowy, Calendar, Slack)
- Keyword-highlighted snippet from the source's indexed text
- Workflowy links resolve to the specific matching bullet node via the `node_index` stored in metadata

**Tier 2 — SMO-only matches (secondary)**  
When the keyword is found only in `smo_fts` (SMO summary, themes, keywords — LLM-generated text) but not in any indexed source, the card shows:
- Keyword-highlighted snippet from the SMO's text
- No source links (sources didn't match — showing all would be noise)

An SMO already found via Tier 1 is excluded from Tier 2 (no duplicate cards).

### Composite rank ordering
Results are sorted by a composite score computed per SMO:
1. **Best individual source rank** — maximum (least-negative) BM25 score across all matching sources for that SMO. Uses `MAX(rsfts.rank)` via `GROUP BY sp.smo_id, rs.id` in SQL.
2. **Match count tiebreaker** — SMOs with more matching sources rank higher when best ranks are equal.

SMO-only results (Tier 2) are merged into the sorted list at their own FTS rank. All groups sorted descending (less-negative = better match = first).

### Source indexing strategy
`raw_sources_fts` indexes LLM-generated fields only (`summary + key_entities + keywords`) — raw content is excluded to maintain search precision. The key prompt engineering rule — capture verbatim named items as keywords — is what makes phrase searches reliable without content indexing.

---

## 12. LLM Prompt Design

**Model:** `OPENROUTER_MODEL` env var (currently `anthropic/claude-sonnet-4-6`). To swap: update the var in `wrangler.toml` and redeploy — no code changes needed.

### Per-source summarization prompt (runs before Layer 1)
Each raw source is summarized individually in a focused LLM call. Calendar events (`gcalendar`) are indexed directly without LLM summarization.
```json
{
  "summary": "2–4 sentences about this document/email",
  "key_decisions": ["concrete decisions made or agreed upon"],
  "key_entities": ["people, orgs, named projects, initiatives, strategies"],
  "keywords": ["5–15 specific keywords including verbatim named items"],
  "open_questions": ["array of unresolved items"] // null if none
}
```
Key prompt rules:
- `keywords` must include **verbatim** multi-word phrases for named items (e.g. "ICP refinement", "Accelerate internal development") — do not paraphrase
- `key_entities` covers proper nouns AND named projects/initiatives/strategies
- `open_questions` is an **array of strings** (one item per unresolved thing; does not need to be phrased as a question) or `null`
- Workflowy sources get extra instruction: treat each bullet as discrete, copy named items exactly
- **Drive file prompt variants** (determined by folder path, any path segment, case-insensitive):
  - **`Meeting Notes`** folder (e.g. `Meeting Notes/2026-04-20.gdoc`): Label `MEETING NOTES` — `key_decisions` and `open_questions` are extracted normally
  - **All other Drive files** (root or any other folder): Label `DRIVE FILE` — `key_decisions` forced to `[]`, `open_questions` forced to `null`

Raw content is truncated to 80,000 chars (~20k tokens) before sending. Results are saved back to `raw_sources` (`summarized_at` timestamp prevents re-processing). On failure, `summary_error` is recorded and the source falls back to truncated raw content (4,000 chars) in the Layer 1 prompt.

### Layer 1 system prompt
> You are a memory assistant. Respond ONLY with a single valid JSON object. No markdown, no explanation, no extra text — just the JSON.

### Layer 1 user prompt (uses mini-summaries, not raw content)
```
Today's date: {YYYY-MM-DD}

SOURCE MATERIAL:
[EMAIL] Subject: ... | From: ...
Summary: ...
Key Decisions: ...
Key Entities: ...
Keywords: ...
Open Questions: ...

---

[DRIVE] File: ...
Summary: ...
...

Generate a structured memory object conforming EXACTLY to this JSON schema:
{
  "headline": "one sentence — most important thing about this day",
  "summary": "one paragraph (3-6 sentences)",
  "themes": [{ "headline": "...", "summary": "EXACTLY 2 sentences" }],  // 1–5 items
  "keywords": ["string"],         // 5–15
  "key_entities": ["string"],     // people, projects, orgs, places
  "key_decisions": ["string"],    // concrete decisions made; empty array if none
  "open_questions": ["string"] | null,  // array of unresolved items; null if none
  "location": "City, Country | null"    // inferred from calendar events
}
```
Fallback: if a source's summarization failed, its raw content is truncated to 4,000 chars and used instead.

**Storage of `open_questions`:** The LLM returns an array; the parser joins items with `\n` for storage in the `TEXT` column. The frontend splits on `\n` to render bullet points.

**Storage of `key_decisions`:** Stored as a JSON array string in the `key_decisions TEXT` column on `smos`.

### Intelligence query prompt
The intelligence layer uses a multi-message conversation structure:
```
[system]    User's custom system prompt (or default) + always-loaded context block
[user]      MEMORY CONTEXT block (assembled SMOs + source summaries — see §21)
[assistant] "I have reviewed your memory context and am ready to answer questions about it."
[user/asst] …prior conversation history turns…
[user]      Current question
```
The model returns a free-form answer (not JSON). Temperature 0.5. The context block is prepended fresh on every turn so the model always has the full filtered memory set regardless of conversation length.

### Layer 2/3 rollup prompt
```
{Weekly|Monthly} rollup covering {start} to {end}

CHILD MEMORY OBJECTS (JSON):
[...serialized child SMOs including key_decisions...]

Generate a single memory object using the same schema as Layer 1, summarizing the entire period.
Synthesize across all child objects — do not just repeat them.
```

---

## 13. Cron Schedule

| Job | UTC | EDT (Mar–Nov) | EST (Nov–Mar) |
|---|---|---|---|
| Daily ingestion | `45 2 * * *` | 10:45 PM | 9:45 PM |
| SMO generation + rollups | `30 3 * * *` | 11:30 PM | 10:30 PM |

Layer check logic is in `worker/src/cron/scheduler.ts` — a single `scheduled()` handler dispatches by UTC hour:minute. Layer 2 fires every Friday; Layer 3 fires on the last Friday of the month (detected with `isLastFridayOfMonth()` in `worker/src/db/utils.ts`).

---

## 14. Session & Security

- **Browser sessions:** HS256 JWT signed with `SESSION_SECRET`, stored in `httpOnly; Secure; SameSite=Lax` cookie. 24-hour expiry. Hand-rolled (no `jose` dependency — Workers crypto API used directly).
- **Agent API keys:** Raw key shown once on creation. Stored as SHA-256 hash in D1 via `crypto.subtle.digest`. Incoming `Bearer` token is hashed and compared — plaintext never persisted.
- **CORS:** Worker allows `https://notes.lost2038.com` for browser requests. Agent routes have no CORS (used by non-browser clients).
- **OAuth tokens:** Access token refreshed automatically before each API call if expiry is within 5 minutes.
- **Agent API is read-only:** No write operations on `/agent/*` routes.

---

## 15. Environment Variables & Secrets

### Worker secrets (set via `wrangler secret put` from `worker/`)

| Secret | Description | Status |
|---|---|---|
| `GOOGLE_CLIENT_ID` | Google OAuth client ID | ✅ set |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret | ✅ set |
| `OPENROUTER_API_KEY` | OpenRouter API key | ✅ set |
| `SESSION_SECRET` | 32-byte hex for JWT signing | ✅ set |

### Worker vars (in `worker/wrangler.toml`, not secret)

| Var | Value |
|---|---|
| `APP_URL` | `https://notes.lost2038.com` |
| `API_URL` | `https://notes-api.lost2038.com` |
| `OPENROUTER_MODEL` | `anthropic/claude-sonnet-4-6` |

### Frontend (baked in at build time)

| Var | Value | Where set |
|---|---|---|
| `VITE_API_URL` | `https://notes-api.lost2038.com` | `.env.production` + GitHub Actions `deploy.yml` |

---

## 16. Frontend Pages

### Login (`/`)
- "Sign in with Google" button → redirects to `/api/auth/google`
- Shows error message if OAuth was denied

### Search (`/search`) — index page after login
- Search bar + Enter key support
- Layer filter chips (All / Layer 1 Day / Layer 2 Week / Layer 3 Month)
- Date range pickers (calendar icon on left side of each field)
- Results ranked by composite FTS score (see §11 Search above)
- **Collapsed card:** headline, date, location, layer badge, match snippets with keyword highlights.
  Source-level FTS matches show clickable source labels (with "details" link to Source Details page)
  and keyword-highlighted snippets. SMO-only matches show a snippet but no source links.
- **Expanded card** (fetches SMO detail + source summaries in parallel on first open):
  1. Key decisions — LLM-aggregated list from all sources (green, bullet list)
  2. Open questions — LLM-aggregated list (amber, bullet list)
  3. Sources — Drive, Workflowy, Slack sources; Gmail only if it has key decisions; each with
     external link + "details" link to Source Details page; calendar excluded
  4. Themes — with 2-sentence summaries
  5. Keywords + key entities — tag pills
  Footer: "View sources & drill-down →" link to SMO Detail page
- **Intelligence panel** (below filters, above results — see §21):
  Multi-turn chat UI. Streams answers word-by-word. Header shows memory count, source count,
  and token estimate for the current context. Stop button cancels mid-stream. Clear resets
  the conversation. Filters (keyword, date range, layer) determine which memories are in scope.

### SMO Detail (`/smo/:id`)
- Full SMO: headline, summary, themes, keywords, key entities, key decisions (green), open questions (amber bullets)
- Child SMOs (Layer 3 → L2, Layer 2 → L1) as clickable cards
- Raw sources: collapsed by default, click to expand full content

### Source Details (`/source/:id`) — opens in new tab
- Fetches all DB fields for a raw source via `GET /api/raw-sources/:id`
- **AI Summary section (top):** key decisions (green), open questions (amber), summary text,
  key entities, keywords — only shown if source has been summarized
- **Metadata section:** source type, source date, ingested at, summarized at, ID, all metadata fields
- **Raw content section:** full source text in scrollable monospace block
- Page title: "Source Details"

### Settings (`/settings`)
- Google connection status + reconnect link
- Google Drive folder ID input + save
- Workflowy API key input (password field) + save — key is stored per-user in the `config` table, never as a global secret; shown as `••••••••` once saved
- **Intelligence** — system prompt textarea + always-loaded context textarea; both stored in
  the `config` table under `intelligence_system_prompt` and `intelligence_context`
- API Keys: list, create (key shown once with copy button), revoke
- "Run ingestion now" debug button

---

## 17. Deployment

### Worker (from `worker/` directory)

```bash
# Deploy
npx wrangler deploy

# Update a secret
npx wrangler secret put SECRET_NAME

# Tail live logs
npx wrangler tail

# Apply a new DB migration
npx wrangler d1 migrations apply notes-db --remote
```

### Frontend (from repo root)

```bash
# Build + deploy manually
npm run build
npx wrangler pages deploy dist --project-name notes

# Or just push to main — GitHub Actions deploys automatically
git push origin main
```

### Running locally

```bash
# Frontend (http://localhost:5173)
npm run dev

# Worker (http://localhost:8787) — from worker/
npm run dev   # npx wrangler dev
```

For local dev, the frontend's `VITE_API_URL` defaults to `https://notes-api.lost2038.com` (from `.env.production`). To point at a local worker instead, create `.env.local`:
```
VITE_API_URL=http://localhost:8787
```

---

## 18. Tests

### Framework

| Tool | Role |
|---|---|
| [Vitest](https://vitest.dev) v4 | Test runner |
| [`@cloudflare/vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/) v0.14 | Runs tests inside a real Workers runtime (not Node) — gives tests access to `crypto.subtle`, `Request`, `Response`, `D1Database`, etc. exactly as they behave in production |

The pool workers package is configured via `worker/vitest.config.ts` and pointed at `worker/wrangler.toml` so it picks up the same D1 binding, compat flags, and secrets format that the worker itself uses.

> **Why Workers runtime for tests?** The auth module uses `crypto.subtle` (Web Crypto API), which behaves differently between Node and Workers. Running tests in the real Workers runtime eliminates an entire class of false passes.

### Running tests

```bash
# From worker/
npm test           # run once
npm run test:watch # watch mode
```

### Test files

#### `worker/src/db/utils.test.ts` — Date helpers (10 tests)

Covers the three pure date functions that drive the cron scheduling logic:

| Function | What's tested |
|---|---|
| `daysAgo(date, n)` | N=0 identity, N=1 subtraction, month/year boundary crossing |
| `isFriday(date)` | Correct day, adjacent days, weekdays |
| `isLastFridayOfMonth(date)` | Last Friday is detected, earlier Fridays return false, non-Friday end-of-month returns false, last Friday on the 31st |

`isLastFridayOfMonth` is particularly important because getting it wrong would generate Layer 3 (monthly) SMOs on the wrong date or skip them entirely.

#### `worker/src/auth/session.test.ts` — HS256 JWT (9 tests)

The session JWT is hand-rolled (no library) so these tests are the primary safeguard against regressions:

| Scenario | What's verified |
|---|---|
| Round-trip | `createSession` → `verifySession` returns correct `sub` and `email` |
| Timing | `iat` and `exp` are set; `exp - iat` is exactly 24 hours |
| Tampered payload | Attacker replaces body with different user ID — signature check fails, returns `null` |
| Wrong secret | Token signed with secret-A rejected by verifier using secret-B |
| Expired token | Token with `exp` in the past is rejected even though signature is valid |
| Malformed strings | Empty string, wrong segment count, garbage input all return `null` without throwing |
| Cookie parsing | `getSessionToken` extracts token from single-cookie and multi-cookie headers; returns `null` when cookie is absent |

#### `worker/src/llm/smo.test.ts` — LLM response parsers (17 tests)

The two JSON parsers (`parseLLMResponse`, `parseSourceSummaryResponse`) are the most likely real-world failure point — models occasionally wrap responses in markdown fences or omit optional fields:

| Scenario | What's verified |
|---|---|
| Well-formed JSON | All fields parsed correctly |
| Markdown code fences | ` ```json ... ``` ` stripped before parse (both lowercase and uppercase `JSON`) |
| Missing optional arrays | `themes`, `keywords`, `key_entities` auto-filled to `[]` when absent |
| Theme cap | More than 5 themes silently truncated to 5 |
| Missing required fields | `headline`/`summary` (SMO) or `summary` (source) absence throws with a descriptive message |
| Invalid JSON | Throws on unparseable input |
| Null `open_questions` | Explicitly accepted as valid |
| Empty `summary` string | Treated as falsy, throws (same as missing) |

### What is not tested

- **Integration tests** (SMO pipeline end-to-end with real D1 + mocked LLM) — planned but not yet written
- **Ingestion** (`gmail.ts`, `gdrive.ts`) — depend on live Google API responses; best covered with recorded fixtures in a future pass
- **Worker routing** (`index.ts`) — route dispatch is thin glue; covered by end-to-end testing

---

## 19. First-Run Checklist

After deployment, complete these steps once:

- [ ] Sign in at **notes.lost2038.com** with your Google account — this creates your user row and stores OAuth tokens
- [ ] Optionally: go to **Settings** → paste a Google Drive folder ID to restrict ingestion to that folder (copy from the Drive URL: `drive.google.com/drive/folders/{FOLDER_ID}`); without this, both My Drive and "Shared with me" are scanned
- [ ] Go to **Settings** → paste your Workflowy API key (from workflowy.com → Settings → API) to enable Workflowy ingestion
- [ ] Optionally: click **Run ingestion now** to ingest today's content immediately rather than waiting for the 02:45 UTC cron
- [ ] Create an API key in Settings → copy and store it somewhere safe → configure the CLI: `notes config set api-key <key>`

---

## 21. Intelligence Layer

A multi-turn question-answering system embedded in the Search page. The user asks questions; the system grounds its answers in the memories currently visible on the page (same keyword/date/layer filters active).

### Flow

1. **Filter sync** — the intelligence panel always uses the current filter state (`q`, `layer`, `from`, `to`) from the Search page. Changing a filter implicitly changes what memories the next question will draw from.
2. **Context assembly** (`worker/src/intelligence/context.ts`):
   - Re-runs the same DB query as the search page to get matching SMOs
   - Fetches themes for all matching SMOs in one batched query
   - Fetches source summaries (LLM-generated fields only, no raw content) for all matching SMOs via `source_pointers → raw_sources`
   - Builds a structured context block (see below) up to a **400K char / ~100K token budget**
3. **LLM call** — streams from OpenRouter with `stream: true`; full conversation history is included on every turn for multi-turn coherence
4. **SSE response** — Worker writes `event: meta` (context stats) first, then `event: chunk` fragments, then `event: done`

### Context block format

```
MEMORY CONTEXT: N memories, M sources

=== MONTHLY MEMORY: 2026-01-01 – 2026-03-31 ===
Headline: …
Summary: …
Themes: Theme A | Theme B | Theme C
Key Decisions: • decision 1 • decision 2
Open Questions: • question 1
Keywords: …

=== WEEKLY MEMORY: 2026-04-14 – 2026-04-20 ===
…

=== DAILY MEMORY: 2026-04-19 ===
…
  [Gmail: Re: Budget approval] Summary text | Decisions: … | Keywords: …
  [Drive: Q1 Review.docx] Summary text | …
  [Workflowy: Product roadmap] Summary text | …
```

**Ordering:** Layer 3 → Layer 2 → Layer 1, newest-first within each layer. Source summaries are only included for Layer 1 SMOs (higher layers already synthesize them). Budget truncates from the bottom — least-recently-dated Layer 1 SMOs drop first.

### Context token budget

| Layer | Per-SMO (no sources) | Per SMO + 8 sources | Approximate capacity at 400K chars |
|---|---|---|---|
| L3 | ~1,700 chars | — | ~235 monthly SMOs |
| L2 | ~1,700 chars | — | ~235 weekly SMOs |
| L1 | ~1,700 chars | ~6,900 chars (with sources) | ~58 daily SMOs with sources |

In practice, a mixed result set (some L3/L2/L1) easily fits 4–6 months of daily data within the budget. The context header shown in the UI (`X memories · Y sources · ~Z tokens in context`) reflects what actually fit.

### Conversation history

All prior turns are sent with every request — the model has full context for follow-up questions. History is held in React state only (not persisted); clearing the panel resets it. The context block is re-assembled from the DB on every request so filter changes take effect immediately.

### User configuration (stored in `config` table)

| Key | Purpose | Default |
|---|---|---|
| `intelligence_system_prompt` | System prompt sent to the LLM | Built-in default |
| `intelligence_context` | Always-loaded background text prepended after the system prompt | None |

### Key files

| File | Role |
|---|---|
| `worker/src/intelligence/context.ts` | DB queries + context block assembly |
| `worker/src/intelligence/query.ts` | SSE streaming route handler |
| `worker/src/llm/openrouter.ts` | `streamChatCompletion()` async generator |
| `worker/src/llm/prompts.ts` | `buildIntelligenceSystemPrompt()`, `buildIntelligenceContextBlock()` |
| `worker/src/db/queries.ts` | `getSmosForIntelligence()`, `getThemesForSmos()`, `getSourceSummariesForSmos()` |
| `src/pages/Search.tsx` | `IntelligencePanel` React component |
| `src/lib/api.ts` | `api.intelligence.query()` SSE streaming client |

---

## 20. Future Enhancements (not in MVP)

- Daily brief email (morning summary)
- Google Calendar ingestion
- Semantic / vector search (Cloudflare Vectorize)
- Multi-user support (user_id FK already in schema)
- Manual note entry UI
- Mobile-optimized view
- Agent API write access (append notes, tag memories)
- MCP server wrapper — expose agent API as an MCP tool so Claude Code and other MCP clients can call it natively without a separate CLI
- Intelligence layer: persist conversation history across sessions
- Intelligence layer: let the user pin specific SMOs into context regardless of current filters
