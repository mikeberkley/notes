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
  getRawSourceById,
  getSmosByLayerAndDate,
  createApiKey,
  listApiKeys,
  deleteApiKey,
} from './db/queries.js';
import { generateRawApiKey, hashKey } from './db/utils.js';
import { runIngestionPipeline } from './ingestion/pipeline.js';
import { runSmoGenerationPipeline } from './llm/smo.js';
import { json, notFound, unauthorized, cors } from './utils/responses.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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

    // GET /api/raw-sources/:id
    const rawSourceMatch = path.match(/^\/api\/raw-sources\/([^/]+)$/);
    if (rawSourceMatch && request.method === 'GET') {
      const rs = await getRawSourceById(env.DB, rawSourceMatch[1], userId);
      if (!rs) return notFound();
      return json({ ...rs, metadata: JSON.parse(rs.metadata) });
    }

    // GET /api/settings
    if (path === '/api/settings' && request.method === 'GET') {
      const [gdriveFolder, workflowyKey, oauthToken] = await Promise.all([
        getConfig(env.DB, userId, 'gdrive_folder_id'),
        getConfig(env.DB, userId, 'workflowy_api_key'),
        getOAuthToken(env.DB, userId),
      ]);
      return json({
        gdrive_folder_id: gdriveFolder,
        workflowy_api_key: workflowyKey ? '••••••••' : null,
        connections: { google: !!oauthToken },
      });
    }

    // PUT /api/settings
    if (path === '/api/settings' && request.method === 'PUT') {
      const body = await request.json<{ gdrive_folder_id?: string; workflowy_api_key?: string }>();
      if (body.gdrive_folder_id !== undefined) {
        await setConfig(env.DB, userId, 'gdrive_folder_id', body.gdrive_folder_id);
      }
      if (body.workflowy_api_key !== undefined) {
        await setConfig(env.DB, userId, 'workflowy_api_key', body.workflowy_api_key);
      }
      return json({ ok: true });
    }

    // POST /api/admin/ingest/trigger
    if (path === '/api/admin/ingest/trigger' && request.method === 'POST') {
      const body = await request.json<{ date?: string }>().catch(() => ({ date: undefined }));
      // Fire-and-forget (no waitUntil in browser context — admin triggers are best-effort)
      runIngestionPipeline(env, body?.date).catch(console.error);
      return json({ ok: true, message: 'Ingestion triggered' });
    }

    // POST /api/admin/smo/generate
    if (path === '/api/admin/smo/generate' && request.method === 'POST') {
      const date = url.searchParams.get('date') ?? undefined;
      runSmoGenerationPipeline(env, date).catch(console.error);
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
