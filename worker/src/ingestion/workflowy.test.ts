import { describe, it, expect } from 'vitest';
import {
  isDateNode,
  extractDateLabel,
  stripHtml,
  findDateAncestorEntry,
  buildAncestorPath,
  buildChildMap,
  serializeSubtree,
  buildRelevantIds,
  groupRecentNodesByEntry,
  type WorkflowyNode,
} from './workflowy.js';

// ─── Test fixture ─────────────────────────────────────────────────────────────
//
// Mirrors the real tree structure observed in the database:
//
//   Consulting (root)
//     GotPhoto
//       GotPhoto 2026 Engagement
//         Meetings
//           <Tue, May 26, 2026>       ← date node
//             Standup                  ← entry node
//               Marc note              ← leaf
//             Flash Pricing Meeting    ← entry node
//               Pricing note           ← leaf
//         GotPhoto Thoughts & Ideas
//           <Thu, May 21, 2026>       ← date node
//             Troika meeting note      ← entry node
//   Personal (second root, no date nodes)
//     Todo item

function node(
  id: string,
  name: string,
  parent_id: string | null = null,
  priority = 0,
): WorkflowyNode {
  return { id, name, note: null, parent_id, priority, createdAt: 0, modifiedAt: 0, completedAt: null };
}

const DATE1 = '<time startYear="2026" startMonth="5" startDay="26">Tue, May 26, 2026</time>';
const DATE2 = '<time startYear="2026" startMonth="5" startDay="21">Thu, May 21, 2026</time>';

const ALL_NODES: WorkflowyNode[] = [
  node('root',     'Consulting'),
  node('gp',       'GotPhoto',                    'root'),
  node('engage',   'GotPhoto 2026 Engagement',    'gp'),
  node('meetings', 'Meetings',                    'engage', 0),
  node('ideas',    'GotPhoto Thoughts &amp; Ideas', 'engage', 1),
  node('date1',    DATE1,                         'meetings'),
  node('standup',  'Standup',                     'date1', 0),
  node('marc',     'Marc note',                   'standup'),
  node('pricing',  'Flash Pricing Meeting',        'date1', 1),
  node('pnote',    'Pricing note',                'pricing'),
  node('date2',    DATE2,                         'ideas'),
  node('troika',   'Troika meeting note',          'date2'),
  node('personal', 'Personal'),
  node('todo',     'Todo item',                   'personal'),
];

const nodeById = new Map(ALL_NODES.map(n => [n.id, n]));
const childMap = buildChildMap(ALL_NODES);

// ─── isDateNode ───────────────────────────────────────────────────────────────

describe('isDateNode', () => {
  it('returns true for Workflowy <time> nodes', () => {
    expect(isDateNode(nodeById.get('date1')!)).toBe(true);
    expect(isDateNode(nodeById.get('date2')!)).toBe(true);
  });

  it('returns false for regular nodes', () => {
    expect(isDateNode(nodeById.get('standup')!)).toBe(false);
    expect(isDateNode(nodeById.get('root')!)).toBe(false);
    expect(isDateNode(nodeById.get('meetings')!)).toBe(false);
  });
});

// ─── extractDateLabel ─────────────────────────────────────────────────────────

describe('extractDateLabel', () => {
  it('extracts the human-readable date from a full <time> tag', () => {
    expect(extractDateLabel(DATE1)).toBe('Tue, May 26, 2026');
    expect(extractDateLabel(DATE2)).toBe('Thu, May 21, 2026');
  });

  it('falls back to stripping tags when the inner text is plain', () => {
    expect(extractDateLabel('<time>2026-05-26</time>')).toBe('2026-05-26');
  });
});

// ─── stripHtml ────────────────────────────────────────────────────────────────

