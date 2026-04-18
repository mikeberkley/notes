import { insertRawSource, getConfig } from '../db/queries.js';

interface WorkflowyNode {
  id: string;
  name: string;
  note: string | null;
  parent_id: string | null;
  priority: number;
  createdAt: number; // Unix seconds
  modifiedAt: number;
  completedAt: number | null;
}

function buildChildMap(nodes: WorkflowyNode[]): Map<string | null, WorkflowyNode[]> {
  const map = new Map<string | null, WorkflowyNode[]>();
  for (const node of nodes) {
    const siblings = map.get(node.parent_id) ?? [];
    siblings.push(node);
    map.set(node.parent_id, siblings);
  }
  // Sort each sibling list by priority
  for (const siblings of map.values()) {
    siblings.sort((a, b) => a.priority - b.priority);
  }
  return map;
}

function findRoot(nodeId: string, nodeById: Map<string, WorkflowyNode>): WorkflowyNode {
  let node = nodeById.get(nodeId)!;
  while (node.parent_id && nodeById.has(node.parent_id)) {
    node = nodeById.get(node.parent_id)!;
  }
  return node;
}

function buildRelevantIds(
  recentNodes: WorkflowyNode[],
  nodeById: Map<string, WorkflowyNode>,
): Set<string> {
  const relevant = new Set<string>();
  for (const node of recentNodes) {
    // Walk from this node up to root, marking every ancestor as relevant
    let current: WorkflowyNode | undefined = node;
    while (current) {
      relevant.add(current.id);
      current = current.parent_id ? nodeById.get(current.parent_id) : undefined;
    }
  }
  return relevant;
}

function serializeSubtree(
  nodeId: string,
  childMap: Map<string | null, WorkflowyNode[]>,
  nodeById: Map<string, WorkflowyNode>,
  relevantIds: Set<string>,
  indent = 0,
): string {
  const node = nodeById.get(nodeId);
  if (!node || !node.name.trim() || !relevantIds.has(nodeId)) return '';

  const pad = '  '.repeat(indent);
  const lines: string[] = [`${pad}- ${node.name.trim()}`];
  if (node.note?.trim()) {
    lines.push(`${pad}  ${node.note.trim()}`);
  }

  const children = childMap.get(nodeId) ?? [];
  for (const child of children) {
    const sub = serializeSubtree(child.id, childMap, nodeById, relevantIds, indent + 1);
    if (sub) lines.push(sub);
  }

  return lines.join('\n');
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

  const nodeById = new Map(nodes.map(n => [n.id, n]));
  const childMap = buildChildMap(nodes);

  const cutoff = Date.now() / 1000 - 24 * 60 * 60;
  const recentNodes = nodes.filter(n => (n.createdAt >= cutoff || n.modifiedAt >= cutoff) && n.name?.trim());

  // Group recently-created nodes by their root ancestor
  const rootIds = new Set(recentNodes.map(n => findRoot(n.id, nodeById).id));
  console.log(`[workflowy] ${recentNodes.length} recent node(s) across ${rootIds.size} root tree(s)`);

  // Only render nodes that are recent or ancestors of recent nodes
  const relevantIds = buildRelevantIds(recentNodes, nodeById);

  for (const rootId of rootIds) {
    try {
      const root = nodeById.get(rootId)!;
      const content = serializeSubtree(rootId, childMap, nodeById, relevantIds);
      if (!content.trim()) continue;

      const metadata = {
        root_node_id: rootId,
        root_name: root.name,
        recent_node_count: recentNodes.filter(n => findRoot(n.id, nodeById).id === rootId).length,
      };

      // externalId includes date so each day's snapshot is a distinct record
      await insertRawSource(db, userId, 'workflowy', `${rootId}::${date}`, content, metadata, date);
    } catch (err) {
      console.error(`[workflowy] Root ${rootId} error:`, err);
    }
  }
}
