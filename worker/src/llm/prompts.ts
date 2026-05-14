export const SYSTEM_PROMPT = `You are a memory assistant. Your job is to read a person's daily notes, emails, and documents and distill them into a structured memory object.
Respond ONLY with a single valid JSON object. No markdown, no explanation, no extra text — just the JSON.`;

export function buildSourceSummaryPrompt(
  sourceType: 'gmail' | 'gdrive' | 'workflowy' | 'slack' | 'chat',
  metadata: string,
  content: string,
): string {
  const meta = JSON.parse(metadata);

  let label: string;
  let contentLabel: string;
  let extraInstructions = '';

  if (sourceType === 'gmail') {
    label = `EMAIL — Subject: ${meta.subject ?? '(no subject)'} | From: ${meta.sender ?? 'unknown'}`;
    contentLabel = 'email';
  } else if (sourceType === 'workflowy') {
    label = `WORKFLOWY NOTES — Section: ${meta.root_name ?? 'unknown'}`;
    contentLabel = 'Workflowy notes (hierarchical bullet list)';
    extraInstructions = `
- This is a hierarchical outline. Treat each bullet as a discrete item.
- Capture VERBATIM names of initiatives, projects, strategies, and action items as keywords (e.g. "Accelerate internal development", "ICP refinement").
- Do not paraphrase named items — copy them exactly as they appear.`;
  } else if (sourceType === 'chat') {
    label = `INTELLIGENCE CHAT — ${meta.title ?? 'Q&A session'}`;
    contentLabel = 'saved intelligence chat session (Q&A conversation between the user and an AI assistant about their notes)';
    extraInstructions = `
- Each "Q:" line is a question from the user; each "A:" line is the AI assistant's response
- key_decisions should capture conclusions or decisions the user reached during or after the conversation
- keywords should include the main topics and named items discussed
- open_questions should capture questions raised in the conversation that were not fully resolved`;
  } else if (sourceType === 'slack' && meta.type === 'dm') {
    label = `SLACK DM — Conversation with ${meta.with_user ?? 'unknown'} (${meta.message_count ?? 0} messages)`;
    contentLabel = 'Slack DM conversation';
  } else if (sourceType === 'slack' && meta.type === 'channel') {
    label = `SLACK CHANNEL — My posts in ${meta.channel_name ?? 'unknown'} (${meta.message_count ?? 0} messages)`;
    contentLabel = 'Slack channel messages';
  } else {
    const folderPath: string = meta.folder_path ?? '';
    const segments = folderPath.split('/').map(s => s.toLowerCase());
    const isMeetingNotes = segments.some(s => s === 'meeting notes');

    if (isMeetingNotes) {
      label = `MEETING NOTES — ${meta.filename ?? 'unknown'}`;
      contentLabel = 'meeting notes document';
    } else {
      label = `DRIVE FILE — ${meta.filename ?? 'unknown'}`;
      contentLabel = 'document';
      extraInstructions = `
- This document is not a meeting record. Set key_decisions to [] and open_questions to null.`;
    }
  }

  // Truncate extremely long content to avoid context overflow (~80k chars ≈ ~20k tokens)
  const truncated = content.length > 80000
    ? content.slice(0, 80000) + '\n\n[truncated]'
    : content;

  return `Summarize the following ${contentLabel}.

SOURCE: ${label}

CONTENT:
${truncated}

Respond ONLY with a JSON object matching this exact schema:
{
  "summary": "string — 2 to 4 sentences capturing what this document/email is about",
  "key_decisions": ["string"],    // specific decisions made or agreed upon; empty array if none
  "key_entities": ["string"],     // people, organizations, projects, named initiatives, and places mentioned
  "keywords": ["string"],         // 5 to 15 keywords: include specific topic words AND verbatim names of initiatives, strategies, projects, and action items
  "open_questions": ["string"] | null  // list of unresolved items or action items; null if none
}

Rules:
- key_decisions must be concrete, finalized decisions that were explicitly agreed upon — exclude hypotheses, working assumptions, options being considered, or items still under debate
- key_entities should include proper nouns AND named projects, initiatives, and strategies (e.g. "ICP refinement", "monolith decoupling")
- keywords must include VERBATIM multi-word phrases for named items — do not paraphrase or generalize them
- keywords should be specific, not generic words like "email" or "document"
- open_questions is an array of short strings, one per unresolved item or action item (does not need to be phrased as a question); null if none${extraInstructions}`;
}

