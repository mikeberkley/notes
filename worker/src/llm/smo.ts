import type { Env } from '../types.js';
import { callLLM } from './openrouter.js';
import { SYSTEM_PROMPT, buildLayer1Prompt, buildRollupPrompt, buildSourceSummaryPrompt } from './prompts.js';
import {
  getRawSourcesByDate,
  getUnsummarizedSources,
  saveSourceSummary,
  saveSourceSummaryError,
  getLayer1SmosForRange,
  getLayer2SmosForRange,
  getSmoById,
  getThemesBySmoId,
  insertSmo,
} from '../db/queries.js';
import { daysAgo, isLastFridayOfMonth, isFriday } from '../db/utils.js';

interface LLMSmoResponse {
  headline: string;
  summary: string;
  themes: Array<{ headline: string; summary: string }>;
  keywords: string[];
  key_entities: string[];
  open_questions: string | null;
  location: string | null;
}

interface SourceSummaryResponse {
  summary: string;
  key_decisions: string[];
  key_entities: string[];
  keywords: string[];
  open_questions: string | null;
}

export function parseSourceSummaryResponse(raw: string): SourceSummaryResponse {
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  const parsed = JSON.parse(cleaned) as SourceSummaryResponse;
  if (!parsed.summary) throw new Error('Missing summary field');
  if (!Array.isArray(parsed.key_decisions)) parsed.key_decisions = [];
  if (!Array.isArray(parsed.key_entities)) parsed.key_entities = [];
  if (!Array.isArray(parsed.keywords)) parsed.keywords = [];
  return parsed;
}

/**
 * Summarize all unsummarized raw sources for a given user and date.
 * Each source is processed independently — a failure on one does not block others.
 * Safe to re-run: skips sources that already have a summary.
 */
