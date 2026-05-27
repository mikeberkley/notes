import { insertRawSource, getConfig } from '../db/queries.js';

export interface WorkflowyNode {
  id: string;
  name: string;
  note: string | null;
  parent_id: string | null;
  priority: number;
  createdAt: number; // Unix seconds
  modifiedAt: number;
  completedAt: number | null;
}

export type EntryGroup = {
  entryNode: WorkflowyNode;
  dateNode: WorkflowyNode;
  recentInGroup: WorkflowyNode[];
};

export function buildChildMap(nodes: WorkflowyNode[]): Map<string | null, WorkflowyNode[]> {
  const map = new Map<string | null, WorkflowyNode[]>();
  for (const node of nodes) {
    const siblings = map.get(node.parent_id) ?? [];
    siblings.push(node);
    map.set(node.parent_id, siblings);
  }
  for (const siblings of map.values()) {
    siblings.sort((a, b) => a.priority - b.priority);
  }
  return map;
}

export function findRoot(nodeId: string, nodeById: Map<string, WorkflowyNode>): WorkflowyNode {
  let node = nodeById.get(nodeId)!;
  while (node.parent_id && nodeById.has(node.parent_id)) {
    node = nodeById.get(node.parent_id)!;
  }
  return node;
}

export function buildRelevantIds(
  recentNodes: WorkflowyNode[],
  nodeById: Map<string, WorkflowyNode>,
): Set<string> {
  const relevant = new Set<string>();
  for (const node of recentNodes) {
    let current: WorkflowyNode | undefined = node;
    while (current) {
      relevant.add(current.id);
      current = current.parent_id ? nodeById.get(current.parent_id) : undefined;
    }
  }
  return relevant;
}

