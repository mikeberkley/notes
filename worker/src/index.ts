import type { Env } from './types.js';
import { handleScheduled } from './cron/scheduler.js';
import { getAuthRedirectUrl, handleCallback } from './auth/google.js';
import { requireSession, clearSessionCookie } from './auth/session.js';
import { handleAgentRequest } from './agent/router.js';
import {
  getUserById,
  getConfig,
  setConfig,
  getOAuthToken,
  searchSmos,
  getSmoById,
  getThemesBySmoId,
  getChildSmos,
  getSourcePointers,
  getSmoSourceSummaries,
  getRawSourceById,
  getSmosByLayerAndDate,
  createApiKey,
  listApiKeys,
  deleteApiKey,
} from './db/queries.js';
import { generateRawApiKey, hashKey } from './db/utils.js';
import { runIngestionPipeline } from './ingestion/pipeline.js';
import { runSmoGenerationPipeline } from './llm/smo.js';
import { handleIntelligenceQuery } from './intelligence/query.js';
import { json, notFound, unauthorized, cors } from './utils/responses.js';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') return cors();

    // ── Auth routes (no session required) ─────────────────────────────────
    if (path === '/api/auth/google') {
      return Response.redirect(getAuthRedirectUrl(env), 302);
    }

    if (path === '/api/auth/callback') {
      return handleCallback(request, env);
    }

    if (path === '/api/auth/logout' && request.method === 'POST') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Set-Cookie': clearSessionCookie(), 'Content-Type': 'application/json' },
      });
    }

    // ── Agent API routes (API key auth) ───────────────────────────────────
    if (path.startsWith('/agent/')) {
      return handleAgentRequest(request, env, path.slice(6));
    }

    // ── Session-protected routes ──────────────────────────────────────────
    const session = await requireSession(request, env);
    if (!session) return unauthorized();

    const userId = session.sub;

    // GET /api/auth/me
    if (path === '/api/auth/me') {
      const user = await getUserById(env.DB, userId);
      return json(user ? { id: user.id, email: user.email } : null);
    }

    // GET /api/search
    if (path === '/api/search') {
      const q = url.searchParams.get('q') ?? '';
      const layer = url.searchParams.has('layer') ? parseInt(url.searchParams.get('layer')!, 10) : undefined;
      const from = url.searchParams.get('from') ?? undefined;
      const to = url.searchParams.get('to') ?? undefined;
      const results = await searchSmos(env.DB, userId, q, layer, from, to);
      return json(results);
    }

    // GET /api/smos
    if (path === '/api/smos' && request.method === 'GET') {
      const layer = parseInt(url.searchParams.get('layer') ?? '1', 10);
      const date = url.searchParams.get('date') ?? new Date().toISOString().slice(0, 10);
      const smos = await getSmosByLayerAndDate(env.DB, userId, layer, date);
      return json(smos);
    }

    // GET /api/smos/:id
    const smoMatch = path.match(/^\/api\/smos\/([^/]+)$/);
    if (smoMatch && request.method === 'GET') {
      const smo = await getSmoById(env.DB, smoMatch[1], userId);
      if (!smo) return notFound();
      const themes = await getThemesBySmoId(env.DB, smo.id);
      return json({
        ...smo,
        keywords: JSON.parse(smo.keywords),
        key_entities: JSON.parse(smo.key_entities),
        key_decisions: smo.key_decisions ? JSON.parse(smo.key_decisions) : [],
        themes,
      });
    }

    // GET /api/smos/:id/children
    const childrenMatch = path.match(/^\/api\/smos\/([^/]+)\/children$/);
    if (childrenMatch && request.method === 'GET') {
      const smo = await getSmoById(env.DB, childrenMatch[1], userId);
      if (!smo) return notFound();
      const children = await getChildSmos(env.DB, smo.id, userId);
      return json(children);
    }

    // GET /api/smos/:id/sources
    const smoSourcesMatch = path.match(/^\/api\/smos\/([^/]+)\/sources$/);
    if (smoSourcesMatch && request.method === 'GET') {
      const smo = await getSmoById(env.DB, smoSourcesMatch[1], userId);
      if (!smo) return notFound();
      const pointers = await getSourcePointers(env.DB, smo.id);
      return json(pointers);
    }

    // GET /api/smos/:id/source-summaries
    const smoSrcSummariesMatch = path.match(/^\/api\/smos\/([^/]+)\/source-summaries$/);
    if (smoSrcSummariesMatch && request.method === 'GET') {
      const smo = await getSmoById(env.DB, smoSrcSummariesMatch[1], userId);
      if (!smo) return notFound();
      const raw = await getSmoSourceSummaries(env.DB, smo.id, userId);

      const processed = raw.map(rs => {
        const meta = JSON.parse(rs.metadata) as Record<string, unknown>;
        let label: string;
        let source_url: string | null = null;

        switch (rs.source_type) {
          case 'gmail':
            label = `Gmail: ${String(meta.subject ?? '(no subject)')}`;
            source_url = `https://mail.google.com/mail/u/0/#inbox/${rs.external_id}`;
            break;
          case 'gdrive': {
            const fileId = rs.external_id.includes('::') ? rs.external_id.split('::')[0] : rs.external_id;
            label = `Drive: ${String(meta.filename ?? 'Untitled')}`;
            source_url = `https://drive.google.com/file/d/${fileId}/view`;
            break;
          }
          case 'workflowy':
            label = `Workflowy: ${String(meta.root_name ?? 'Note')}`;
            source_url = `https://workflowy.com/#${String(meta.root_node_id ?? '')}`;
            break;
          case 'slack':
            if (meta.type === 'dm') {
              label = `Slack DM: ${String(meta.with_user ?? 'Unknown')}`;
            } else {
              label = `Slack: #${String(meta.channel_name ?? 'channel')}`;
              if (rs.external_id.includes('::')) {
                const channelId = rs.external_id.split('::')[1]?.split('::')[0] ?? '';
                source_url = `https://app.slack.com/archives/${channelId}`;
              }
            }
            break;
          default:
            label = rs.source_type;
        }

        return {
          id: rs.id,
          source_type: rs.source_type,
          label,
          source_url,
          has_key_decisions: !!(rs.key_decisions && (JSON.parse(rs.key_decisions) as unknown[]).length > 0),
        };
      }).filter(rs => {
        // Emails only shown if they have key decisions
        if (rs.source_type === 'gmail') return rs.has_key_decisions;
        return true;
      });

      return json(processed);
    }

    // GET /api/raw-sources/:id
    const rawSourceMatch = path.match(/^\/api\/raw-sources\/([^/]+)$/);
    if (rawSourceMatch && request.method === 'GET') {
      const rs = await getRawSourceById(env.DB, rawSourceMatch[1], userId);
      if (!rs) return notFound();
      return json({
        ...rs,
        metadata: JSON.parse(rs.metadata),
        key_decisions: rs.key_decisions ? JSON.parse(rs.key_decisions) : null,
        key_entities: rs.key_entities ? JSON.parse(rs.key_entities) : null,
        keywords: rs.keywords ? JSON.parse(rs.keywords) : null,
      });
    }

    // GET /api/settings
    if (path === '/api/settings' && request.method === 'GET') {
      const [gdriveFolder, workflowyKey, slackToken, intelligenceSystemPrompt, intelligenceContext, oauthToken] = await Promise.all([
        getConfig(env.DB, userId, 'gdrive_folder_id'),
        getConfig(env.DB, userId, 'workflowy_api_key'),
        getConfig(env.DB, userId, 'slack_token'),
        getConfig(env.DB, userId, 'intelligence_system_prompt'),
        getConfig(env.DB, userId, 'intelligence_context'),
        getOAuthToken(env.DB, userId),
      ]);
      return json({
        gdrive_folder_id: gdriveFolder,
        workflowy_api_key: workflowyKey ? '••••••••' : null,
        slack_token: slackToken ? '••••••••' : null,
        intelligence_system_prompt: intelligenceSystemPrompt,
        intelligence_context: intelligenceContext,
        connections: { google: !!oauthToken },
      });
    }

    // PUT /api/settings
    if (path === '/api/settings' && request.method === 'PUT') {
      const body = await request.json<{ gdrive_folder_id?: string; workflowy_api_key?: string; slack_token?: string; intelligence_system_prompt?: string; intelligence_context?: string }>();
      if (body.gdrive_folder_id !== undefined) {
        await setConfig(env.DB, userId, 'gdrive_folder_id', body.gdrive_folder_id);
      }
      if (body.workflowy_api_key !== undefined) {
        await setConfig(env.DB, userId, 'workflowy_api_key', body.workflowy_api_key);
      }
      if (body.slack_token !== undefined) {
        await setConfig(env.DB, userId, 'slack_token', body.slack_token);
      }
      if (body.intelligence_system_prompt !== undefined) {
        await setConfig(env.DB, userId, 'intelligence_system_prompt', body.intelligence_system_prompt);
      }
      if (body.intelligence_context !== undefined) {
        await setConfig(env.DB, userId, 'intelligence_context', body.intelligence_context);
      }
      return json({ ok: true });
    }

    // POST /api/intelligence/query
    if (path === '/api/intelligence/query' && request.method === 'POST') {
      return handleIntelligenceQuery(request, env, userId, ctx);
    }

    // POST /api/admin/ingest/trigger
    if (path === '/api/admin/ingest/trigger' && request.method === 'POST') {
      const body = await request.json<{ date?: string }>().catch(() => ({ date: undefined }));
      ctx.waitUntil(runIngestionPipeline(env, body?.date).catch(console.error));
      return json({ ok: true, message: 'Ingestion triggered' });
    }

    // POST /api/admin/smo/generate
    if (path === '/api/admin/smo/generate' && request.method === 'POST') {
      const date = url.searchParams.get('date') ?? undefined;
      ctx.waitUntil(runSmoGenerationPipeline(env, date).catch(console.error));
      return json({ ok: true, message: 'SMO generation triggered' });
    }

    // GET /api/keys
    if (path === '/api/keys' && request.method === 'GET') {
      const keys = await listApiKeys(env.DB, userId);
      return json(keys);
    }

    // POST /api/keys
    if (path === '/api/keys' && request.method === 'POST') {
      const body = await request.json<{ label: string }>();
      if (!body.label) return json({ error: 'label required' }, 400);
      const rawKey = generateRawApiKey();
      const keyHash = await hashKey(rawKey);
      const id = await createApiKey(env.DB, userId, body.label, keyHash);
      return json({ id, key: rawKey });
    }

    // DELETE /api/keys/:id
    const keyMatch = path.match(/^\/api\/keys\/([^/]+)$/);
    if (keyMatch && request.method === 'DELETE') {
      await deleteApiKey(env.DB, keyMatch[1], userId);
      return json({ ok: true });
    }

    return notFound();
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(handleScheduled(event, env));
  },
};
