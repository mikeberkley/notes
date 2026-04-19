import type { Env } from '../types.js';
import { requireApiKey } from './apikeys.js';
import { assembleContext } from './context.js';
import {
  getSmoById,
  getThemesBySmoId,
  getChildSmos,
  getSourcePointers,
  getRawSourceById,
  searchSmos,
} from '../db/queries.js';
import { json, notFound, unauthorized } from '../utils/responses.js';

export async function handleAgentRequest(request: Request, env: Env, path: string): Promise<Response> {
  const userId = await requireApiKey(request, env);
  if (!userId) return unauthorized('Invalid or missing API key');

  const url = new URL(request.url);

  // GET /agent/context
  if (path === '/context') {
    const q = url.searchParams.get('q') ?? '';
    const budget = parseInt(url.searchParams.get('budget') ?? '4000', 10);
    const from = url.searchParams.get('from') ?? undefined;
    const to = url.searchParams.get('to') ?? undefined;
    const layer = url.searchParams.has('layer') ? parseInt(url.searchParams.get('layer')!, 10) : undefined;

    const result = await assembleContext(env.DB, userId, q, budget, from, to, layer);
    return json(result);
  }

  // GET /agent/hierarchy
  if (path === '/hierarchy') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!from || !to) return json({ error: 'from and to required' }, 400);

    const { results: layer3 } = await env.DB.prepare(
      "SELECT id, layer, headline, date_range_start, date_range_end FROM smos WHERE user_id = ? AND layer = 3 AND date_range_start >= ? AND date_range_end <= ? ORDER BY date_range_start"
    ).bind(userId, from, to).all<{ id: string; layer: number; headline: string; date_range_start: string; date_range_end: string }>();

    const { results: layer2 } = await env.DB.prepare(
      "SELECT id, layer, headline, date_range_start, date_range_end FROM smos WHERE user_id = ? AND layer = 2 AND date_range_start >= ? AND date_range_end <= ? ORDER BY date_range_start"
    ).bind(userId, from, to).all<{ id: string; layer: number; headline: string; date_range_start: string; date_range_end: string }>();

    const { results: layer1 } = await env.DB.prepare(
      "SELECT id, layer, headline, date_range_start, date_range_end FROM smos WHERE user_id = ? AND layer = 1 AND date_range_start >= ? AND date_range_end <= ? ORDER BY date_range_start"
    ).bind(userId, from, to).all<{ id: string; layer: number; headline: string; date_range_start: string; date_range_end: string }>();

    return json({ layer3, layer2, layer1 });
  }

  // GET /agent/layer/:layer
  const layerMatch = path.match(/^\/layer\/(\d)$/);
  if (layerMatch) {
    const layer = parseInt(layerMatch[1], 10);
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    const fields = url.searchParams.get('fields')?.split(',') ?? [];

    let sql = 'SELECT id, layer, headline, date_range_start, date_range_end';
    if (fields.includes('summary')) sql += ', summary';
    if (fields.includes('keywords')) sql += ', keywords';
    if (fields.includes('key_entities')) sql += ', key_entities';
    if (fields.includes('open_questions')) sql += ', open_questions';
    sql += ' FROM smos WHERE user_id = ? AND layer = ?';

    const params: (string | number)[] = [userId, layer];
    if (from) { sql += ' AND date_range_start >= ?'; params.push(from); }
    if (to) { sql += ' AND date_range_end <= ?'; params.push(to); }
    sql += ' ORDER BY date_range_start';

    const { results } = await env.DB.prepare(sql).bind(...params).all();

    let finalResults = results;
    if (fields.includes('themes')) {
      finalResults = await Promise.all(
        results.map(async (smo: Record<string, unknown>) => {
          const themes = await getThemesBySmoId(env.DB, smo.id as string);
          return { ...smo, themes: themes.map(t => ({ headline: t.headline, summary: t.summary })) };
        })
      ) as Record<string, unknown>[];
    }

    return json(finalResults);
  }

  // GET /agent/smo/:id
  const smoMatch = path.match(/^\/smo\/([^/]+)$/);
  if (smoMatch) {
    const smoId = smoMatch[1];
    const depth = parseInt(url.searchParams.get('depth') ?? '0', 10);
    const smo = await getSmoById(env.DB, smoId, userId);
    if (!smo) return notFound();

    const themes = await getThemesBySmoId(env.DB, smoId);
    const result: Record<string, unknown> = {
      ...smo,
      keywords: JSON.parse(smo.keywords),
      key_entities: JSON.parse(smo.key_entities),
      key_decisions: smo.key_decisions ? JSON.parse(smo.key_decisions) : [],
      themes: themes.map(t => ({ headline: t.headline, summary: t.summary })),
    };

    if (depth >= 1) {
      const children = await getChildSmos(env.DB, smoId, userId);
      if (depth === 1) {
        result.children = children.map(c => ({
          id: c.id, layer: c.layer, headline: c.headline,
          date_range_start: c.date_range_start, date_range_end: c.date_range_end,
        }));
      } else {
        result.children = await Promise.all(
          children.map(async c => {
            const ct = await getThemesBySmoId(env.DB, c.id);
            return {
              ...c,
              keywords: JSON.parse(c.keywords),
              key_entities: JSON.parse(c.key_entities),
              themes: ct.map(t => ({ headline: t.headline, summary: t.summary })),
            };
          })
        );
      }
    }

    return json(result);
  }

  // GET /agent/smo/:id/sources
  const sourcesMatch = path.match(/^\/smo\/([^/]+)\/sources$/);
  if (sourcesMatch) {
    const smoId = sourcesMatch[1];
    const smo = await getSmoById(env.DB, smoId, userId);
    if (!smo) return notFound();

    const pointers = await getSourcePointers(env.DB, smoId);
    const rawPointers = pointers.filter(p => p.target_type === 'raw_source');
    const sources = await Promise.all(
      rawPointers.map(async p => {
        const rs = await getRawSourceById(env.DB, p.target_id, userId);
        if (!rs) return null;
        return { raw_source_id: rs.id, source_type: rs.source_type, metadata: JSON.parse(rs.metadata) };
      })
    );
    return json(sources.filter(Boolean));
  }

  // GET /agent/raw-source/:id
  const rawSourceMatch = path.match(/^\/raw-source\/([^/]+)$/);
  if (rawSourceMatch) {
    const rs = await getRawSourceById(env.DB, rawSourceMatch[1], userId);
    if (!rs) return notFound();
    return json({ ...rs, metadata: JSON.parse(rs.metadata) });
  }

  return notFound();
}