export async function summarizeRawSources(env: Env, userId: string, date: string): Promise<void> {
  const allUnsummarized = await getUnsummarizedSources(env.DB, userId, date);
  // Calendar events are pre-structured; no per-source LLM summarization needed
  const sources = allUnsummarized.filter(s => s.source_type !== 'gcalendar');
  if (sources.length === 0) return;

  console.log(`[summarize] ${sources.length} source(s) to summarize for ${date}`);
  let succeeded = 0;
  let failed = 0;

  for (const source of sources) {
    const meta = (() => { try { return JSON.parse(source.metadata); } catch { return {}; } })();
    const label = source.source_type === 'gmail'
      ? `email "${meta.subject ?? '(no subject)'}" from ${meta.sender ?? 'unknown'}`
      : `drive file "${meta.filename ?? source.id}"`;

    try {
      console.log(`[summarize] Processing ${label} (${source.id})`);
      const userPrompt = buildSourceSummaryPrompt(source.source_type, source.metadata, source.content);
      const raw = await callLLM(env, SYSTEM_PROMPT, userPrompt);
      const parsed = parseSourceSummaryResponse(raw);

      await saveSourceSummary(
        env.DB,
        source.id,
        parsed.summary,
        parsed.key_decisions,
        parsed.key_entities,
        parsed.keywords,
        parsed.open_questions,
      );
      succeeded++;
      console.log(`[summarize] ✓ ${label}`);
    } catch (err) {
      failed++;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[summarize] ✗ ${label} (${source.id}): ${errMsg}`);
      // Record the error so it's visible in the DB, but leave summarized_at NULL so next run retries
      await saveSourceSummaryError(env.DB, source.id, errMsg).catch(() => {});
      // Continue to next source regardless
    }
  }

  console.log(`[summarize] Done — ${succeeded} succeeded, ${failed} failed`);
}

export function parseLLMResponse(raw: string): LLMSmoResponse {
  // Strip any markdown code fences if the model includes them
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  const parsed = JSON.parse(cleaned) as LLMSmoResponse;

  // Validate structure
  if (!parsed.headline || !parsed.summary) throw new Error('Missing required fields');
  if (!Array.isArray(parsed.themes)) parsed.themes = [];
  if (!Array.isArray(parsed.keywords)) parsed.keywords = [];
  if (!Array.isArray(parsed.key_entities)) parsed.key_entities = [];
  if (parsed.location === undefined) parsed.location = null;

  // Clamp themes to 1–5
  parsed.themes = parsed.themes.slice(0, 5);

  return parsed;
}

export async function generateLayer1Smo(env: Env, userId: string, date: string): Promise<string | null> {
  // Step 1: ensure all sources are summarized first
  await summarizeRawSources(env, userId, date);

  // Step 2: fetch sources (now with summary fields populated where possible)
  const sources = await getRawSourcesByDate(env.DB, userId, date);

  let data: LLMSmoResponse;

  if (sources.length === 0) {
    data = {
      headline: 'No notable activity',
      summary: 'No content was ingested for this day.',
      themes: [],
      keywords: [],
      key_entities: [],
      open_questions: null,
      location: null,
    };
  } else {
    const userPrompt = buildLayer1Prompt(
      date,
      sources.map(s => ({
        type: s.source_type,
        metadata: s.metadata,
        content: s.content,
        summary: s.summary,
        key_decisions: s.key_decisions,
        key_entities: s.key_entities,
        keywords: s.keywords,
        open_questions: s.open_questions,
      })),
    );
    const raw = await callLLM(env, SYSTEM_PROMPT, userPrompt);
    data = parseLLMResponse(raw);
  }

  const sourceIds = sources.map(s => ({ type: 'raw_source' as const, id: s.id }));
  return insertSmo(env.DB, userId, 1, data, date, date, sourceIds);
}

export async function generateLayer2Smo(env: Env, userId: string, endDate: string): Promise<string | null> {
  const startDate = daysAgo(new Date(endDate), 6);
  const layer1Smos = await getLayer1SmosForRange(env.DB, userId, startDate, endDate);
  if (layer1Smos.length === 0) return null;

  const childData = await Promise.all(
    layer1Smos.map(async smo => {
      const themes = await getThemesBySmoId(env.DB, smo.id);
      return {
        headline: smo.headline,
        summary: smo.summary,
        themes: themes.map(t => ({ headline: t.headline, summary: t.summary })),
        keywords: JSON.parse(smo.keywords) as string[],
        key_entities: JSON.parse(smo.key_entities) as string[],
      };
    }),
  );

  const userPrompt = buildRollupPrompt(2, startDate, endDate, childData);
  const raw = await callLLM(env, SYSTEM_PROMPT, userPrompt);
  const data = parseLLMResponse(raw);

  const sourceIds = layer1Smos.map(s => ({ type: 'smo' as const, id: s.id }));
  return insertSmo(env.DB, userId, 2, data, startDate, endDate, sourceIds);
}

export async function generateLayer3Smo(env: Env, userId: string, endDate: string): Promise<string | null> {
  const startDate = daysAgo(new Date(endDate), 27); // ~4 weeks
  const layer2Smos = await getLayer2SmosForRange(env.DB, userId, startDate, endDate);
  if (layer2Smos.length === 0) return null;

  const childData = await Promise.all(
    layer2Smos.map(async smo => {
      const themes = await getThemesBySmoId(env.DB, smo.id);
      return {
        headline: smo.headline,
        summary: smo.summary,
        themes: themes.map(t => ({ headline: t.headline, summary: t.summary })),
        keywords: JSON.parse(smo.keywords) as string[],
        key_entities: JSON.parse(smo.key_entities) as string[],
      };
    }),
  );

  const userPrompt = buildRollupPrompt(3, startDate, endDate, childData);
  const raw = await callLLM(env, SYSTEM_PROMPT, userPrompt);
  const data = parseLLMResponse(raw);

  const sourceIds = layer2Smos.map(s => ({ type: 'smo' as const, id: s.id }));
  return insertSmo(env.DB, userId, 3, data, startDate, endDate, sourceIds);
}

export async function runSmoGenerationPipeline(env: Env, date?: string): Promise<void> {
  const { getAllUsersWithTokens } = await import('../db/queries.js');
  const targetDate = date ?? daysAgo(new Date(), 1);
  const targetDateObj = new Date(targetDate);

  const users = await getAllUsersWithTokens(env.DB);

  for (const user of users) {
    try {
      // Layer 1 — always
      await generateLayer1Smo(env, user.id, targetDate);
      console.log(`[smo] Layer 1 generated for user ${user.id} on ${targetDate}`);

      // Layer 2 — every Friday
      if (isFriday(targetDateObj)) {
        await generateLayer2Smo(env, user.id, targetDate);
        console.log(`[smo] Layer 2 generated for user ${user.id}`);
      }

      // Layer 3 — last Friday of month
      if (isLastFridayOfMonth(targetDateObj)) {
        await generateLayer3Smo(env, user.id, targetDate);
        console.log(`[smo] Layer 3 generated for user ${user.id}`);
      }
    } catch (err) {
      console.error(`[smo] User ${user.id} error:`, err);
    }
  }
}
