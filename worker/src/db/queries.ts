import type { Env, User, OAuthToken, RawSource, Smo, Theme, ApiKey } from '../types.js';
import { randomUUID } from './utils.js';

// ─── Users ───────────────────────────────────────────────────────────────────

export async function getUserByGoogleSub(db: D1Database, sub: string): Promise<User | null> {
  const row = await db.prepare('SELECT * FROM users WHERE google_sub = ?').bind(sub).first<User>();
  return row ?? null;
}

export async function getUserById(db: D1Database, id: string): Promise<User | null> {
  const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<User>();
  return row ?? null;
}

export async function createUser(db: D1Database, googleSub: string, email: string): Promise<User> {
  const id = randomUUID();
  await db.prepare('INSERT INTO users (id, google_sub, email) VALUES (?, ?, ?)').bind(id, googleSub, email).run();
  return { id, google_sub: googleSub, email, created_at: new Date().toISOString() };
}

// ─── OAuth Tokens ─────────────────────────────────────────────────────────────

export async function upsertOAuthToken(
  db: D1Database,
  userId: string,
  accessToken: string,
  refreshToken: string,
  expiresAt: Date,
  scopes: string,
): Promise<void> {
  const id = randomUUID();
  await db.prepare(`
    INSERT INTO oauth_tokens (id, user_id, provider, access_token, refresh_token, expires_at, scopes)
    VALUES (?, ?, 'google', ?, ?, ?, ?)
    ON CONFLICT(user_id, provider) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = CASE WHEN excluded.refresh_token != '' THEN excluded.refresh_token ELSE refresh_token END,
      expires_at = excluded.expires_at,
      scopes = excluded.scopes
  `).bind(id, userId, accessToken, refreshToken, expiresAt.toISOString(), scopes).run();
}

export async function getOAuthToken(db: D1Database, userId: string): Promise<OAuthToken | null> {
  const row = await db.prepare(
    "SELECT * FROM oauth_tokens WHERE user_id = ? AND provider = 'google'"
  ).bind(userId).first<OAuthToken>();
  return row ?? null;
}

export async function refreshOAuthAccessToken(
  db: D1Database,
  env: Env,
  userId: string,
): Promise<string | null> {
  const token = await getOAuthToken(db, userId);
  if (!token) return null;

  const now = new Date();
  const expiresAt = new Date(token.expires_at);
  // If still valid for >5 minutes, return current token
  if (expiresAt.getTime() - now.getTime() > 5 * 60 * 1000) {
    return token.access_token;
  }

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!resp.ok) return null;

  const data = await resp.json<{ access_token: string; expires_in: number }>();
  const newExpiry = new Date(Date.now() + data.expires_in * 1000);
  await upsertOAuthToken(db, userId, data.access_token, '', newExpiry, token.scopes);
  return data.access_token;
}

// ─── Raw Sources ──────────────────────────────────────────────────────────────