export function buildLayer1Prompt(date: string, sources: Array<{
  type: string;
  metadata: string;
  // Summarized fields (preferred)
  summary: string | null;
  key_decisions: string | null;
  key_entities: string | null;
  keywords: string | null;
  open_questions: string | null;
  // Raw content fallback
  content: string;
}>): string {
  const sourceMaterial = sources.map(s => {
    const meta = JSON.parse(s.metadata);
    let label: string;
    if (s.type === 'gmail') {
      label = `[EMAIL] Subject: ${meta.subject} | From: ${meta.sender}`;
    } else if (s.type === 'chat') {
      label = `[CHAT] ${meta.title ?? 'Intelligence session'}`;
    } else if (s.type === 'gcalendar') {
      label = `[CALENDAR] ${meta.title}${meta.location ? ` | Location: ${meta.location}` : ''}`;
    } else if (s.type === 'slack' && meta.type === 'dm') {
      label = `[SLACK DM] With: ${meta.with_user}`;
    } else if (s.type === 'slack' && meta.type === 'channel') {
      label = `[SLACK] My posts in ${meta.channel_name}`;
    } else {
      label = `[DRIVE] File: ${meta.filename}`;
    }

    if (s.summary) {
      // Use structured mini-summary
      const decisions = s.key_decisions ? (JSON.parse(s.key_decisions) as string[]) : [];
      const entities = s.key_entities ? (JSON.parse(s.key_entities) as string[]) : [];
      const kws = s.keywords ? (JSON.parse(s.keywords) as string[]) : [];
      const lines = [
        label,
        `Summary: ${s.summary}`,
      ];
      if (decisions.length) lines.push(`Key Decisions: ${decisions.join('; ')}`);
      if (entities.length) lines.push(`Key Entities: ${entities.join(', ')}`);
      if (kws.length) lines.push(`Keywords: ${kws.join(', ')}`);
      if (s.open_questions) lines.push(`Open Questions: ${s.open_questions}`);
      return lines.join('\n');
    }

    // Fallback: raw content truncated to 4000 chars
    const truncated = s.content.length > 4000 ? s.content.slice(0, 4000) + ' [truncated]' : s.content;
    return `${label}\n${truncated}`;
  }).join('\n\n---\n\n');

  return `Today's date: ${date}

SOURCE MATERIAL:
${sourceMaterial}

Generate a structured memory object conforming EXACTLY to this JSON schema:
{
  "headline": "string — one sentence capturing the most important thing about this day",
  "summary": "string — one paragraph (3-6 sentences) summarizing the day's key content",
  "themes": [
    {
      "headline": "string — theme title",
      "summary": "string — EXACTLY 2 sentences describing this theme"
    }
  ],
  "keywords": ["string"],
  "key_entities": ["string"],
  "key_decisions": ["string"],
  "open_questions": ["string"] | null,
  "location": "string | null"
}

Rules:
- themes array must have between 1 and 5 items
- Each theme summary must be exactly 2 sentences
- keywords and key_entities must be arrays of strings (5–15 keywords)
- key_decisions must contain ONLY concrete, finalized decisions that were explicitly agreed upon — not hypotheses, working assumptions, options under consideration, or things still being debated; empty array if none; maximum 7 items, prioritizing the most consequential
- open_questions must be limited to the most important unresolved items — maximum 8 items; omit routine action items and to-dos in favor of genuinely open strategic or substantive questions; null if none
- location must be "City, Country" (e.g. "New York, USA") inferred from calendar event locations, or null if not determinable
- Do not include date_range fields
- If there is no meaningful content, generate a valid object with headline "No notable activity" and an empty themes array`;
}

export function buildIntelligenceSystemPrompt(
  userSystemPrompt: string | null,
  alwaysContext: string | null,
): string {
  let prompt = userSystemPrompt?.trim() ||
    'You are a personal intelligence assistant with access to the user\'s notes, emails, and documents. Answer questions thoughtfully and cite specific sources and dates when relevant.';
  if (alwaysContext?.trim()) {
    prompt += `\n\nADDITIONAL CONTEXT (always loaded):\n${alwaysContext.trim()}`;
  }
  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/New_York' });
  prompt += `\n\nToday's date is ${today}. Memories are presented oldest to newest — when facts conflict or recency is relevant, prefer the more recent memory.`;
  return prompt;
}

const CHAR_BUDGET = 400_000; // ~100k tokens; well within claude-sonnet-4-6's 200k window

