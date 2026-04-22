import { useState, useEffect, useCallback, useRef } from 'react';
import { api, type SearchResult, type SmoDetail, type SourceSummaryItem, type ChatMessage, type ContextMeta } from '../lib/api.js';

const LAYER_LABELS: Record<number, string> = { 1: 'Day', 2: 'Week', 3: 'Month' };
const LAYER_COLORS: Record<number, string> = {
  1: 'bg-blue-100 text-blue-700',
  2: 'bg-violet-100 text-violet-700',
  3: 'bg-amber-100 text-amber-700',
};

function formatAsMarkdown(result: SearchResult, detail: SmoDetail): string {
  const LAYER = { 1: 'Day', 2: 'Week', 3: 'Month' };
  const dateRange = result.date_range_end !== result.date_range_start
    ? `${result.date_range_start} – ${result.date_range_end}`
    : result.date_range_start;

  const lines: string[] = [
    `# ${detail.headline}`,
    ``,
    `**Layer ${detail.layer} · ${LAYER[detail.layer as 1|2|3]} · ${dateRange}**`,
    ``,
    detail.summary,
  ];

  if (detail.themes.length > 0) {
    lines.push(``, `## Themes`);
    for (const t of detail.themes) {
      lines.push(``, `### ${t.headline}`, t.summary);
    }
  }

  if (detail.keywords.length > 0) {
    lines.push(``, `## Keywords`, detail.keywords.join(', '));
  }

  if (detail.key_entities.length > 0) {
    lines.push(``, `## Key Entities`, detail.key_entities.join(', '));
  }

  if (detail.open_questions) {
    lines.push(``, `## Open Questions`, detail.open_questions);
  }

  return lines.join('\n');
}

type HeatLabel = 'HOT' | 'WARM' | 'MILD';
const HEAT_BORDER: Record<HeatLabel, string> = {
  HOT:  'border-orange-400',
  WARM: 'border-amber-400',
  MILD: 'border-blue-300',
};

function computeHeatLabels(results: SearchResult[]): Map<string, HeatLabel> {
  const ranked = results.filter(r => r.rank !== null);
  const map = new Map<string, HeatLabel>();
  if (ranked.length === 0) return map;

  // FTS5 rank: more negative = better. Sort ascending (best first).
  const sorted = [...ranked].sort((a, b) => a.rank! - b.rank!);
  sorted.forEach((r, i) => {
    const pct = i / sorted.length;
    map.set(r.smo_id, pct < 0.33 ? 'HOT' : pct < 0.66 ? 'WARM' : 'MILD');
  });
  return map;
}

function buildSnippets(text: string, rawQuery: string, maxSnippets = 5, windowChars = 100): string[] {
  if (!rawQuery.trim() || !text) return [];

  const terms = rawQuery
    .split(/\s+/)
    .filter(t => t.length > 0 && !['AND', 'OR', 'NOT'].includes(t.toUpperCase()))
    .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (terms.length === 0) return [];

  // Use prefix matching so porter-stemmed variants (e.g. "usability" for "usable") are found.
  // For words > 5 chars, match on the first ~70% of chars; shorter words match exactly.
  const prefixTerms = terms.map(t => t.length > 5 ? t.slice(0, Math.ceil(t.length * 0.7)) : t);

  const prefixRegexes = prefixTerms.map(t => new RegExp(t, 'i'));
  const anyPrefixPattern = new RegExp(prefixTerms.join('|'), 'gi');

  const matchPositions: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = anyPrefixPattern.exec(text)) !== null) matchPositions.push(m.index);
  if (matchPositions.length === 0) return [];

  const tryBuild = (requireAll: boolean): { from: number; to: number }[] => {
    const result: { from: number; to: number }[] = [];
    let lastCenter = -Infinity;
    for (const pos of matchPositions) {
      if (pos - lastCenter < windowChars) continue;
      const from = Math.max(0, pos - windowChars);
      const to = Math.min(text.length, pos + windowChars);
      if (requireAll && !prefixRegexes.every(re => re.test(text.slice(from, to)))) continue;
      result.push({ from, to });
      lastCenter = pos;
      if (result.length >= maxSnippets) break;
    }
    return result;
  };

  const windows = tryBuild(true).length > 0 ? tryBuild(true) : tryBuild(false);

  const hlPattern = new RegExp(prefixTerms.join('|'), 'gi');
  return windows.map(({ from, to }) => {
    let excerpt = text.slice(from, to);
    if (from > 0) excerpt = '…' + excerpt;
    if (to < text.length) excerpt += '…';
    return excerpt.replace(hlPattern, match => `<mark>${match}</mark>`);
  });
}

