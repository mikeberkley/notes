import { useState, useEffect, useCallback, useRef } from 'react';
import { api, type SearchResult, type SmoDetail } from '../lib/api.js';

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
      try { await fetchDetail(); } catch (err) { console.error(err); } finally { setLoading(false); }
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
          {/* Summary paragraph */}
          <p className="text-sm text-gray-700 leading-relaxed">{detail.summary}</p>

          {/* Themes */}
          {detail.themes.length > 0 && (
            <div className="space-y-2">
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

          {/* Key decisions */}
          {detail.key_decisions && detail.key_decisions.length > 0 && (
            <div className="bg-green-50 border border-green-100 rounded-lg px-3 py-2">
              <p className="text-xs font-semibold text-green-700 mb-0.5">Key decisions</p>
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
              <p className="text-xs font-semibold text-amber-700 mb-0.5">Open questions</p>
              <ul className="list-disc list-inside space-y-0.5">
                {detail.open_questions.split('\n').map((q, i) => {
                  const text = q.trim();
                  return text ? <li key={i} className="text-xs text-amber-900">{text}</li> : null;
                })}
              </ul>
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

export default function Search() {
  const [query, setQuery] = useState('');
  const [resultsQuery, setResultsQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [layerFilter, setLayerFilter] = useState<number | undefined>();
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [loading, setLoading] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        <div className="flex flex-wrap items-center gap-2 mb-5">
          {[undefined, 1, 2, 3].map(l => (
            <button
              key={l ?? 'all'}
              onClick={() => setLayerFilter(l)}
              className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                layerFilter === l
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-white text-gray-600 border-gray-300 hover:border-indigo-400'
              }`}
            >
              {l === undefined ? 'All layers' : `Layer ${l} · ${LAYER_LABELS[l]}`}
            </button>
          ))}
          <div className="flex items-center gap-1.5 ml-auto">
            {(['from', 'to'] as const).map((which, i) => (
              <div key={which} className="flex items-center gap-1.5">
                {i === 1 && <span className="text-gray-400 text-xs">–</span>}
                <div className="relative flex items-center border border-gray-300 rounded-lg focus-within:ring-1 focus-within:ring-indigo-400">
                  <svg className="absolute left-2 h-3.5 w-3.5 text-gray-400 pointer-events-none z-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                    <line x1="16" y1="2" x2="16" y2="6" />
                    <line x1="8" y1="2" x2="8" y2="6" />
                    <line x1="3" y1="10" x2="21" y2="10" />
                  </svg>
                  <input
                    type="date"
                    value={which === 'from' ? fromDate : toDate}
                    onChange={e => which === 'from' ? setFromDate(e.target.value) : setToDate(e.target.value)}
                    className="pl-7 pr-2 py-1 text-xs text-gray-600 bg-transparent focus:outline-none [&::-webkit-calendar-picker-indicator]:opacity-0 [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:w-full [&::-webkit-calendar-picker-indicator]:cursor-pointer"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Count */}
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs text-gray-400">
            {loading ? 'Loading…' : (() => {
              const unique = new Set(results.map(r => r.smo_id)).size;
              return `${unique} memor${unique === 1 ? 'y' : 'ies'}`;
            })()}
            {query && !loading && ` matching "${query}"`}
          </p>
          {(fromDate || toDate) && (
            <button onClick={() => { setFromDate(''); setToDate(''); }} className="text-xs text-indigo-500 hover:underline">
              Clear dates
            </button>
          )}
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
