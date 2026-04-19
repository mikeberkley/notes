import type { D1Database } from '@cloudflare/workers-types';
import {
  getSmosForIntelligence,
  getThemesForSmos,
  getSourceSummariesForSmos,
} from '../db/queries.js';
import { buildIntelligenceContextBlock } from '../llm/prompts.js';

export interface IntelligenceFilters {
  q: string;
  layer?: number;
  from?: string;
  to?: string;
}

export interface ContextMeta {
  smo_count: number;
  source_count: number;
  token_estimate: number;
}

export async function assembleIntelligenceContext(
  db: D1Database,
  userId: string,
  filters: IntelligenceFilters,
): Promise<{ contextBlock: string; meta: ContextMeta }> {
  const smos = await getSmosForIntelligence(db, userId, filters.q, filters.layer, filters.from, filters.to);

  if (smos.length === 0) {
    return {
      contextBlock: 'MEMORY CONTEXT: No memories match the current filters.',
      meta: { smo_count: 0, source_count: 0, token_estimate: 0 },
    };
  }

  const smoIds = smos.map(s => s.id);
  const [themesMap, sourcesMap] = await Promise.all([
    getThemesForSmos(db, smoIds),
    getSourceSummariesForSmos(db, userId, smoIds),
  ]);

  const { block, smoCount, sourceCount, charCount } = buildIntelligenceContextBlock(
    smos,
    themesMap,
    sourcesMap,
  );

  return {
    contextBlock: block,
    meta: {
      smo_count: smoCount,
      source_count: sourceCount,
      token_estimate: Math.ceil(charCount / 4),
    },
  };
}
