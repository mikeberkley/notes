import { describe, it, expect } from 'vitest';
import { parseLLMResponse, parseSourceSummaryResponse } from './smo.js';

// ─── parseLLMResponse ─────────────────────────────────────────────────────────

describe('parseLLMResponse', () => {
  const validResponse = {
    headline: 'Productive day of engineering work',
    summary: 'Spent the day building out the search API.',
    themes: [
      { headline: 'Search implementation', summary: 'Worked on FTS5 queries.' },
      { headline: 'Code review', summary: 'Reviewed two PRs.' },
    ],
    keywords: ['search', 'FTS5', 'code review'],
    key_entities: ['Alice', 'GitHub'],
    open_questions: 'Is FTS5 fast enough at scale?',
  };

  it('parses a well-formed JSON response', () => {
    const result = parseLLMResponse(JSON.stringify(validResponse));
    expect(result.headline).toBe(validResponse.headline);
    expect(result.summary).toBe(validResponse.summary);
    expect(result.themes).toHaveLength(2);
    expect(result.keywords).toEqual(validResponse.keywords);
    expect(result.key_entities).toEqual(validResponse.key_entities);
    expect(result.open_questions).toBe(validResponse.open_questions);
  });

  it('strips markdown code fences', () => {
    const fenced = '```json\n' + JSON.stringify(validResponse) + '\n```';
    const result = parseLLMResponse(fenced);
    expect(result.headline).toBe(validResponse.headline);
  });

  it('strips code fences with uppercase JSON', () => {
    const fenced = '```JSON\n' + JSON.stringify(validResponse) + '\n```';
    const result = parseLLMResponse(fenced);
    expect(result.headline).toBe(validResponse.headline);
  });

  it('auto-fills missing arrays with empty arrays', () => {
    const minimal = { headline: 'A headline', summary: 'A summary' };
    const result = parseLLMResponse(JSON.stringify(minimal));
    expect(result.themes).toEqual([]);
    expect(result.keywords).toEqual([]);
    expect(result.key_entities).toEqual([]);
  });

  it('clamps themes to 5 max', () => {
    const manyThemes = {
      ...validResponse,
      themes: Array.from({ length: 8 }, (_, i) => ({ headline: `Theme ${i}`, summary: `Summary ${i}` })),
    };
    const result = parseLLMResponse(JSON.stringify(manyThemes));
    expect(result.themes).toHaveLength(5);
  });

  it('preserves exactly 5 themes when there are 5', () => {
    const fiveThemes = {
      ...validResponse,
      themes: Array.from({ length: 5 }, (_, i) => ({ headline: `Theme ${i}`, summary: `Summary ${i}` })),
    };
    const result = parseLLMResponse(JSON.stringify(fiveThemes));
    expect(result.themes).toHaveLength(5);
  });

  it('throws on missing headline', () => {
    const bad = { summary: 'A summary', themes: [], keywords: [], key_entities: [] };
    expect(() => parseLLMResponse(JSON.stringify(bad))).toThrow('Missing required fields');
  });

  it('throws on missing summary', () => {
    const bad = { headline: 'A headline', themes: [], keywords: [], key_entities: [] };
    expect(() => parseLLMResponse(JSON.stringify(bad))).toThrow('Missing required fields');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseLLMResponse('not json at all')).toThrow();
  });

  it('accepts null open_questions', () => {
    const withNull = { ...validResponse, open_questions: null };
    const result = parseLLMResponse(JSON.stringify(withNull));
    expect(result.open_questions).toBeNull();
  });
});

// ─── parseSourceSummaryResponse ───────────────────────────────────────────────

describe('parseSourceSummaryResponse', () => {
  const validResponse = {
    summary: 'The email discussed the Q2 roadmap.',
    key_decisions: ['Postpone feature X', 'Ship by June 1'],
    key_entities: ['Alice', 'Q2 roadmap'],
    keywords: ['roadmap', 'Q2', 'deadline'],
    open_questions: 'Will the June 1 date hold?',
  };

  it('parses a well-formed JSON response', () => {
    const result = parseSourceSummaryResponse(JSON.stringify(validResponse));
    expect(result.summary).toBe(validResponse.summary);
    expect(result.key_decisions).toEqual(validResponse.key_decisions);
    expect(result.key_entities).toEqual(validResponse.key_entities);
    expect(result.keywords).toEqual(validResponse.keywords);
    expect(result.open_questions).toBe(validResponse.open_questions);
  });

  it('strips markdown code fences', () => {
    const fenced = '```json\n' + JSON.stringify(validResponse) + '\n```';
    const result = parseSourceSummaryResponse(fenced);
    expect(result.summary).toBe(validResponse.summary);
  });

  it('auto-fills missing arrays with empty arrays', () => {
    const minimal = { summary: 'Just a summary.' };
    const result = parseSourceSummaryResponse(JSON.stringify(minimal));
    expect(result.key_decisions).toEqual([]);
    expect(result.key_entities).toEqual([]);
    expect(result.keywords).toEqual([]);
  });

  it('throws on missing summary', () => {
    const bad = { key_decisions: [], key_entities: [], keywords: [] };
    expect(() => parseSourceSummaryResponse(JSON.stringify(bad))).toThrow('Missing summary field');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseSourceSummaryResponse('{broken json')).toThrow();
  });

  it('accepts null open_questions', () => {
    const withNull = { ...validResponse, open_questions: null };
    const result = parseSourceSummaryResponse(JSON.stringify(withNull));
    expect(result.open_questions).toBeNull();
  });

  it('handles empty string summary as falsy (throws)', () => {
    const empty = { ...validResponse, summary: '' };
    expect(() => parseSourceSummaryResponse(JSON.stringify(empty))).toThrow('Missing summary field');
  });
});
