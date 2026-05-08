import type { Env } from '../types.js';

const LLM_TIMEOUT_MS = 90_000; // 90 seconds per call — generous for large docs, still bounded
const STREAM_TIMEOUT_MS = 120_000; // 2 minutes for streaming (longer responses)

export async function callLLM(env: Env, systemPrompt: string, userPrompt: string): Promise<string> {
  const model = env.OPENROUTER_MODEL ?? 'anthropic/claude-sonnet-4-6';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
      }),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    throw new Error(`OpenRouter error ${resp.status}: ${await resp.text()}`);
  }

  const data = await resp.json<{
    choices: Array<{ message: { content: string } }>;
  }>();

  const content = data.choices[0]?.message?.content ?? '';
  if (!content) throw new Error('OpenRouter returned empty content');
  return content;
}

// PDF document blocks require a model that supports them. Always use Claude regardless
// of OPENROUTER_MODEL, which may be set to a model that silently ignores document blocks.
const PDF_MODEL = 'anthropic/claude-sonnet-4-6';

export async function callLLMWithPDF(
  env: Env,
  systemPrompt: string,
  pdfBase64: string,
  textPrompt: string,
): Promise<string> {
  const model = PDF_MODEL;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
              { type: 'text', text: textPrompt },
            ],
          },
        ],
        temperature: 0.3,
      }),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) throw new Error(`OpenRouter error ${resp.status}: ${await resp.text()}`);

  const data = await resp.json<{ choices: Array<{ message: { content: string } }> }>();
  const content = data.choices[0]?.message?.content ?? '';
  if (!content) throw new Error('OpenRouter returned empty content');
  return content;
}

export async function* streamChatCompletion(
  env: Env,
  messages: Array<{ role: string; content: string }>,
  model?: string,
): AsyncGenerator<string> {
  const resolvedModel = model ?? env.OPENROUTER_MODEL ?? 'anthropic/claude-sonnet-4-6';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STREAM_TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: resolvedModel,
        messages,
        temperature: 0.5,
        stream: true,
      }),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    throw new Error(`OpenRouter stream error ${resp.status}: ${await resp.text()}`);
  }

  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;
        try {
          const parsed = JSON.parse(trimmed.slice(6)) as { choices?: Array<{ delta?: { content?: string } }> };
          const text = parsed.choices?.[0]?.delta?.content;
          if (text) yield text;
        } catch { /* skip malformed SSE lines */ }
      }
    }
    // flush remaining buffer
    const trimmed = buffer.trim();
    if (trimmed && trimmed !== 'data: [DONE]' && trimmed.startsWith('data: ')) {
      try {
        const parsed = JSON.parse(trimmed.slice(6)) as { choices?: Array<{ delta?: { content?: string } }> };
        const text = parsed.choices?.[0]?.delta?.content;
        if (text) yield text;
      } catch { /* ignore */ }
    }
  } finally {
    reader.releaseLock();
  }
}