function formatCardDate(start: string, end: string): string {
  const fmt = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };
  return start === end ? fmt(start) : `${fmt(start)} – ${fmt(end)}`;
}

type SourceMatch = { source_label: string; snippet: string; source_url?: string | null; source_id?: string | null };

function MemoryCard({ result, sources, heat, query }: { result: SearchResult; sources: SourceMatch[]; heat?: HeatLabel; query: string }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<SmoDetail | null>(null);
  const [srcSummaries, setSrcSummaries] = useState<SourceSummaryItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  async function fetchDetail(): Promise<SmoDetail> {
    if (detail) return detail;
    const d = await api.smos.get(result.smo_id);
    setDetail(d);
    return d;
  }

  async function toggle() {
    if (!expanded && !detail) {
      setLoading(true);
      try {
        await Promise.all([
          fetchDetail(),
          api.smos.sourceSummaries(result.smo_id).then(setSrcSummaries),
        ]);
      } catch (err) { console.error(err); } finally { setLoading(false); }
    }
    setExpanded(e => !e);
  }

  async function copyMd(e: React.MouseEvent) {
    e.stopPropagation();
    try {
      const d = await fetchDetail();
      await navigator.clipboard.writeText(formatAsMarkdown(result, d));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error(err);
    }
  }

  const borderClass = heat ? HEAT_BORDER[heat] : 'border-gray-200';

  return (
    <div className={`bg-white rounded-xl border-2 ${borderClass} overflow-hidden transition-shadow hover:shadow-sm`}>
      {/* Summary row — always visible, click to expand */}
      <button
        onClick={toggle}
        className="w-full px-4 py-3 text-left hover:bg-gray-50 transition-colors"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <span className="text-sm font-bold text-gray-900">
              {formatCardDate(result.date_range_start, result.date_range_end)}
            </span>
            {result.location && (
              <span className="text-sm text-gray-500">{result.location}</span>
            )}
            <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ${LAYER_COLORS[result.layer]}`}>
              {LAYER_LABELS[result.layer]}
            </span>
          </div>
          <div className="shrink-0 flex items-center gap-2">
            <button
              onClick={copyMd}
              className="text-xs text-gray-400 hover:text-indigo-600 border border-gray-200 hover:border-indigo-300 rounded px-2 py-0.5 transition-colors"
            >
              {copied ? '✓ Copied' : 'Copy MD'}
            </button>
            <span className="text-gray-300 text-sm">
              {loading ? '…' : expanded ? '▲' : '▼'}
            </span>
          </div>
        </div>
        <h3 className="font-medium text-gray-900 text-sm mt-1">{result.headline}</h3>
      </button>

      {/* Snippets — outside the button so source links are not intercepted */}
      {!expanded && (() => {
        const snippetClass = 'text-xs text-gray-600 [&_mark]:bg-yellow-100 [&_mark]:text-gray-900 [&_mark]:rounded [&_mark]:px-0.5';
        const smoSnippets = buildSnippets(result.snippet ?? '', query);
        if (sources.length > 0) {
          return (
            <div className="px-4 pb-3 space-y-2">
              {sources.map((src, i) => {
                const snippets = buildSnippets(src.snippet ?? '', query);
                return (
                  <div key={i}>
                    <div className="flex items-center gap-2 flex-wrap">
                      {src.source_url
                        ? <a href={src.source_url} target="_blank" rel="noopener noreferrer" className="text-xs text-indigo-500 font-medium hover:underline">↳ {src.source_label}</a>
                        : <p className="text-xs text-indigo-500 font-medium">↳ {src.source_label}</p>
                      }
                      {src.source_id && (
                        <a href={`/source/${src.source_id}`} target="_blank" rel="noopener noreferrer" className="text-xs text-gray-400 hover:text-indigo-500 border border-gray-200 hover:border-indigo-300 rounded px-1.5 py-0.5 transition-colors">
                          details
                        </a>
                      )}
                    </div>
                    {snippets.length > 0
                      ? <div className="mt-1 space-y-1">{snippets.map((s, j) => <p key={j} className={snippetClass} dangerouslySetInnerHTML={{ __html: s }} />)}</div>
                      : src.snippet && <p className="text-xs text-gray-500 mt-1 line-clamp-2">{src.snippet.slice(0, 200)}</p>
                    }
                  </div>
                );
              })}
            </div>
          );
        }
        if (smoSnippets.length === 0) return null;
        return (
          <div className="px-4 pb-3 space-y-1">
            {smoSnippets.map((s, i) => <p key={i} className={snippetClass} dangerouslySetInnerHTML={{ __html: s }} />)}
          </div>
        );
      })()}

      {/* Expanded detail */}
      {expanded && detail && (
        <div className="border-t border-gray-100 px-4 pb-4 pt-3 space-y-4">

          {/* Key decisions */}
          {detail.key_decisions && detail.key_decisions.length > 0 && (
            <div className="bg-green-50 border border-green-100 rounded-lg px-3 py-2">
              <p className="text-xs font-semibold text-green-700 mb-1">Key decisions</p>
              <ul className="list-disc list-inside space-y-0.5">
                {detail.key_decisions.map((d, i) => (
                  <li key={i} className="text-xs text-green-900">{d}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Open questions */}
          {detail.open_questions && (
            <div className="bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
              <p className="text-xs font-semibold text-amber-700 mb-1">Open questions</p>
              <ul className="list-disc list-inside space-y-0.5">
                {detail.open_questions.split('\n').map((q, i) => {
                  const text = q.trim();
                  return text ? <li key={i} className="text-xs text-amber-900">{text}</li> : null;
                })}
              </ul>
            </div>
          )}

          {/* Sources */}
          {srcSummaries && srcSummaries.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Sources</p>
              {srcSummaries.map(src => (
                <div key={src.id} className="flex items-center gap-2 flex-wrap">
                  {src.source_url
                    ? <a href={src.source_url} target="_blank" rel="noopener noreferrer" className="text-xs text-indigo-500 font-medium hover:underline">↳ {src.label}</a>
                    : <span className="text-xs text-indigo-500 font-medium">↳ {src.label}</span>
                  }
                  <a href={`/source/${src.id}`} target="_blank" rel="noopener noreferrer" className="text-xs text-gray-400 hover:text-indigo-500 border border-gray-200 hover:border-indigo-300 rounded px-1.5 py-0.5 transition-colors">
                    details
                  </a>
                </div>
              ))}
            </div>
          )}

          {/* Themes */}
          {detail.themes.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Themes</p>
              {detail.themes.map((t, i) => (
                <div key={i} className="bg-gray-50 rounded-lg px-3 py-2">
                  <p className="text-xs font-semibold text-gray-700">{t.headline}</p>
                  <p className="text-xs text-gray-600 mt-0.5 leading-relaxed">{t.summary}</p>
                </div>
              ))}
            </div>
          )}

          {/* Keywords + entities */}
          {(detail.keywords.length > 0 || detail.key_entities.length > 0) && (
            <div className="flex flex-wrap gap-3">
              {detail.keywords.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {detail.keywords.map(k => (
                    <span key={k} className="bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded-full">{k}</span>
                  ))}
                </div>
              )}
              {detail.key_entities.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {detail.key_entities.map(e => (
                    <span key={e} className="bg-indigo-50 text-indigo-600 text-xs px-2 py-0.5 rounded-full">{e}</span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Footer link */}
          <div className="flex items-center justify-end pt-1">
            <a
              href={`/smo/${result.smo_id}`}
              className="text-xs text-indigo-500 hover:underline"
              onClick={e => e.stopPropagation()}
            >
              View sources & drill-down →
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function renderInline(text: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/);
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2)
      return <em key={i}>{part.slice(1, -1)}</em>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2)
      return <code key={i} className="bg-gray-200 text-gray-800 px-1 rounded text-xs font-mono">{part.slice(1, -1)}</code>;
    return part;
  });
}

function MarkdownText({ content }: { content: string }) {
  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let listItems: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let key = 0;

  const flushList = () => {
    if (!listItems.length) return;
    if (listType === 'ul') {
      elements.push(
        <ul key={key++} className="list-disc list-inside space-y-0.5 my-1 pl-1">
          {listItems.map((item, i) => <li key={i}>{renderInline(item)}</li>)}
        </ul>
      );
    } else {
      elements.push(
        <ol key={key++} className="list-decimal list-inside space-y-0.5 my-1 pl-1">
          {listItems.map((item, i) => <li key={i}>{renderInline(item)}</li>)}
        </ol>
      );
    }
    listItems = [];
    listType = null;
  };

  for (const line of lines) {
    if (/^---+$/.test(line.trim())) {
      flushList();
      elements.push(<hr key={key++} className="border-gray-300 my-2" />);
    } else if (line.startsWith('### ')) {
      flushList();
      elements.push(<p key={key++} className="font-semibold text-gray-800 mt-2 mb-0.5 text-sm">{renderInline(line.slice(4))}</p>);
    } else if (line.startsWith('## ')) {
      flushList();
      elements.push(<p key={key++} className="font-semibold text-gray-800 mt-2 mb-0.5">{renderInline(line.slice(3))}</p>);
    } else if (line.startsWith('# ')) {
      flushList();
      elements.push(<p key={key++} className="font-bold text-gray-900 mt-2 mb-1">{renderInline(line.slice(2))}</p>);
    } else if (/^[-*] /.test(line)) {
      if (listType !== 'ul') { flushList(); listType = 'ul'; }
      listItems.push(line.slice(2));
    } else if (/^\d+\. /.test(line)) {
      if (listType !== 'ol') { flushList(); listType = 'ol'; }
      listItems.push(line.replace(/^\d+\. /, ''));
    } else if (line.trim() === '') {
      flushList();
      if (elements.length > 0) elements.push(<div key={key++} className="h-1.5" />);
    } else {
      flushList();
      elements.push(<p key={key++}>{renderInline(line)}</p>);
    }
  }
  flushList();
  return <div className="space-y-0.5 leading-relaxed">{elements}</div>;
}

function AssistantBubble({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  async function copy() {
    const el = contentRef.current;
    if (!el) return;
    try {
      const html = el.innerHTML;
      const plain = el.innerText;
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([plain], { type: 'text/plain' }),
        }),
      ]);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback for browsers that don't support ClipboardItem
      await navigator.clipboard.writeText(el.innerText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] group relative">
        <div ref={contentRef} className="rounded-lg px-3 py-2 text-sm bg-gray-100 text-gray-800">
          <MarkdownText content={content} />
        </div>
        <button
          onClick={copy}
          className="absolute -bottom-5 right-0 text-xs text-gray-400 hover:text-indigo-600 transition-colors opacity-0 group-hover:opacity-100"
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

function IntelligencePanel({ filters }: { filters: { q: string; layer?: number; from?: string; to?: string } }) {
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [contextMeta, setContextMeta] = useState<ContextMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState(() => crypto.randomUUID());
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const userScrolledRef = useRef(false);

  useEffect(() => {
    if (userScrolledRef.current) return;
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [history, streamingContent]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (!streaming) return;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      userScrolledRef.current = !atBottom;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [streaming]);

  async function send() {
    const question = input.trim();
    if (!question || streaming) return;

    setInput('');
    setError(null);
    setStreaming(true);
    setStreamingContent('');
    userScrolledRef.current = false;

    const userMsg: ChatMessage = { role: 'user', content: question };
    setHistory(prev => [...prev, userMsg]);

    abortRef.current = new AbortController();

    let accumulated = '';
    try {
      await api.intelligence.query(
        { question, history, filters: { q: filters.q, layer: filters.layer, from: filters.from || undefined, to: filters.to || undefined } },
        {
          onMeta: (meta) => setContextMeta(meta),
          onChunk: (text) => { accumulated += text; setStreamingContent(accumulated); },
          onDone: () => {
            setHistory(prev => [...prev, { role: 'assistant', content: accumulated }]);
            setStreamingContent('');
            setStreaming(false);
          },
          onError: (err) => {
            setError(err.message);
            setStreaming(false);
            setStreamingContent('');
            // Remove the optimistically added user message on error
            setHistory(prev => prev.slice(0, -1));
          },
        },
        abortRef.current.signal,
      );
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError(String(err));
      setStreaming(false);
      setStreamingContent('');
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function clearConversation() {
    abortRef.current?.abort();
    setHistory([]);
    setStreamingContent('');
    setStreaming(false);
    setContextMeta(null);
    setError(null);
    setSaveState('idle');
    setSessionId(crypto.randomUUID()); // new session ID = next save creates a new source
    inputRef.current?.focus();
  }

  async function saveSession() {
    if (!history.length || !contextMeta || saveState === 'saving') return;
    setSaveState('saving');
    try {
      await api.chatSessions.save({
        sessionId,
        messages: history,
        contextMeta,
        filters: { q: filters.q, layer: filters.layer, from: filters.from, to: filters.to },
      });
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 3000);
    } catch {
      setSaveState('error');
      setTimeout(() => setSaveState('idle'), 3000);
    }
  }

  const [expanded, setExpanded] = useState(false);
  const [historyCopied, setHistoryCopied] = useState(false);
  const hasContent = history.length > 0 || streaming;

  async function copyHistory() {
    const el = scrollRef.current;
    if (!el || !history.length) return;
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([el.innerHTML], { type: 'text/html' }),
          'text/plain': new Blob([el.innerText], { type: 'text/plain' }),
        }),
      ]);
    } catch {
      await navigator.clipboard.writeText(el.innerText);
    }
    setHistoryCopied(true);
    setTimeout(() => setHistoryCopied(false), 2000);
  }

  const panelClass = expanded
    ? 'fixed inset-4 z-50 bg-white rounded-xl border border-indigo-200 overflow-hidden shadow-2xl flex flex-col'
    : 'mb-5 bg-white rounded-xl border border-indigo-200 overflow-hidden';

  return (
    <>
      {expanded && <div className="fixed inset-0 z-40 bg-black/30" onClick={() => setExpanded(false)} />}
      <div className={panelClass} style={expanded ? {} : undefined}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-indigo-50 border-b border-indigo-100">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-indigo-700 uppercase tracking-wide">Ask</span>
          {contextMeta && (
            <span className="text-xs text-indigo-400">
              {contextMeta.smo_count} {contextMeta.smo_count === 1 ? 'memory' : 'memories'} · {contextMeta.source_count} sources · ~{contextMeta.token_estimate.toLocaleString()} tokens in context
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {hasContent && (
            <>
              <button
                onClick={saveSession}
                disabled={streaming || saveState === 'saving' || !history.length}
                className="text-xs text-indigo-400 hover:text-indigo-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? '✓ Saved' : saveState === 'error' ? 'Error saving' : 'Save session'}
              </button>
              <button
                onClick={copyHistory}
                disabled={!history.length}
                className="text-xs text-indigo-400 hover:text-indigo-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {historyCopied ? '✓ Copied' : 'Copy all'}
              </button>
              <button
                onClick={clearConversation}
                className="text-xs text-indigo-400 hover:text-indigo-600 transition-colors"
              >
                Clear
              </button>
            </>
          )}
          <button
            onClick={() => setExpanded(e => !e)}
            className="text-indigo-400 hover:text-indigo-600 transition-colors"
            title={expanded ? 'Collapse' : 'Expand'}
          >
            {expanded ? (
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M5 10a1 1 0 011-1h3V6a1 1 0 112 0v3h3a1 1 0 110 2h-3v3a1 1 0 11-2 0v-3H6a1 1 0 01-1-1z" clipRule="evenodd" transform="rotate(45 10 10)" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-5h-4m4 0v4m0-4l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Chat history */}
      {hasContent && (
        <div ref={scrollRef} className={`overflow-y-auto px-4 py-3 space-y-4 ${expanded ? 'flex-1' : 'max-h-96'}`}>
          {history.map((msg, i) =>
            msg.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm bg-indigo-600 text-white whitespace-pre-wrap leading-relaxed">
                  {msg.content}
                </div>
              </div>
            ) : (
              <AssistantBubble key={i} content={msg.content} />
            )
          )}
          {streaming && streamingContent && (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm bg-gray-100 text-gray-800">
                <MarkdownText content={streamingContent} />
                <span className="inline-block w-1.5 h-3.5 bg-gray-400 ml-0.5 animate-pulse rounded-sm" />
              </div>
            </div>
          )}
          {streaming && !streamingContent && (
            <div className="flex justify-start">
              <div className="rounded-lg px-3 py-2 bg-gray-100">
                <span className="flex gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mx-4 my-2 text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {/* Input */}
      <div className="px-3 py-2.5 flex gap-2 items-end">
        <textarea
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask a question about your memories… (Enter to send, Shift+Enter for new line)"
          rows={1}
          disabled={streaming}
          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none disabled:opacity-50"
          style={{ fontSize: '16px', minHeight: '38px', maxHeight: '120px' }}
          onInput={e => {
            const el = e.currentTarget;
            el.style.height = 'auto';
            el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
          }}
        />
        <button
          onClick={streaming ? () => abortRef.current?.abort() : send}
          disabled={!streaming && !input.trim()}
          className={`shrink-0 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
            streaming
              ? 'bg-red-100 text-red-600 hover:bg-red-200'
              : 'bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed'
          }`}
        >
          {streaming ? 'Stop' : 'Ask'}
        </button>
      </div>
    </div>
    </>
  );
}

type Preset = 'all' | 'yesterday' | 'week' | 'digest';

const PRESET_LABELS: Record<Preset, string> = {
  all: 'All',
  yesterday: 'Yesterday',
  week: 'This Week',
  digest: 'Digest',
};

function getPresetFilters(preset: Preset): { layer: number | undefined; from: string; to: string } {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const weekAgo = new Date(today); weekAgo.setDate(today.getDate() - 6);
  switch (preset) {
    case 'yesterday': return { layer: 1, from: fmt(yesterday), to: fmt(yesterday) };
    case 'week':      return { layer: undefined, from: fmt(weekAgo), to: fmt(today) };
    case 'digest':    return { layer: 2, from: '', to: '' };
    default:          return { layer: undefined, from: '', to: '' };
  }
}

export default function Search() {
  const [query, setQuery] = useState('');
  const [resultsQuery, setResultsQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [preset, setPreset] = useState<Preset>('all');
  const [loading, setLoading] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { layer: layerFilter, from: fromDate, to: toDate } = getPresetFilters(preset);

  const fetchResults = useCallback(async (q: string, layer: number | undefined, from: string, to: string) => {
    setLoading(true);
    try {
      const data = await api.search(q, layer, from || undefined, to || undefined);
      setResults(data);
      setResultsQuery(q);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load all on mount
  useEffect(() => {
    fetchResults('', undefined, '', '');
  }, [fetchResults]);

  // Debounce query typing, immediate for filter changes
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchResults(query, layerFilter, fromDate, toDate);
    }, query ? 300 : 0);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, layerFilter, fromDate, toDate, fetchResults]);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <span className="font-semibold text-gray-900">Notes</span>
        <div className="flex items-center gap-3">
          <a href="/settings" className="text-sm text-gray-500 hover:text-gray-800">Settings</a>
          <button
            onClick={() => api.auth.logout().then(() => { window.location.href = '/'; })}
            className="text-sm text-gray-500 hover:text-gray-800"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6">
        {/* Search bar */}
        <div className="relative mb-4">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            autoFocus
            placeholder="Filter memories…"
            className="w-full border border-gray-300 rounded-lg pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
            style={{ fontSize: '16px' }}
          />
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
          {query && (
            <button
              onClick={() => setQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-lg leading-none"
            >
              ×
            </button>
          )}
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2 mb-5">
          {(Object.keys(PRESET_LABELS) as Preset[]).map(p => (
            <button
              key={p}
              onClick={() => setPreset(p)}
              className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                preset === p
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white text-gray-600 border-gray-300 hover:border-indigo-400'
              }`}
            >
              {PRESET_LABELS[p]}
            </button>
          ))}
        </div>

        {/* Intelligence panel */}
        <IntelligencePanel filters={{ q: resultsQuery, layer: layerFilter, from: fromDate || undefined, to: toDate || undefined }} />

        {/* Count */}
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs text-gray-400">
            {loading ? 'Loading…' : (() => {
              const unique = new Set(results.map(r => r.smo_id)).size;
              return `${unique} memor${unique === 1 ? 'y' : 'ies'}`;
            })()}
            {query && !loading && ` matching "${query}"`}
          </p>
        </div>

        {/* Results */}
        {!loading && results.length === 0 && (
          <div className="text-center py-16 text-gray-400 text-sm">
            {query ? `No memories match "${query}"` : 'No memories yet.'}
          </div>
        )}

        <div className="space-y-2">
          {(() => {
            const heatMap = computeHeatLabels(results);
            const grouped = new Map<string, { result: SearchResult; sources: SourceMatch[] }>();
            for (const r of results) {
              if (!grouped.has(r.smo_id)) grouped.set(r.smo_id, { result: r, sources: [] });
              if (r.source_label) grouped.get(r.smo_id)!.sources.push({ source_label: r.source_label, snippet: r.snippet, source_url: r.source_url, source_id: r.source_id });
            }
            return Array.from(grouped.values()).map(({ result: r, sources }) => (
              <MemoryCard key={r.smo_id} result={r} sources={sources} heat={heatMap.get(r.smo_id)} query={resultsQuery} />
            ));
          })()}
        </div>
      </main>
    </div>
  );
}