export function serializeSubtree(
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

// Returns [id, text] pairs for every node in the subtree (for deep-link URL resolution at search time)
export function buildNodeIndex(
  nodeId: string,
  childMap: Map<string | null, WorkflowyNode[]>,
  nodeById: Map<string, WorkflowyNode>,
  relevantIds: Set<string>,
): Array<[string, string]> {
  const node = nodeById.get(nodeId);
  if (!node || !node.name.trim() || !relevantIds.has(nodeId)) return [];
  const result: Array<[string, string]> = [[node.id, node.name.trim()]];
  if (node.note?.trim()) result.push([node.id, node.note.trim()]);
  for (const child of childMap.get(nodeId) ?? []) {
    result.push(...buildNodeIndex(child.id, childMap, nodeById, relevantIds));
  }
  return result;
}

export function isDateNode(node: WorkflowyNode): boolean {
  return node.name.trimStart().startsWith('<time ');
}

export function extractDateLabel(name: string): string {
  const match = name.match(/>([^<]+)<\/time>/);
  return match ? match[1].trim() : name.replace(/<[^>]+>/g, '').trim();
}

export function stripHtml(text: string): string {
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/**
 * Walk up from a node to find the first date-node ancestor.
 * Returns { dateNode, entryNode } where entryNode is the direct child
 * of the date node on the path from the original node to root.
 */
export function findDateAncestorEntry(
  node: WorkflowyNode,
  nodeById: Map<string, WorkflowyNode>,
): { dateNode: WorkflowyNode; entryNode: WorkflowyNode } | null {
  let current: WorkflowyNode | undefined = node;
  while (current) {
    const parent = current.parent_id ? nodeById.get(current.parent_id) : undefined;
    if (!parent) break;
    if (isDateNode(parent)) {
      return { dateNode: parent, entryNode: current };
    }
    current = parent;
  }
  return null;
}

/**
 * Build a human-readable ancestor path from root down to (but not including) the date node.
 * e.g. "Consulting > GotPhoto > GotPhoto 2026 Engagement > Meetings"
 */
export function buildAncestorPath(dateNodeId: string, nodeById: Map<string, WorkflowyNode>): string {
  const dateNode = nodeById.get(dateNodeId);
  if (!dateNode?.parent_id) return '';
  const parts: string[] = [];
  let current: WorkflowyNode | undefined = nodeById.get(dateNode.parent_id);
  while (current) {
    parts.unshift(stripHtml(current.name.trim()));
    current = current.parent_id ? nodeById.get(current.parent_id) : undefined;
  }
  return parts.join(' > ');
}

/**
 * Group recent nodes into entry groups (one source per direct child of a date node)
 * and a fallback list for nodes that have no date-node ancestor.
 */
export function groupRecentNodesByEntry(
  recentNodes: WorkflowyNode[],
  nodeById: Map<string, WorkflowyNode>,
): { entryGroups: Map<string, EntryGroup>; fallbackRecentNodes: WorkflowyNode[] } {
  const entryGroups = new Map<string, EntryGroup>();
  const fallbackRecentNodes: WorkflowyNode[] = [];

  for (const node of recentNodes) {
    const found = findDateAncestorEntry(node, nodeById);
    if (found) {
      const existing = entryGroups.get(found.entryNode.id);
      if (existing) {
        existing.recentInGroup.push(node);
      } else {
        entryGroups.set(found.entryNode.id, {
          entryNode: found.entryNode,
          dateNode: found.dateNode,
          recentInGroup: [node],
        });
      }
    } else {
      fallbackRecentNodes.push(node);
    }
  }

  return { entryGroups, fallbackRecentNodes };
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

  const { entryGroups, fallbackRecentNodes } = groupRecentNodesByEntry(recentNodes, nodeById);

  console.log(`[workflowy] ${recentNodes.length} recent node(s): ${entryGroups.size} entry source(s), ${fallbackRecentNodes.length} fallback node(s)`);

  // Emit one raw_source per entry node
  for (const { entryNode, dateNode, recentInGroup } of entryGroups.values()) {
    try {
      // Include the entry node itself plus all ancestors of recent nodes up to the entry node
      const relevantIds = new Set<string>([entryNode.id]);
      for (const node of recentInGroup) {
        let current: WorkflowyNode | undefined = node;
        while (current && current.id !== entryNode.id) {
          relevantIds.add(current.id);
          current = current.parent_id ? nodeById.get(current.parent_id) : undefined;
        }
      }

      const content = serializeSubtree(entryNode.id, childMap, nodeById, relevantIds);
      if (!content.trim()) continue;

      const ancestorPath = buildAncestorPath(dateNode.id, nodeById);
      const dateLabel = extractDateLabel(dateNode.name);
      const sectionName = stripHtml(entryNode.name.trim());

      // Prefix with path context so the LLM knows where in the outline this came from
      const fullContent = `Path: ${ancestorPath} > ${dateLabel}\n\n${content}`;

      const root = findRoot(entryNode.id, nodeById);
      const metadata = {
        root_node_id: root.id,
        root_name: root.name,
        section_node_id: entryNode.id,
        section_name: sectionName,
        date_label: dateLabel,
        ancestor_path: ancestorPath,
        recent_node_count: recentInGroup.length,
        node_index: buildNodeIndex(entryNode.id, childMap, nodeById, relevantIds),
      };

      await insertRawSource(db, userId, 'workflowy', `${entryNode.id}::${date}`, fullContent, metadata, date);
    } catch (err) {
      console.error(`[workflowy] Entry ${entryNode.id} error:`, err);
    }
  }

  // Fallback: nodes without a date-node ancestor — group by root (original behavior)
  if (fallbackRecentNodes.length > 0) {
    const rootIds = new Set(fallbackRecentNodes.map(n => findRoot(n.id, nodeById).id));
    const relevantIds = buildRelevantIds(fallbackRecentNodes, nodeById);

    for (const rootId of rootIds) {
      try {
        const root = nodeById.get(rootId)!;
        const content = serializeSubtree(rootId, childMap, nodeById, relevantIds);
        if (!content.trim()) continue;

        const metadata = {
          root_node_id: rootId,
          root_name: root.name,
          recent_node_count: fallbackRecentNodes.filter(n => findRoot(n.id, nodeById).id === rootId).length,
          node_index: buildNodeIndex(rootId, childMap, nodeById, relevantIds),
        };

        await insertRawSource(db, userId, 'workflowy', `${rootId}::${date}`, content, metadata, date);
      } catch (err) {
        console.error(`[workflowy] Root ${rootId} error:`, err);
      }
    }
  }
}
