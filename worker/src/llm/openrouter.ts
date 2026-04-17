import type { Env } from '../types.js';

const LLM_TIMEOUT_MS = 90_000; // 90 seconds per call — generous for large docs, still bounded

export async function callLLM(env: Env, systemPrompt: string, userPrompt: string): Promise<string> {
  const model = env.OPENROUTER_MODEL ?? 'moonshotai/kimi-k2';

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