export function buildIntelligenceContextBlock(
  smos: Array<{
    id: string;
    layer: number;
    headline: string;
    summary: string;
    keywords: string;
    key_entities: string;
    key_decisions: string | null;
    open_questions: string | null;
    date_range_start: string;
    date_range_end: string;
  }>,
  themesMap: Map<string, Array<{ headline: string; summary: string }>>,
  sourcesMap: Map<string, Array<{ id: string; source_type: string; metadata: string; summary: string | null; key_decisions: string | null; key_entities: string | null; keywords: string | null }>>,
  rawContentMap: Map<string, Array<{ source_id: string; source_type: string; content: string; metadata: string }>> = new Map(),
): { block: string; smoCount: number; sourceCount: number; charCount: number } {
  const LAYER_LABEL: Record<number, string> = { 1: 'DAILY', 2: 'WEEKLY', 3: 'MONTHLY' };

  let block = '';
  let charCount = 0;
  let smoCount = 0;
  let sourceCount = 0;

  // SMOs arrive sorted: Layer 3 first, then 2, then 1; within each layer, newest-first so that
  // if the char budget is exhausted, the oldest (least relevant) entries are dropped, not recent ones.
  for (const smo of smos) {
    const dateLabel = smo.date_range_start === smo.date_range_end
      ? smo.date_range_start
      : `${smo.date_range_start} – ${smo.date_range_end}`;

    const lines: string[] = [
      `=== ${LAYER_LABEL[smo.layer] ?? `LAYER ${smo.layer}`} MEMORY: ${dateLabel} ===`,
      `Headline: ${smo.headline}`,
      `Summary: ${smo.summary}`,
    ];

    const themes = themesMap.get(smo.id) ?? [];
    if (themes.length > 0) {
      lines.push(`Themes: ${themes.map(t => t.headline).join(' | ')}`);
    }

    const decisions = smo.key_decisions ? (JSON.parse(smo.key_decisions) as string[]) : [];
    if (decisions.length > 0) {
      lines.push(`Key Decisions: ${decisions.map(d => `• ${d}`).join(' ')}`);
    }

    if (smo.open_questions) {
      const qs = smo.open_questions.split('\n').filter(Boolean);
      if (qs.length > 0) lines.push(`Open Questions: ${qs.map(q => `• ${q}`).join(' ')}`);
    }

    const keywords = JSON.parse(smo.keywords) as string[];
    if (keywords.length > 0) lines.push(`Keywords: ${keywords.join(', ')}`);

    // Include source summaries for Layer 1 only (higher layers already synthesize them)
    if (smo.layer === 1) {
      const sources = sourcesMap.get(smo.id) ?? [];
      const rawSources = rawContentMap.get(smo.id) ?? [];
      const rawBySourceId = new Map(rawSources.map(r => [r.source_id, r.content]));

      for (const src of sources) {
        const meta = JSON.parse(src.metadata) as Record<string, unknown>;
        let srcLabel: string;
        if (src.source_type === 'gmail') srcLabel = `Gmail: ${String(meta.subject ?? '(no subject)')}`;
        else if (src.source_type === 'workflowy') srcLabel = `Workflowy: ${String(meta.root_name ?? 'Note')}`;
        else if (src.source_type === 'slack') {
          srcLabel = meta.type === 'dm'
            ? `Slack DM: ${String(meta.with_user ?? 'Unknown')}`
            : `Slack: #${String(meta.channel_name ?? 'channel')}`;
        }
        else srcLabel = `Drive: ${String(meta.filename ?? 'Untitled')}`;

        const srcParts: string[] = [`  [${srcLabel}]`];
        if (src.summary) srcParts.push(src.summary);
        if (src.key_decisions) {
          const kd = JSON.parse(src.key_decisions) as string[];
          if (kd.length) srcParts.push(`Decisions: ${kd.join('; ')}`);
        }
        if (src.keywords) {
          const kw = JSON.parse(src.keywords) as string[];
          if (kw.length) srcParts.push(`Keywords: ${kw.join(', ')}`);
        }

        const rawContent = rawBySourceId.get(src.id);
        if (rawContent) {
          lines.push(srcParts.join(' | '));
          lines.push(`  [RAW CONTENT]\n${rawContent}\n  [END RAW CONTENT]`);
        } else {
          lines.push(srcParts.join(' | '));
        }
        sourceCount++;
      }
    }

    const entry = lines.join('\n') + '\n\n';

    if (charCount + entry.length > CHAR_BUDGET) break;
    block += entry;
    charCount += entry.length;
    smoCount++;
  }

  const header = `MEMORY CONTEXT: ${smoCount} memories, ${sourceCount} sources\n\n`;
  return { block: header + block.trim(), smoCount, sourceCount, charCount: header.length + charCount };
}

export function buildRollupPrompt(
  layer: 2 | 3,
  dateStart: string,
  dateEnd: string,
  childSmos: Array<{ headline: string; summary: string; themes: Array<{ headline: string; summary: string }>; keywords: string[]; key_entities: string[]; key_decisions: string[] }>,
): string {
  const layerLabel = layer === 2 ? 'Weekly' : 'Monthly';

  return `${layerLabel} rollup covering ${dateStart} to ${dateEnd}

CHILD MEMORY OBJECTS (JSON):
${JSON.stringify(childSmos, null, 2)}

Generate a single structured memory object using the same schema as the Layer 1 prompt, summarizing the entire period.
Synthesize across all child objects — do not just repeat them.`;
}
