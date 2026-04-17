import type { Env } from '../types.js';
import { getApiKeyByHash, touchApiKey } from '../db/queries.js';
import { hashKey } from '../db/utils.js';

export async function requireApiKey(request: Request, env: Env): Promise<string | null> {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;

  const rawKey = auth.slice(7).trim();
  if (!rawKey) return null;

  const keyHash = await hashKey(rawKey);
  const apiKey = await getApiKeyByHash(env.DB, keyHash);
  if (!apiKey) return null;

  await touchApiKey(env.DB, apiKey.id);
  return apiKey.user_id;
}
