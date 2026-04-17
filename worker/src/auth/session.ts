import type { Env, SessionPayload } from '../types.js';

const ALGORITHM = { name: 'HMAC', hash: 'SHA-256' };
const SESSION_DURATION = 24 * 60 * 60; // 24 hours in seconds
const COOKIE_NAME = 'notes_session';

async function getKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    ALGORITHM,
    false,
    ['sign', 'verify'],
  );
}

function base64url(buf: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf instanceof ArrayBuffer ? buf : buf.buffer)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function fromBase64url(str: string): Uint8Array {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = s + '=='.slice(0, (4 - s.length % 4) % 4);
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}

export async function createSession(env: Env, userId: string, email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPayload = {
    sub: userId,
    email,
    iat: now,
    exp: now + SESSION_DURATION,
  };

  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const sigInput = `${header}.${body}`;

  const key = await getKey(env.SESSION_SECRET);
  const sig = await crypto.subtle.sign(ALGORITHM, key, new TextEncoder().encode(sigInput).buffer as ArrayBuffer);

  return `${sigInput}.${base64url(sig)}`;
}

export async function verifySession(env: Env, token: string): Promise<SessionPayload | null> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [header, body, sig] = parts;
    const key = await getKey(env.SESSION_SECRET);
    const valid = await crypto.subtle.verify(
      ALGORITHM,
      key,
      fromBase64url(sig).buffer as ArrayBuffer,
      new TextEncoder().encode(`${header}.${body}`).buffer as ArrayBuffer,
    );
    if (!valid) return null;

    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(body))) as SessionPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;

    return payload;
  } catch {
    return null;
  }
}

export function setSessionCookie(response: Response, token: string): Response {
  const headers = new Headers(response.headers);
  headers.append('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_DURATION}`);
  return new Response(response.body, { status: response.status, headers });
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function getSessionToken(request: Request): string | null {
  const cookie = request.headers.get('Cookie') ?? '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return match?.[1] ?? null;
}

export async function requireSession(request: Request, env: Env): Promise<SessionPayload | null> {
  const token = getSessionToken(request);
  if (!token) return null;
  return verifySession(env, token);
}