export async function insertRawSource(
  db: D1Database,
  userId: string,
  sourceType: 'gmail' | 'gdrive' | 'workflowy' | 'slack' | 'gcalendar',
  externalId: string,
  content: string,
  metadata: object,
  sourceDate: string,
): Promise<void> {
  const id = randomUUID();
  await db.prepare(`
    INSERT OR IGNORE INTO raw_sources (id, user_id, source_type, external_id, content, metadata, source_date)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(id, userId, sourceType, externalId, content, JSON.stringify(metadata), sourceDate).run();
}

export async function getRawSourcesByDate(
  db: D1Database,
  userId: string,
  date: string,
): Promise<RawSource[]> {
  const { results } = await db.prepare(
    'SELECT * FROM raw_sources WHERE user_id = ? AND source_date = ?'
  ).bind(userId, date).all<RawSource>();
  return results;
}

export async function getUnsummarizedSources(
  db: D1Database,
  userId: string,
  date: string,
): Promise<RawSource[]> {
  const { results } = await db.prepare(
    'SELECT * FROM raw_sources WHERE user_id = ? AND source_date = ? AND summarized_at IS NULL'
  ).bind(userId, date).all<RawSource>();
  return results;
}

export async function indexSourceInFts(
  db: D1Database,
  sourceId: string,
  userId: string,
  text: string,
): Promise<void> {
  await db.prepare('DELETE FROM raw_sources_fts WHERE raw_source_id = ?').bind(sourceId).run();
  await db.prepare(
    'INSERT INTO raw_sources_fts (raw_source_id, user_id, text) VALUES (?, ?, ?)'
  ).bind(sourceId, userId, text).run();
}

export async function saveSourceSummary(
  db: D1Database,
  sourceId: string,
  userId: string,
  summary: string,
  keyDecisions: string[],
  keyEntities: string[],
  keywords: string[],
  openQuestions: string | null,
): Promise<void> {
  await db.prepare(`
    UPDATE raw_sources
    SET summary = ?, key_decisions = ?, key_entities = ?, keywords = ?,
        open_questions = ?, summarized_at = CURRENT_TIMESTAMP, summary_error = NULL
    WHERE id = ?
  `).bind(
    summary,
    JSON.stringify(keyDecisions),
    JSON.stringify(keyEntities),
    JSON.stringify(keywords),
    openQuestions,
    sourceId,
  ).run();

  // Index all LLM-generated fields (summary, keywords, entities, decisions, open questions)
  const searchText = [summary, keywords.join(' '), keyEntities.join(' '), keyDecisions.join(' '), openQuestions ?? ''].join(' ');
  await indexSourceInFts(db, sourceId, userId, searchText);
}

export async function saveSourceSummaryError(
  db: D1Database,
  sourceId: string,
  error: string,
): Promise<void> {
  // summarized_at intentionally left NULL so the next pipeline run will retry this source
  await db.prepare(
    'UPDATE raw_sources SET summary_error = ? WHERE id = ?'
  ).bind(error, sourceId).run();
}

export async function getRawSourceById(db: D1Database, id: string, userId: string): Promise<RawSource | null> {
  const row = await db.prepare('SELECT * FROM raw_sources WHERE id = ? AND user_id = ?').bind(id, userId).first<RawSource>();
  return row ?? null;
}

// ─── SMOs ─────────────────────────────────────────────────────────────────────

export async function insertSmo(
  db: D1Database,
  userId: string,
  layer: 1 | 2 | 3,
  data: {
    headline: string;
    summary: string;
    keywords: string[];
    key_entities: string[];
    key_decisions: string[];
    open_questions: string | null;
    themes: Array<{ headline: string; summary: string }>;
    location?: string | null;
  },
  dateStart: string,
  dateEnd: string,
  sourceIds: Array<{ type: 'raw_source' | 'smo'; id: string }>,
): Promise<string> {
  const smoId = randomUUID();

  await db.prepare(`
    INSERT INTO smos (id, user_id, layer, headline, summary, keywords, key_entities, key_decisions, open_questions, location, date_range_start, date_range_end)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    smoId, userId, layer,
    data.headline, data.summary,
    JSON.stringify(data.keywords),
    JSON.stringify(data.key_entities),
    JSON.stringify(data.key_decisions),
    data.open_questions ?? null,
    data.location ?? null,
    dateStart, dateEnd,
  ).run();

  for (let i = 0; i < data.themes.length; i++) {
    const t = data.themes[i];
    await db.prepare(
      'INSERT INTO themes (id, smo_id, user_id, headline, summary, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(randomUUID(), smoId, userId, t.headline, t.summary, i + 1).run();
  }

  for (const src of sourceIds) {
    await db.prepare(
      'INSERT OR IGNORE INTO source_pointers (smo_id, target_type, target_id) VALUES (?, ?, ?)'
    ).bind(smoId, src.type, src.id).run();
  }

  // Update FTS index
  const themesText = data.themes.map(t => `${t.headline} ${t.summary}`).join(' ');
  await db.prepare(`
    INSERT INTO smo_fts (smo_id, user_id, layer, headline, summary, keywords, key_entities, themes_text, open_questions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    smoId, userId, layer,
    data.headline,
    data.summary,
    data.keywords.join(' '),
    data.key_entities.join(' '),
    themesText,
    data.open_questions ?? '',
  ).run();

  return smoId;
}

export async function getSmoById(db: D1Database, id: string, userId: string): Promise<Smo | null> {
  const row = await db.prepare('SELECT * FROM smos WHERE id = ? AND user_id = ?').bind(id, userId).first<Smo>();
  return row ?? null;
}

export async function getThemesBySmoId(db: D1Database, smoId: string): Promise<Theme[]> {
  const { results } = await db.prepare(
    'SELECT * FROM themes WHERE smo_id = ? ORDER BY sort_order'
  ).bind(smoId).all<Theme>();
  return results;
}

export async function getSmosByLayerAndDate(
  db: D1Database,
  userId: string,
  layer: number,
  date: string,
): Promise<Smo[]> {
  const { results } = await db.prepare(
    'SELECT * FROM smos WHERE user_id = ? AND layer = ? AND date_range_start = ? ORDER BY created_at DESC'
  ).bind(userId, layer, date).all<Smo>();
  return results;
}

export async function getLayer1SmosForRange(
  db: D1Database,
  userId: string,
  startDate: string,
  endDate: string,
): Promise<Smo[]> {
  const { results } = await db.prepare(
    'SELECT * FROM smos WHERE user_id = ? AND layer = 1 AND date_range_start >= ? AND date_range_start <= ? ORDER BY date_range_start'
  ).bind(userId, startDate, endDate).all<Smo>();
  return results;
}

export async function getLayer2SmosForRange(
  db: D1Database,
  userId: string,
  startDate: string,
  endDate: string,
): Promise<Smo[]> {
  const { results } = await db.prepare(
    'SELECT * FROM smos WHERE user_id = ? AND layer = 2 AND date_range_start >= ? AND date_range_start <= ? ORDER BY date_range_start'
  ).bind(userId, startDate, endDate).all<Smo>();
  return results;
}

export async function getChildSmos(
  db: D1Database,
  parentSmoId: string,
  userId: string,
): Promise<Smo[]> {
  const { results } = await db.prepare(`
    SELECT s.* FROM smos s
    INNER JOIN source_pointers sp ON sp.target_id = s.id AND sp.target_type = 'smo'
    WHERE sp.smo_id = ? AND s.user_id = ?
    ORDER BY s.date_range_start
  `).bind(parentSmoId, userId).all<Smo>();
  return results;
}

export async function getSourcePointers(
  db: D1Database,
  smoId: string,
): Promise<Array<{ target_type: string; target_id: string }>> {
  const { results } = await db.prepare(
    'SELECT target_type, target_id FROM source_pointers WHERE smo_id = ?'
  ).bind(smoId).all<{ target_type: string; target_id: string }>();
  return results;
}

// ─── Search ───────────────────────────────────────────────────────────────────

export async function searchSmos(
  db: D1Database,
  userId: string,
  query: string,
  layer?: number,
  fromDate?: string,
  toDate?: string,
  limit = 200,
): Promise<Array<{ smo_id: string; layer: number; headline: string; date_range_start: string; date_range_end: string; location: string | null; snippet: string; rank: number | null; source_label?: string; source_url?: string | null }>> {
  // Empty query: list all SMOs sorted by date, no FTS needed
  if (!query.trim()) {
    let sql = `
      SELECT id as smo_id, layer, headline, date_range_start, date_range_end, location, '' as snippet, NULL as rank
      FROM smos
      WHERE user_id = ?
    `;
    const params: (string | number)[] = [userId];

    if (layer !== undefined) { sql += ' AND layer = ?'; params.push(layer); }
    if (fromDate) { sql += ' AND date_range_start >= ?'; params.push(fromDate); }
    if (toDate) { sql += ' AND date_range_start <= ?'; params.push(toDate); }

    sql += ' ORDER BY date_range_start DESC LIMIT ?';
    params.push(limit);

    const { results } = await db.prepare(sql).bind(...params).all<{
      smo_id: string; layer: number; headline: string;
      date_range_start: string; date_range_end: string; location: string | null; snippet: string; rank: number | null;
    }>();
    return results;
  }

  // Non-empty search: source-level matches take priority over SMO-level matches.
  // Source matches show clickable links with snippets; SMO-only matches show snippet context only.
  const trimmed = query.trim();
  const ftsQuery = trimmed.includes(' ') ? `"${trimmed}"` : `${trimmed}*`;
  const queryWords = trimmed.toLowerCase().replace(/['"]/g, '').split(/\s+/).filter(Boolean);

  type SrcRow = {
    smo_id: string; layer: number; headline: string;
    date_range_start: string; date_range_end: string; location: string | null;
    snippet: string; rank: number | null; source_label: string; source_url: string | null;
    source_type: string; metadata: string;
  };

  // Query 1: source-level FTS matches — one row per (smo, source) with best rank for that source
  let srcSql = `
    SELECT sp.smo_id, s.layer, s.headline, s.date_range_start, s.date_range_end, s.location,
           rs.source_type, rs.metadata,
           (COALESCE(rs.summary, '') || ' ' || COALESCE(rs.key_entities, '') || ' ' || COALESCE(rs.keywords, '') || ' ' || COALESCE(rs.content, '')) as snippet,
           MAX(rsfts.rank) as rank,
           CASE rs.source_type
             WHEN 'gmail'     THEN 'Gmail: '     || COALESCE(json_extract(rs.metadata, '$.subject'), '(no subject)')
             WHEN 'gdrive'    THEN 'Drive: '     || COALESCE(json_extract(rs.metadata, '$.filename'), 'Untitled')
             WHEN 'workflowy' THEN 'Workflowy: ' || COALESCE(json_extract(rs.metadata, '$.root_name'), 'Note')
             WHEN 'gcalendar' THEN 'Calendar: '  || COALESCE(json_extract(rs.metadata, '$.title'), 'Event')
             WHEN 'slack' THEN CASE json_extract(rs.metadata, '$.type')
               WHEN 'dm' THEN 'Slack DM: ' || COALESCE(json_extract(rs.metadata, '$.with_user'), 'Unknown')
               ELSE 'Slack: #' || COALESCE(json_extract(rs.metadata, '$.channel_name'), 'channel')
             END
             ELSE rs.source_type
           END as source_label,
           CASE rs.source_type
             WHEN 'gmail'     THEN 'https://mail.google.com/mail/u/0/#inbox/' || rs.external_id
             WHEN 'gdrive'    THEN 'https://drive.google.com/file/d/' ||
                                   CASE WHEN INSTR(rs.external_id, '::') > 0
                                     THEN SUBSTR(rs.external_id, 1, INSTR(rs.external_id, '::') - 1)
                                     ELSE rs.external_id
                                   END || '/view'
             WHEN 'workflowy' THEN 'https://workflowy.com/#' || COALESCE(json_extract(rs.metadata, '$.root_node_id'), '')
             WHEN 'gcalendar' THEN 'https://calendar.google.com/calendar/r'
             WHEN 'slack'     THEN CASE json_extract(rs.metadata, '$.type')
               WHEN 'channel' THEN 'https://app.slack.com/archives/' ||
                                    SUBSTR(SUBSTR(rs.external_id, INSTR(rs.external_id, '::') + 2), 1,
                                      INSTR(SUBSTR(rs.external_id, INSTR(rs.external_id, '::') + 2) || '::', '::') - 1)
               ELSE NULL
             END
             ELSE NULL
           END as source_url
    FROM raw_sources_fts rsfts
    INNER JOIN source_pointers sp ON sp.target_id = rsfts.raw_source_id AND sp.target_type = 'raw_source'
    INNER JOIN smos s ON s.id = sp.smo_id
    LEFT JOIN raw_sources rs ON rs.id = rsfts.raw_source_id
    WHERE raw_sources_fts MATCH ? AND rsfts.user_id = ?
  `;
  const srcParams: (string | number)[] = [ftsQuery, userId];
  if (layer !== undefined) { srcSql += ' AND s.layer = ?'; srcParams.push(layer); }
  if (fromDate) { srcSql += ' AND s.date_range_start >= ?'; srcParams.push(fromDate); }
  if (toDate) { srcSql += ' AND s.date_range_start <= ?'; srcParams.push(toDate); }
  srcSql += ' GROUP BY sp.smo_id, rs.id LIMIT ?';
  srcParams.push(limit);

  const { results: sourceResults } = await db.prepare(srcSql).bind(...srcParams).all<SrcRow>();

  // Resolve Workflowy deep-links for source matches
  for (const r of sourceResults) {
    if (r.source_type === 'workflowy' && r.metadata) {
      try {
        const meta = JSON.parse(r.metadata) as { node_index?: [string, string][] };
        const match = (meta.node_index ?? []).find(([, text]) =>
          queryWords.some(word => text.toLowerCase().includes(word))
        );
        if (match) r.source_url = `https://workflowy.com/#${match[0]}`;
      } catch { /* leave root URL */ }
    }
  }

  // SMO IDs already covered by source-level matches
  const smoIdsFromSources = new Set(sourceResults.map(r => r.smo_id));

  // Query 2: SMO-level FTS for SMOs not already found via sources (snippet context only, no links)
  let smoSql = `
    SELECT f.smo_id, s.layer, s.headline, s.date_range_start, s.date_range_end, s.location,
           (s.summary || ' ' || COALESCE(f.keywords, '') || ' ' || COALESCE(f.key_entities, '') || ' ' || COALESCE(f.themes_text, '') || ' ' || COALESCE(s.open_questions, '')) as snippet,
           f.rank
    FROM smo_fts f
    INNER JOIN smos s ON s.id = f.smo_id
    WHERE smo_fts MATCH ? AND f.user_id = ?
  `;
  const smoParams: (string | number)[] = [ftsQuery, userId];
  if (layer !== undefined) { smoSql += ' AND f.layer = ?'; smoParams.push(layer); }
  if (fromDate) { smoSql += ' AND s.date_range_start >= ?'; smoParams.push(fromDate); }
  if (toDate) { smoSql += ' AND s.date_range_start <= ?'; smoParams.push(toDate); }
  if (smoIdsFromSources.size > 0) {
    smoSql += ` AND f.smo_id NOT IN (${[...smoIdsFromSources].map(() => '?').join(',')})`;
    smoParams.push(...smoIdsFromSources);
  }
  smoSql += ' ORDER BY rank LIMIT ?';
  smoParams.push(limit - sourceResults.length);

  const { results: smoResults } = sourceResults.length < limit
    ? await db.prepare(smoSql).bind(...smoParams).all<{
        smo_id: string; layer: number; headline: string;
        date_range_start: string; date_range_end: string; location: string | null;
        snippet: string; rank: number;
      }>()
    : { results: [] };

  // Deduplicate SMO-only results (FTS may return multiple rows per smo_id)
  const seenSmo = new Set<string>();
  const dedupedSmoResults = smoResults.filter(r => {
    if (seenSmo.has(r.smo_id)) return false;
    seenSmo.add(r.smo_id);
    return true;
  });

  // Compute composite rank per SMO from source matches:
  // primary = best (max = least-negative) individual source rank; secondary = match count
  type SmoGroup = { rows: SrcRow[]; bestRank: number; matchCount: number };
  const smoGroups = new Map<string, SmoGroup>();
  for (const r of sourceResults) {
    const rank = r.rank ?? 0;
    const g = smoGroups.get(r.smo_id);
    if (!g) smoGroups.set(r.smo_id, { rows: [r], bestRank: rank, matchCount: 1 });
    else { g.rows.push(r); g.bestRank = Math.max(g.bestRank, rank); g.matchCount++; }
  }

  // Sort source SMO groups by composite rank (less-negative = better, then more matches)
  const sortedGroups = [...smoGroups.values()].sort((a, b) =>
    a.bestRank !== b.bestRank ? b.bestRank - a.bestRank : b.matchCount - a.matchCount
  );

  // Merge source groups and SMO-only rows in rank order, then flatten
  type Block = { rank: number; rows: SrcRow[] };
  const blocks: Block[] = [
    ...sortedGroups.map(g => ({ rank: g.bestRank, rows: g.rows })),
    ...dedupedSmoResults.map(r => ({ rank: r.rank ?? 0, rows: [r as unknown as SrcRow] })),
  ];
  blocks.sort((a, b) => b.rank - a.rank); // less-negative first

  return blocks.flatMap(b => b.rows);
}

