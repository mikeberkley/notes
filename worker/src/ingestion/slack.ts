import { insertRawSource, getConfig } from '../db/queries.js';

interface SlackMessage {
  type: string;
  user: string;
  text: string;
  ts: string;
  thread_ts?: string;
}

interface SlackUser {
  real_name?: string;
  name: string;
}

async function slackGet<T>(
  method: string,
  params: Record<string, string>,
  token: string,
): Promise<T> {
  const url = `https://slack.com/api/${method}?${new URLSearchParams(params)}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`Slack HTTP ${resp.status}`);
  const data = await resp.json<{ ok: boolean; error?: string } & T>();
  if (!data.ok) throw new Error(`Slack error: ${data.error}`);
  return data;
}

async function resolveUserName(
  slackUserId: string,
  token: string,
  cache: Map<string, string>,
): Promise<string> {
  if (cache.has(slackUserId)) return cache.get(slackUserId)!;
  try {
    const data = await slackGet<{ user: SlackUser }>('users.info', { user: slackUserId }, token);
    const name = data.user.real_name ?? data.user.name ?? slackUserId;
    cache.set(slackUserId, name);
    return name;
  } catch {
    cache.set(slackUserId, slackUserId);
    return slackUserId;
  }
}

function formatTime(ts: string): string {
  return new Date(parseFloat(ts) * 1000).toLocaleTimeString('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: 'UTC', hour12: true,
  });
}

async function ingestDMs(
  db: D1Database,
  userId: string,
  token: string,
  ownSlackId: string,
  ownName: string,
  date: string,
  dayStart: number,
  dayEnd: number,
  userNameCache: Map<string, string>,
): Promise<void> {
  // Collect all IM channels
  const dmChannels: Array<{ id: string; user: string }> = [];
  let cursor: string | undefined;

  do {
    const params: Record<string, string> = { types: 'im', limit: '200' };
    if (cursor) params.cursor = cursor;
    const data = await slackGet<{
      channels: Array<{ id: string; user: string }>;
      response_metadata?: { next_cursor?: string };
    }>('conversations.list', params, token).catch(err => {
      console.error('[slack] conversations.list error:', err);
      return null;
    });
    if (!data) break;
    dmChannels.push(...data.channels);
    cursor = data.response_metadata?.next_cursor || undefined;
  } while (cursor);

  for (const dm of dmChannels) {
    if (dm.user === 'USLACKBOT') continue;

    try {
      const histData = await slackGet<{ messages: SlackMessage[] }>(
        'conversations.history',
        { channel: dm.id, oldest: String(dayStart), latest: String(dayEnd), inclusive: 'true', limit: '200' },
        token,
      );

      const messages = histData.messages.filter(m => m.type === 'message');
      if (messages.length === 0) continue;

      const otherName = await resolveUserName(dm.user, token, userNameCache);
      const lines = messages
        .slice()
        .reverse() // oldest first
        .map(m => {
          const speaker = m.user === ownSlackId ? ownName : otherName;
          return `[${formatTime(m.ts)}] ${speaker}: ${m.text}`;
        });

      const content = lines.join('\n');
      const metadata = { type: 'dm', with_user: otherName, message_count: messages.length };
      await insertRawSource(db, userId, 'slack', `dm::${dm.id}::${date}`, content, metadata, date);
    } catch (err) {
      console.error(`[slack] DM channel ${dm.id} error:`, err);
    }
  }
}

async function ingestChannelPosts(
  db: D1Database,
  userId: string,
  token: string,
  ownName: string,
  date: string,
): Promise<void> {
  type SearchMatch = {
    ts: string;
    text: string;
    thread_ts?: string;
    channel: { id: string; name: string };
  };

  // Collect all my posts on this date across all channels
  const messagesByChannel = new Map<string, Array<SearchMatch>>();
  let page = 1;

  while (true) {
    const data = await slackGet<{
      messages: {
        matches: SearchMatch[];
        paging: { pages: number; page: number };
      };
    }>('search.messages', { query: `from:me on:${date}`, count: '100', page: String(page) }, token).catch(err => {
      console.error('[slack] search.messages error:', err);
      return null;
    });

    if (!data) break;

    for (const match of data.messages.matches) {
      const id = match.channel.id;
      if (!messagesByChannel.has(id)) messagesByChannel.set(id, []);
      messagesByChannel.get(id)!.push(match);
    }

    if (page >= data.messages.paging.pages) break;
    page++;
  }

  for (const [channelId, msgs] of messagesByChannel) {
    try {
      const channelName = msgs[0].channel.name;
      const sorted = msgs.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
      const lines = sorted.map(m => {
        const isReply = m.thread_ts && m.thread_ts !== m.ts;
        return `[${formatTime(m.ts)}] ${ownName}${isReply ? ' (thread reply)' : ''}: ${m.text}`;
      });

      const content = lines.join('\n');
      const metadata = { type: 'channel', channel_name: `#${channelName}`, message_count: msgs.length };
      await insertRawSource(db, userId, 'slack', `channel::${channelId}::${date}`, content, metadata, date);
    } catch (err) {
      console.error(`[slack] Channel ${channelId} error:`, err);
    }
  }
}

export async function ingestSlack(
  db: D1Database,
  userId: string,
  date: string,
): Promise<void> {
  const token = await getConfig(db, userId, 'slack_token');
  if (!token) return;

  let ownSlackId: string;
  try {
    const auth = await slackGet<{ user_id: string }>('auth.test', {}, token);
    ownSlackId = auth.user_id;
  } catch (err) {
    console.error('[slack] auth.test failed:', err);
    return;
  }

  const userNameCache = new Map<string, string>();
  const ownName = await resolveUserName(ownSlackId, token, userNameCache);

  const dayStart = new Date(`${date}T00:00:00Z`).getTime() / 1000;
  const dayEnd = new Date(`${date}T23:59:59Z`).getTime() / 1000;

  await ingestDMs(db, userId, token, ownSlackId, ownName, date, dayStart, dayEnd, userNameCache);
  await ingestChannelPosts(db, userId, token, ownName, date);

  console.log(`[slack] Ingestion complete for ${date}`);
}
