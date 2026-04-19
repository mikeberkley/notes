import type { Env } from '../types.js';
import { getConfig } from '../db/queries.js';
import { buildIntelligenceSystemPrompt } from '../llm/prompts.js';
import { streamChatCompletion } from '../llm/openrouter.js';
import { assembleIntelligenceContext, type IntelligenceFilters } from './context.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://notes.lost2038.com',
  'Access-Control-Allow-Credentials': 'true',
};

export async function handleIntelligenceQuery(
  request: Request,
  env: Env,
  userId: string,
  ctx: ExecutionContext,
): Promise<Response> {
  let body: {
    question: string;
    history: Array<{ role: 'user' | 'assistant'; content: string }>;
    filters: IntelligenceFilters;
  };

  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }

  const { question, history = [], filters = { q: '' } } = body;
  if (!question?.trim()) {
    return new Response(JSON.stringify({ error: 'question is required' }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }

  // Load user config and assemble context in parallel
  const [systemPromptConfig, alwaysContextConfig, { contextBlock, meta }] = await Promise.all([
    getConfig(env.DB, userId, 'intelligence_system_prompt'),
    getConfig(env.DB, userId, 'intelligence_context'),
    assembleIntelligenceContext(env.DB, userId, filters),
  ]);

  const systemPrompt = buildIntelligenceSystemPrompt(systemPromptConfig, alwaysContextConfig);

  // Build messages: system + context injection + conversation history + current question
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: contextBlock },
    { role: 'assistant', content: 'I have reviewed your memory context and am ready to answer questions about it.' },
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: question.trim() },
  ];

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const streamWork = async () => {
    try {
      // First event: context metadata
      const metaEvent = `event: meta\ndata: ${JSON.stringify(meta)}\n\n`;
      await writer.write(encoder.encode(metaEvent));

      // Stream LLM response
      for await (const text of streamChatCompletion(env, messages)) {
        const chunkEvent = `event: chunk\ndata: ${JSON.stringify({ text })}\n\n`;
        await writer.write(encoder.encode(chunkEvent));
      }

      await writer.write(encoder.encode('event: done\ndata: {}\n\n'));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await writer.write(encoder.encode(`event: error\ndata: ${JSON.stringify({ message: errMsg })}\n\n`)).catch(() => {});
    } finally {
      await writer.close().catch(() => {});
    }
  };

  ctx.waitUntil(streamWork());

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      ...CORS_HEADERS,
    },
  });
}
