import { insertRawSource, getConfig } from '../db/queries.js';

interface WorkflowyNode {
  id: string;
  name: string;
  note: string | null;
  createdAt: number; // Unix timestamp (seconds)
  modifiedAt: number;
  completedAt: number | null;
}

export async function ingestWorkflowy(
  db: D1Database,
  userId: string,
  date: string, // YYYY-MM-DD
): Promise<void> {
  const apiKey = await getConfig(db, userId, 'workflowy_api_key');
  if (!apiKey) return;

  const resp = await fetch('https://workflowy.com/api/v1/nodes-export', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!resp.ok) {
    console.error(`[workflowy] Export failed: ${resp.status} ${await resp.text()}`);
    return;
  }

  const data = await resp.json<{ nodes: WorkflowyNode[] }>();
  const nodes = data.nodes ?? [];

  const cutoff = Date.now() / 1000 - 24 * 60 * 60;
  const recent = nodes.filter(n => n.createdAt >= cutoff && n.name?.trim());

  console.log(`[workflowy] ${recent.length} node(s) created in the last 24 hours`);

  for (const node of recent) {
    try {
      const content = node.note?.trim()
        ? `${node.name}\n\n${node.note}`
        : node.name;

      const metadata = {
        node_id: node.id,
        created_at: node.createdAt,
        modified_at: node.modifiedAt,
      };

      await insertRawSource(db, userId, 'workflowy', node.id, content, metadata, date);
    } catch (err) {
      console.error(`[workflowy] Node ${node.id} error:`, err);
    }
  }
}