describe('stripHtml', () => {
  it('strips HTML tags', () => {
    expect(stripHtml('<b>bold</b>')).toBe('bold');
    expect(stripHtml('<b><i>nested</i></b>')).toBe('nested');
  });

  it('decodes common HTML entities', () => {
    expect(stripHtml('GotPhoto Thoughts &amp; Ideas')).toBe('GotPhoto Thoughts & Ideas');
    expect(stripHtml('&quot;quoted&quot;')).toBe('"quoted"');
    expect(stripHtml('a &lt; b &gt; c')).toBe('a < b > c');
  });

  it('returns plain text unchanged', () => {
    expect(stripHtml('plain text')).toBe('plain text');
  });

  it('trims surrounding whitespace', () => {
    expect(stripHtml('  hello  ')).toBe('hello');
  });
});

// ─── findDateAncestorEntry ────────────────────────────────────────────────────

describe('findDateAncestorEntry', () => {
  it('finds the entry node for a deep leaf (marc note → standup)', () => {
    const result = findDateAncestorEntry(nodeById.get('marc')!, nodeById);
    expect(result).not.toBeNull();
    expect(result!.entryNode.id).toBe('standup');
    expect(result!.dateNode.id).toBe('date1');
  });

  it('returns the node itself as entry when it is a direct child of a date node', () => {
    const result = findDateAncestorEntry(nodeById.get('standup')!, nodeById);
    expect(result).not.toBeNull();
    expect(result!.entryNode.id).toBe('standup');
    expect(result!.dateNode.id).toBe('date1');
  });

  it('handles a second date section correctly', () => {
    const result = findDateAncestorEntry(nodeById.get('troika')!, nodeById);
    expect(result).not.toBeNull();
    expect(result!.entryNode.id).toBe('troika');
    expect(result!.dateNode.id).toBe('date2');
  });

  it('returns null for the root node', () => {
    expect(findDateAncestorEntry(nodeById.get('root')!, nodeById)).toBeNull();
  });

  it('returns null for a node that has no date-node ancestor', () => {
    expect(findDateAncestorEntry(nodeById.get('meetings')!, nodeById)).toBeNull();
    expect(findDateAncestorEntry(nodeById.get('todo')!, nodeById)).toBeNull();
  });
});

// ─── buildAncestorPath ────────────────────────────────────────────────────────

describe('buildAncestorPath', () => {
  it('builds the full path from root to the date node parent (exclusive)', () => {
    expect(buildAncestorPath('date1', nodeById)).toBe(
      'Consulting > GotPhoto > GotPhoto 2026 Engagement > Meetings',
    );
  });

  it('handles a date node in a different section and decodes HTML entities in path', () => {
    expect(buildAncestorPath('date2', nodeById)).toBe(
      'Consulting > GotPhoto > GotPhoto 2026 Engagement > GotPhoto Thoughts & Ideas',
    );
  });

  it('returns empty string when date node has no parent', () => {
    const orphanDate = node('od', DATE1, null);
    const map = new Map(ALL_NODES.concat(orphanDate).map(n => [n.id, n]));
    expect(buildAncestorPath('od', map)).toBe('');
  });
});

// ─── groupRecentNodesByEntry ──────────────────────────────────────────────────

