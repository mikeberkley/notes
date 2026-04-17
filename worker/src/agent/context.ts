import type { Smo, Theme } from '../types.js';
import { searchSmos, getSmoById, getThemesBySmoId } from '../db/queries.js';

// Rough token estimator: ~4 chars per token
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function formatSmo(smo: Smo, themes: Theme[]): string {
  const keywords = JSON.parse(smo.keywords) as string[];
  const entities = JSON.parse(smo.key_entities) as string[];

  let text = `=== [Layer ${smo.layer}] ${smo.date_range_start}`;
  if (smo.date_range_end !== smo.date_range_start) text += ` – ${smo.date_range_end}`;
  text += ` ===\n`;
  text += `${smo.headline}\n\n`;
  text += `${smo.summary}\n\n`;

  if (themes.length > 0) {
    text += `Themes:\n`;
    for (const t of themes) {
      text += `  • ${t.headline}: ${t.summary}\n`;
    }
    text += '\n';
  }

  if (keywords.length > 0) text += `Keywords: ${keywords.join(', ')}\n`;
  if (entities.length > 0) text += `Entities: ${entities.join(', ')}\n`;
  if (smo.open_questions) text += `Open questions: ${smo.open_questions}\n`;

  return text;
}

export async function assembleContext(
  db: D1Database,
  userId: string,
  query: string,
  budget: number,
  fromDate?: string,
  toDate?: string,
  layer?: number,
): Promise<{ context: string; sources: Array<{ smo_id: string; layer: number; headline: string }>; tokens_used: number }> {
  const results = await searchSmos(db, userId, query, layer, fromDate, toDate, 50);

  const blocks: string[] = [];
  const sources: Array<{ smo_id: string; layer: number; headline: string }> = [];
  let tokensUsed = 0;

  // Sort by layer descending (most summarized first) then by relevance (already ranked)
  const sorted = [...results].sort((a, b) => b.layer - a.layer);

  for (const r of sorted) {
    const smo = await getSmoById(db, r.smo_id, userId);
    if (!smo) continue;
    const themes = await getThemesBySmoId(db, smo.id);
    const block = formatSmo(smo, themes);
    const blockTokens = estimateTokens(block);

    if (tokensUsed + blockTokens > budget) break;

    blocks.push(block);
    sources.push({ smo_id: smo.id, layer: smo.layer, headline: smo.headline });
    tokensUsed += blockTokens;
  }

  return {
    context: blocks.join('\n\n'),
    sources,
    tokens_used: tokensUsed,
  };
}
