import { insertRawSource, getConfig } from '../db/queries.js';

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

interface ConfluencePage {
  id: string;
  title: string;
  version?: { when?: string };
  _links: { webui: string };
  body?: { storage?: { value: string } };
}

interface SearchResponse {
  results: ConfluencePage[];
  _links?: { next?: string };
}

export async function ingestConfluence(
  db: D1Database,
  userId: string,
  date: string,
): Promise<void> {
  const [email, token, spaceKey, baseUrl] = await Promise.all([
    getConfig(db, userId, 'confluence_email'),
    getConfig(db, userId, 'confluence_api_token'),
    getConfig(db, userId, 'confluence_space_key'),
    getConfig(db, userId, 'confluence_base_url'),
  ]);

  if (!email || !token || !spaceKey || !baseUrl) {
    console.log('[confluence] Not configured, skipping');
    return;
  }

  const auth = btoa(`${email}:${token}`);
  const cql = `space = "${spaceKey}" AND type = page AND lastModified >= "${date}" ORDER BY lastModified DESC`;
  const apiBase = `https://${baseUrl}/wiki/rest/api`;

  let nextUrl: string | null =
    `${apiBase}/content/search?cql=${encodeURIComponent(cql)}&expand=body.storage,version&limit=50`;
  let total = 0;

  while (nextUrl) {
    const resp = await fetch(nextUrl, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });

    if (!resp.ok) {
      console.error(`[confluence] API error ${resp.status}: ${await resp.text()}`);
      break;
    }

    const data = await resp.json<SearchResponse>();

    for (const page of data.results) {
      try {
        const bodyHtml = page.body?.storage?.value ?? '';
        const content = `# ${page.title}\n\n${stripHtml(bodyHtml)}`;
        const pageUrl = `https://${baseUrl}/wiki${page._links.webui}`;
        const modifiedAt = page.version?.when ?? date;
        const externalId = `${page.id}::${modifiedAt}`;

        await insertRawSource(
          db, userId, 'confluence', externalId, content,
          { title: page.title, space_key: spaceKey, page_id: page.id, modified_at: modifiedAt },
          date,
        );
        total++;
      } catch (err) {
        console.error(`[confluence] Page ${page.id} error:`, err);
      }
    }

    nextUrl = data._links?.next ? `https://${baseUrl}/wiki${data._links.next}` : null;
  }

  console.log(`[confluence] Ingested ${total} page(s) for ${date}`);
}
