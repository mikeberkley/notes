import { insertRawSource } from '../db/queries.js';

interface GmailMessage {
  id: string;
  threadId: string;
}

interface GmailMessageDetail {
  id: string;
  internalDate: string;
  payload: {
    headers: Array<{ name: string; value: string }>;
    body?: { data?: string };
    parts?: Array<{
      mimeType: string;
      body?: { data?: string };
      parts?: Array<{ mimeType: string; body?: { data?: string } }>;
    }>;
  };
}

function decodeBase64Url(s: string): string {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - s.length % 4) % 4);
  try {
    return decodeURIComponent(escape(atob(padded)));
  } catch {
    return atob(padded);
  }
}

function extractText(payload: GmailMessageDetail['payload']): string {
  // Prefer text/plain
  if (payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }

  const findPart = (parts: typeof payload.parts): string => {
    if (!parts) return '';
    for (const part of parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return decodeBase64Url(part.body.data);
      }
    }
    for (const part of parts) {
      if (part.parts) {
        const found = findPart(part.parts);
        if (found) return found;
      }
    }
    // Fallback to text/html, strip tags
    for (const part of parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        return decodeBase64Url(part.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }
    return '';
  };

  return findPart(payload.parts);
}

export async function ingestGmail(
  db: D1Database,
  accessToken: string,
  userId: string,
  date: string, // YYYY-MM-DD
): Promise<void> {
  // Rolling 24-hour window ending now
  const endMs = Date.now();
  const startMs = endMs - 24 * 60 * 60 * 1000;
  const query = `after:${Math.floor(startMs / 1000)} before:${Math.floor(endMs / 1000)}`;

  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=50`;
  const listResp = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!listResp.ok) {
    console.error('Gmail list error:', await listResp.text());
    return;
  }

  const listData = await listResp.json<{ messages?: GmailMessage[] }>();
  const messages = listData.messages ?? [];

  for (const msg of messages) {
    try {
      const detailResp = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (!detailResp.ok) continue;

      const detail = await detailResp.json<GmailMessageDetail>();
      const headers = detail.payload.headers;
      const get = (name: string) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

      const subject = get('Subject') || '(no subject)';
      const sender = get('From');
      const recipient = get('To');
      const dateHeader = get('Date');

      const content = extractText(detail.payload);
      if (!content.trim()) continue;

      const metadata = { subject, sender, recipient, date: dateHeader };
      await insertRawSource(db, userId, 'gmail', msg.id, content, metadata, date);
    } catch (err) {
      console.error(`Gmail message ${msg.id} error:`, err);
    }
  }
}
