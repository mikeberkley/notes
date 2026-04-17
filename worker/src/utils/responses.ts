const CORS_HEADERS = {
  'Access-Control-Allow-Origin': 'https://notes.lost2038.com',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Credentials': 'true',
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

export function notFound(): Response {
  return json({ error: 'Not found' }, 404);
}

export function unauthorized(message = 'Unauthorized'): Response {
  return json({ error: message }, 401);
}

export function forbidden(): Response {
  return json({ error: 'Forbidden' }, 403);
}

export function cors(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