// ─── API Keys ─────────────────────────────────────────────────────────────────

export async function createApiKey(
  db: D1Database,
  userId: string,
  label: string,
  keyHash: string,
): Promise<string> {
  const id = randomUUID();
  await db.prepare(
    'INSERT INTO api_keys (id, user_id, key_hash, label) VALUES (?, ?, ?, ?)'
  ).bind(id, userId, keyHash, label).run();
  return id;
}

export async function getApiKeyByHash(db: D1Database, keyHash: string): Promise<ApiKey | null> {
  const row = await db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').bind(keyHash).first<ApiKey>();
  return row ?? null;
}

export async function listApiKeys(db: D1Database, userId: string): Promise<ApiKey[]> {
  const { results } = await db.prepare(
    'SELECT id, user_id, label, last_used, created_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(userId).all<ApiKey>();
  return results;
}

export async function deleteApiKey(db: D1Database, id: string, userId: string): Promise<void> {
  await db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?').bind(id, userId).run();
}

export async function touchApiKey(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE api_keys SET last_used = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
}

// ─── Config ───────────────────────────────────────────────────────────────────

export async function getConfig(db: D1Database, userId: string, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM config WHERE user_id = ? AND key = ?').bind(userId, key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setConfig(db: D1Database, userId: string, key: string, value: string): Promise<void> {
  await db.prepare(`
    INSERT INTO config (user_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value
  `).bind(userId, key, value).run();
}

// ─── All users with Google tokens ────────────────────────────────────────────

export async function getAllUsersWithTokens(db: D1Database): Promise<User[]> {
  const { results } = await db.prepare(`
    SELECT u.* FROM users u
    INNER JOIN oauth_tokens t ON t.user_id = u.id AND t.provider = 'google'
    WHERE t.refresh_token != ''
  `).all<User>();
  return results;
}
