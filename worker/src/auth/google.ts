import type { Env } from '../types.js';
import { getUserByGoogleSub, createUser, upsertOAuthToken } from '../db/queries.js';
import { createSession, setSessionCookie } from './session.js';

const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
].join(' ');

export function getAuthRedirectUrl(env: Env): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${env.API_URL}/api/auth/callback`,
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function handleCallback(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error || !code) {
    return Response.redirect(`${env.APP_URL}/?error=oauth_denied`, 302);
  }

  // Exchange code for tokens
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${env.API_URL}/api/auth/callback`,
      grant_type: 'authorization_code',
    }),
  });

  if (!tokenResp.ok) {
    return Response.redirect(`${env.APP_URL}/?error=oauth_failed`, 302);
  }

  const tokens = await tokenResp.json<{
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope: string;
    id_token: string;
  }>();

  // Decode id_token to get user info (without verifying signature — we just fetched it from Google)
  const [, payloadB64] = tokens.id_token.split('.');
  const idPayload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'))) as {
    sub: string;
    email: string;
  };

  let user = await getUserByGoogleSub(env.DB, idPayload.sub);
  if (!user) {
    user = await createUser(env.DB, idPayload.sub, idPayload.email);
  }

  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
  await upsertOAuthToken(
    env.DB,
    user.id,
    tokens.access_token,
    tokens.refresh_token ?? '',
    expiresAt,
    tokens.scope,
  );

  const sessionToken = await createSession(env, user.id, user.email);
  const redirect = new Response(null, {
    status: 302,
    headers: { Location: `${env.APP_URL}/search` },
  });
  return setSessionCookie(redirect, sessionToken);
}
