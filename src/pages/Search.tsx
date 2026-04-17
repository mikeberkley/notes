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

function MemoryCard({ result }: { result: SearchResult }) {
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

  return (
    <div className="bg-white rounded-xl border border-gray-200 overflow-hidden transition-shadow hover:shadow-sm">
      {/* Summary row — always visible, click to expand */}
      <button
        onClick={toggle}
        className="w-full flex items-start justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50 transition-colors"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ${LAYER_COLORS[result.layer]}`}>
              {LAYER_LABELS[result.layer]}
            </span>
            <span className="text-xs text-gray-400">
              {result.date_range_start}
              {result.date_range_end !== result.date_range_start && ` – ${result.date_range_end}`}
            </span>
            {result.rank !== null && (
              <span className="text-xs text-gray-400 font-mono">
                score {(-result.rank).toFixed(2)}
              </span>
            )}
          </div>
          <h3 className="font-medium text-gray-900 text-sm mt-1">{result.headline}</h3>
          {result.snippet && !expanded && (
            <p
              className="text-xs text-gray-500 mt-1 line-clamp-1"
              dangerouslySetInnerHTML={{ __html: result.snippet }}
            />
          )}
        </div>
        <div className="shrink-0 flex items-center gap-2 mt-0.5">
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
      </button>

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

          {/* Open questions */}
          {detail.open_questions && (
            <div className="bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
              <p className="text-xs font-semibold text-amber-700 mb-0.5">Open questions</p>
              <p className="text-xs text-amber-900">{detail.open_questions}</p>
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
            placeholder="Filter memories…"
            className="w-full border border-gray-300 rounded-lg pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
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
            <input
              type="date"
              value={fromDate}
              onChange={e => setFromDate(e.target.value)}
              className="border border-gray-300 rounded-lg px-2 py-1 text-xs text-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
            <span className="text-gray-400 text-xs">–</span>
            <input
              type="date"
              value={toDate}
              onChange={e => setToDate(e.target.value)}
              className="border border-gray-300 rounded-lg px-2 py-1 text-xs text-gray-600 focus:outline-none focus:ring-1 focus:ring-indigo-400"
            />
          </div>
        </div>

        {/* Count */}
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs text-gray-400">
            {loading ? 'Loading…' : `${results.length} memor${results.length === 1 ? 'y' : 'ies'}`}
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
          {results.map(r => (
            <MemoryCard key={r.smo_id} result={r} />
          ))}
        </div>
      </main>
    </div>
  );
}
