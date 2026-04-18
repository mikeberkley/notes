# Notes App — Claude Code Project Brief

## What this is
A personal notes intelligence app at **notes.lost2038.com**. It ingests daily content from Gmail and Google Drive, uses an LLM (via OpenRouter) to distill it into a structured memory hierarchy stored in Cloudflare D1, and exposes both a human search UI and a **read-only agent API** so external AI agents and CLI tools can efficiently load context without wasting tokens.

## Status
**Live and working** at notes.lost2038.com. Build completed April 2026.

## Architecture reference
Read **`ARCHITECTURE.md`** for full system documentation:
- System diagram
- Full D1 schema (7 tables including `api_keys` with `user_id` throughout)
- All Worker API routes (`/api/*` for browser, `/agent/*` for agents/CLI)
- Ingestion pipeline (Gmail + Google Drive)
- SMO generation + LOA rollup logic and LLM prompts
- Cron schedule (UTC times)
- Frontend pages
- Build order (15 steps)

## Key decisions already made
- **Single user** (owner only) but `user_id` FK on every table for future multi-user expansion
- **Cloudflare Worker** (separate from Pages) handles all backend API + cron triggers
- **Cloudflare D1** (SQLite) for storage, FTS5 for search
- **Google OAuth 2.0** — Sign in with Google doubles as app login AND data access grant (Gmail + Drive scopes in one consent screen)
- **OpenRouter** for LLM calls; model set via `OPENROUTER_MODEL` env var, default `moonshotai/kimi-k2` — **easily swappable, no code changes needed**
- **LLM prompts must enforce strict JSON output** — response format is critical; if Kimi K2 underperforms, switch model via env var
- **Ingestion at 02:45 UTC** (10:45 PM EDT), **SMO generation at 03:30 UTC** (11:30 PM EDT)
- **Layer 1** = daily SMO, **Layer 2** = weekly (every Friday), **Layer 3** = monthly (last Friday of month) — layer check happens in code, not separate cron jobs
- **Empty days still get a Layer 1 SMO** — no gaps in the daily record
- **Agent API is read-only** — `Authorization: Bearer <api_key>`, keys stored hashed in D1
- **CLI wrapper** (`notes` command) is a thin script in `worker/cli/notes.js`

## Repo layout
- `/src/` — React + Vite + Tailwind frontend (Cloudflare Pages)
  - `pages/` — Login, Search, Settings, SMODetail
  - `lib/api.ts` — API client
- `/worker/` — Cloudflare Worker (backend API + cron)
  - `src/auth/` — Google OAuth, session management
  - `src/ingestion/` — Gmail, Google Drive, Workflowy pipelines
  - `src/llm/` — OpenRouter client, SMO generation, prompts
  - `src/agent/` — Agent API routes, API key auth, context assembly
  - `src/cron/` — Scheduled task runner
  - `src/db/` — D1 queries and utilities
  - `cli/notes.js` — CLI wrapper script
- `ARCHITECTURE.md` — full system spec
