# Notes App — Architecture & Implementation Reference

**Last updated:** 2026-04-16 (tests added)  
**Status:** Built and deployed ✅

---

## 1. Product Overview

A personal notes intelligence app that ingests daily content from Gmail and Google Drive, uses an LLM to distill it into a structured memory hierarchy, and exposes both a search interface for human use and a read-only agent API for external AI agents and CLI tools to efficiently load context without wasting tokens.

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
| Worker name | `notes-api` |
| Pages project name | `notes` |
| Google OAuth Client ID | `833938843826-7gtm93vcocguqumj89q13oc53firfpsa.apps.googleusercontent.com` |
| Google Cloud OAuth redirect URI | `https://notes-api.lost2038.com/api/auth/callback` |
| OpenRouter default model | `moonshotai/kimi-k2` |

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
                                └─────────────┘  │  - Drive        │  │  (configurable)     │
                                                 └─────────────────┘  └─────────────────────┘
```

---

## 4. Repository Structure

```
notes/                              ← repo root (Cloudflare Pages deploys from here)
├── src/                            ← React frontend (TypeScript)
│   ├── pages/
│   │   ├── Login.tsx               ← "Sign in with Google" page
│   │   ├── Search.tsx              ← index page post-auth, FTS search UI
│   │   ├── SMODetail.tsx           ← drill-down view with theme/source expansion
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
│   │   │   ├── gdrive.ts           ← Drive API: list files, export Docs, download others
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
│       └── deploy.yml              ← pushes to main auto-deploy frontend to Pages
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
-- Keys used: gdrive_folder_id

-- Raw source material (source of truth)
CREATE TABLE raw_sources (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  source_type    TEXT NOT NULL,             -- 'gmail' | 'gdrive'
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
  open_questions    TEXT,
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

-- Full-text search (FTS5)
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
```

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

Raw Sources
  GET  /api/raw-sources/:id                  → full raw source content

Settings
  GET  /api/settings                         → { gdrive_folder_id, connections: { google } }
  PUT  /api/settings                         → update config values

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
  ├── Recursively traverse configured folder and all sub-folders (requires gdrive_folder_id in config)
  │   Sub-folders are always descended regardless of their own modifiedTime — only
  │   files are filtered by modifiedTime (Drive doesn't reliably update a folder's
  │   modifiedTime when a child file changes)
  ├── For each file modified within the last 24 hours (rolling window, timezone-independent):
  │   ├── Google Docs / Google Slides → Drive export API as text/plain
  │   ├── .txt / .md                  → download raw
  │   └── .docx / .doc / .pdf        → Drive text export (best-effort; raw UTF-8 download as fallback)
  └── Insert into raw_sources (source_type='gdrive')
       externalId = fileId::modifiedTime (re-ingests if file is updated within the window)
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

## 11. LLM Prompt Design

**Model:** `OPENROUTER_MODEL` env var (currently `anthropic/claude-sonnet-4-6`). To swap: update the var in `wrangler.toml` and redeploy — no code changes needed.

### Per-source summarization prompt (new — runs before Layer 1)
Each raw source is summarized individually in a focused LLM call:
```
{summary: "2–4 sentences about this document/email",
 key_decisions: ["concrete decisions made"],
 key_entities: ["proper nouns — people, orgs, projects"],
 keywords: ["3–8 specific topic keywords"],
 open_questions: "unresolved items or null"}
```
Raw content is truncated to 80,000 chars (~20k tokens) before sending. Results are saved back to `raw_sources` (`summarized_at` timestamp prevents re-processing).

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
  "keywords": ["string"],       // 5–15
  "key_entities": ["string"],   // people, projects, orgs, places
  "open_questions": "string | null"
}
```
Fallback: if a source's summarization failed, its raw content is truncated to 4,000 chars and used instead.

### Layer 2/3 rollup prompt
```
{Weekly|Monthly} rollup covering {start} to {end}

CHILD MEMORY OBJECTS (JSON):
[...serialized child SMOs with themes...]

Generate a single memory object summarizing the entire period. Synthesize — do not just repeat.
```

---

## 12. Cron Schedule

| Job | UTC | EDT (Mar–Nov) | EST (Nov–Mar) |
|---|---|---|---|
| Daily ingestion | `45 2 * * *` | 10:45 PM | 9:45 PM |
| SMO generation + rollups | `30 3 * * *` | 11:30 PM | 10:30 PM |

Layer check logic is in `worker/src/cron/scheduler.ts` — a single `scheduled()` handler dispatches by UTC hour:minute. Layer 2 fires every Friday; Layer 3 fires on the last Friday of the month (detected with `isLastFridayOfMonth()` in `worker/src/db/utils.ts`).

---

## 13. Session & Security

- **Browser sessions:** HS256 JWT signed with `SESSION_SECRET`, stored in `httpOnly; Secure; SameSite=Lax` cookie. 24-hour expiry. Hand-rolled (no `jose` dependency — Workers crypto API used directly).
- **Agent API keys:** Raw key shown once on creation. Stored as SHA-256 hash in D1 via `crypto.subtle.digest`. Incoming `Bearer` token is hashed and compared — plaintext never persisted.
- **CORS:** Worker allows `https://notes.lost2038.com` for browser requests. Agent routes have no CORS (used by non-browser clients).
- **OAuth tokens:** Access token refreshed automatically before each API call if expiry is within 5 minutes.
- **Agent API is read-only:** No write operations on `/agent/*` routes.

---

## 14. Environment Variables & Secrets

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

## 15. Frontend Pages

### Login (`/`)
- "Sign in with Google" button → redirects to `/api/auth/google`
- Shows error message if OAuth was denied

### Search (`/search`) — index page after login
- Search bar + Enter key support
- Layer filter chips (All / Layer 1 Day / Layer 2 Week / Layer 3 Month)
- Date range pickers
- Results: headline, date range, layer badge, FTS snippet with `<b>` highlights

### SMO Detail (`/smo/:id`)
- Full SMO: headline, summary, themes, keywords, key entities, open questions
- Child SMOs (Layer 3 → L2, Layer 2 → L1) as clickable cards
- Raw sources: collapsed by default, click to expand full content

### Settings (`/settings`)
- Google connection status + reconnect link
- Google Drive folder ID input + save
- API Keys: list, create (key shown once with copy button), revoke
- "Run ingestion now" debug button

---

## 16. Deployment

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

## 17. Tests

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

## 18. First-Run Checklist

After deployment, complete these steps once:

- [ ] Sign in at **notes.lost2038.com** with your Google account — this creates your user row and stores OAuth tokens
- [ ] Go to **Settings** → paste your Google Drive folder ID (copy it from the Drive URL: `drive.google.com/drive/folders/{FOLDER_ID}`)
- [ ] Optionally: click **Run ingestion now** to ingest today's content immediately rather than waiting for the 02:45 UTC cron
- [ ] Create an API key in Settings → copy and store it somewhere safe → configure the CLI: `notes config set api-key <key>`

---

## 19. Future Enhancements (not in MVP)

- Daily brief email (morning summary)
- Google Calendar ingestion
- Slack ingestion
- Semantic / vector search (Cloudflare Vectorize)
- Multi-user support (user_id FK already in schema)
- Manual note entry UI
- Mobile-optimized view
- Agent API write access (append notes, tag memories)
- MCP server wrapper — expose agent API as an MCP tool so Claude Code and other MCP clients can call it natively without a separate CLI
