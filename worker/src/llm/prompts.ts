export const SYSTEM_PROMPT = `You are a memory assistant. Your job is to read a person's daily notes, emails, and documents and distill them into a structured memory object.
Respond ONLY with a single valid JSON object. No markdown, no explanation, no extra text — just the JSON.`;

export function buildSourceSummaryPrompt(
  sourceType: 'gmail' | 'gdrive' | 'workflowy' | 'slack',
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
  } else if (sourceType === 'slack' && meta.type === 'dm') {
    label = `SLACK DM — Conversation with ${meta.with_user ?? 'unknown'} (${meta.message_count ?? 0} messages)`;
    contentLabel = 'Slack DM conversation';
  } else if (sourceType === 'slack' && meta.type === 'channel') {
    label = `SLACK CHANNEL — My posts in ${meta.channel_name ?? 'unknown'} (${meta.message_count ?? 0} messages)`;
    contentLabel = 'Slack channel messages';
  } else {
    label = `DRIVE FILE — ${meta.filename ?? 'unknown'}`;
    contentLabel = 'document';
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
  "open_questions": "string | null"  // unresolved questions or action items raised; null if none
}

Rules:
- key_decisions must be concrete decisions, not vague observations
- key_entities should include proper nouns AND named projects, initiatives, and strategies (e.g. "ICP refinement", "monolith decoupling")
- keywords must include VERBATIM multi-word phrases for named items — do not paraphrase or generalize them
- keywords should be specific, not generic words like "email" or "document"
- open_questions is a single string summarizing any unresolved items, or null${extraInstructions}`;
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
  "open_questions": "string | null",
  "location": "string | null"
}

Rules:
- themes array must have between 1 and 5 items
- Each theme summary must be exactly 2 sentences
- keywords and key_entities must be arrays of strings (5–15 keywords)
- open_questions is a single string or null
- location must be "City, Country" (e.g. "New York, USA") inferred from calendar event locations, or null if not determinable
- Do not include date_range fields
- If there is no meaningful content, generate a valid object with headline "No notable activity" and an empty themes array`;
}

export function buildRollupPrompt(
  layer: 2 | 3,
  dateStart: string,
  dateEnd: string,
  childSmos: Array<{ headline: string; summary: string; themes: Array<{ headline: string; summary: string }>; keywords: string[]; key_entities: string[] }>,
): string {
  const layerLabel = layer === 2 ? 'Weekly' : 'Monthly';

  return `${layerLabel} rollup covering ${dateStart} to ${dateEnd}

CHILD MEMORY OBJECTS (JSON):
${JSON.stringify(childSmos, null, 2)}

Generate a single structured memory object using the same schema as the Layer 1 prompt, summarizing the entire period.
Synthesize across all child objects — do not just repeat them.`;
}