describe('groupRecentNodesByEntry', () => {
  it('groups leaves under the same entry node into one group', () => {
    // marc and any standup-level node both resolve to entry 'standup'
    const recent = [nodeById.get('marc')!, nodeById.get('standup')!];
    const { entryGroups, fallbackRecentNodes } = groupRecentNodesByEntry(recent, nodeById);
    expect(entryGroups.size).toBe(1);
    expect(entryGroups.get('standup')!.recentInGroup).toHaveLength(2);
    expect(fallbackRecentNodes).toHaveLength(0);
  });

  it('creates separate groups for different entry nodes under the same date', () => {
    const recent = [nodeById.get('marc')!, nodeById.get('pnote')!];
    const { entryGroups } = groupRecentNodesByEntry(recent, nodeById);
    expect(entryGroups.size).toBe(2);
    expect(entryGroups.has('standup')).toBe(true);
    expect(entryGroups.has('pricing')).toBe(true);
  });

  it('creates separate groups for different date nodes', () => {
    const recent = [nodeById.get('marc')!, nodeById.get('troika')!];
    const { entryGroups } = groupRecentNodesByEntry(recent, nodeById);
    expect(entryGroups.size).toBe(2);
    expect(entryGroups.get('standup')!.dateNode.id).toBe('date1');
    expect(entryGroups.get('troika')!.dateNode.id).toBe('date2');
  });

  it('puts nodes without a date-node ancestor into fallback', () => {
    const recent = [nodeById.get('marc')!, nodeById.get('todo')!];
    const { entryGroups, fallbackRecentNodes } = groupRecentNodesByEntry(recent, nodeById);
    expect(entryGroups.size).toBe(1);
    expect(fallbackRecentNodes).toHaveLength(1);
    expect(fallbackRecentNodes[0].id).toBe('todo');
  });

  it('returns all nodes as fallback when none have date ancestors', () => {
    const recent = [nodeById.get('todo')!, nodeById.get('gp')!];
    const { entryGroups, fallbackRecentNodes } = groupRecentNodesByEntry(recent, nodeById);
    expect(entryGroups.size).toBe(0);
    expect(fallbackRecentNodes).toHaveLength(2);
  });

  it('handles an empty recent list', () => {
    const { entryGroups, fallbackRecentNodes } = groupRecentNodesByEntry([], nodeById);
    expect(entryGroups.size).toBe(0);
    expect(fallbackRecentNodes).toHaveLength(0);
  });
});

// ─── serializeSubtree ─────────────────────────────────────────────────────────

describe('serializeSubtree', () => {
  it('serializes an entry node and its relevant descendants', () => {
    const relevantIds = new Set(['standup', 'marc']);
    const output = serializeSubtree('standup', childMap, nodeById, relevantIds);
    expect(output).toBe('- Standup\n  - Marc note');
  });

  it('omits nodes not in relevantIds', () => {
    // Only standup itself is relevant, not its children
    const relevantIds = new Set(['standup']);
    const output = serializeSubtree('standup', childMap, nodeById, relevantIds);
    expect(output).toBe('- Standup');
  });

  it('returns empty string when the root node is not in relevantIds', () => {
    const output = serializeSubtree('standup', childMap, nodeById, new Set());
    expect(output).toBe('');
  });

  it('includes the note field indented under the node name', () => {
    const withNote: WorkflowyNode[] = [node('n1', 'Parent', null), node('n2', 'Child', 'n1')];
    withNote[0].note = 'This is a note';
    const cm = buildChildMap(withNote);
    const nm = new Map(withNote.map(n => [n.id, n]));
    const output = serializeSubtree('n1', cm, nm, new Set(['n1']));
    expect(output).toContain('This is a note');
  });
});

// ─── buildRelevantIds ─────────────────────────────────────────────────────────

describe('buildRelevantIds', () => {
  it('marks the node and all its ancestors as relevant', () => {
    const ids = buildRelevantIds([nodeById.get('marc')!], nodeById);
    expect(ids.has('marc')).toBe(true);
    expect(ids.has('standup')).toBe(true);
    expect(ids.has('date1')).toBe(true);
    expect(ids.has('meetings')).toBe(true);
    expect(ids.has('engage')).toBe(true);
    expect(ids.has('gp')).toBe(true);
    expect(ids.has('root')).toBe(true);
  });

  it('does not mark unrelated nodes', () => {
    const ids = buildRelevantIds([nodeById.get('marc')!], nodeById);
    expect(ids.has('pricing')).toBe(false);
    expect(ids.has('troika')).toBe(false);
  });

  it('merges ancestor paths from multiple nodes', () => {
    const ids = buildRelevantIds([nodeById.get('marc')!, nodeById.get('troika')!], nodeById);
    expect(ids.has('standup')).toBe(true);   // ancestor of marc
    expect(ids.has('troika')).toBe(true);
    expect(ids.has('date2')).toBe(true);      // ancestor of troika
  });
});
