import { describe, it, expect } from 'vitest';
import { createSession, verifySession, getSessionToken } from './session.js';
import type { Env } from '../types.js';

function makeEnv(secret = 'test-secret-at-least-32-chars-long!'): Env {
  return {
    SESSION_SECRET: secret,
    DB: {} as D1Database,
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    OPENROUTER_API_KEY: '',
    OPENROUTER_MODEL: '',
    APP_URL: '',
    API_URL: '',
  };
}

describe('createSession / verifySession', () => {
  it('round-trips a valid token', async () => {
    const env = makeEnv();
    const token = await createSession(env, 'user-123', 'test@example.com');
    expect(token.split('.')).toHaveLength(3);

    const payload = await verifySession(env, token);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe('user-123');
    expect(payload!.email).toBe('test@example.com');
  });

  it('sets iat and exp ~24 hours apart', async () => {
    const env = makeEnv();
    const before = Math.floor(Date.now() / 1000);
    const token = await createSession(env, 'user-123', 'test@example.com');
    const after = Math.floor(Date.now() / 1000);

    const payload = await verifySession(env, token);
    expect(payload!.iat).toBeGreaterThanOrEqual(before);
    expect(payload!.iat).toBeLessThanOrEqual(after);
    expect(payload!.exp - payload!.iat).toBe(24 * 60 * 60);
  });

  it('returns null for a tampered payload', async () => {
    const env = makeEnv();
    const token = await createSession(env, 'user-123', 'test@example.com');
    const parts = token.split('.');

    // Tamper the payload by overwriting the body with a different user id
    const tamperedPayload = btoa(JSON.stringify({ sub: 'attacker', email: 'evil@example.com', iat: 0, exp: 9999999999 }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const tampered = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

    const result = await verifySession(env, tampered);
    expect(result).toBeNull();
  });

  it('returns null for a token signed with a different secret', async () => {
    const token = await createSession(makeEnv('secret-A-at-least-32-chars-aaaa!'), 'user-1', 'a@b.com');
    const result = await verifySession(makeEnv('secret-B-at-least-32-chars-bbbb!'), token);
    expect(result).toBeNull();
  });

  it('returns null for an expired token', async () => {
    const env = makeEnv();
    const token = await createSession(env, 'user-123', 'test@example.com');

    // Decode, backdate the timestamps, re-sign with the real secret
    const parts = token.split('.');
    const payload = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
    ));
    payload.iat = 1000;
    payload.exp = 1001; // expired long ago

    const newBody = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const sigInput = `${parts[0]}.${newBody}`;
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(env.SESSION_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign({ name: 'HMAC', hash: 'SHA-256' }, key, new TextEncoder().encode(sigInput).buffer as ArrayBuffer);
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    const expiredToken = `${sigInput}.${sigB64}`;
    const result = await verifySession(env, expiredToken);
    expect(result).toBeNull();
  });

  it('returns null for malformed token strings', async () => {
    const env = makeEnv();
    expect(await verifySession(env, '')).toBeNull();
    expect(await verifySession(env, 'not.a.valid.jwt.parts')).toBeNull();
    expect(await verifySession(env, 'only.two')).toBeNull();
    expect(await verifySession(env, 'garbage')).toBeNull();
  });
});

describe('getSessionToken', () => {
  it('extracts the token from a Cookie header', () => {
    const req = new Request('https://example.com', {
      headers: { Cookie: 'notes_session=my.token.here' },
    });
    expect(getSessionToken(req)).toBe('my.token.here');
  });

  it('extracts the token when multiple cookies are present', () => {
    const req = new Request('https://example.com', {
      headers: { Cookie: 'other=abc; notes_session=my.token.here; another=xyz' },
    });
    expect(getSessionToken(req)).toBe('my.token.here');
  });

  it('returns null when the cookie is absent', () => {
    const req = new Request('https://example.com');
    expect(getSessionToken(req)).toBeNull();
  });

  it('returns null when a different cookie is present', () => {
    const req = new Request('https://example.com', {
      headers: { Cookie: 'some_other=value' },
    });
    expect(getSessionToken(req)).toBeNull();
  });
});
