import { useState, useEffect } from 'react';
import { api, type SmoDetail, type RawSource } from '../lib/api.js';

const LAYER_LABELS: Record<number, string> = { 1: 'Day', 2: 'Week', 3: 'Month' };
const LAYER_COLORS: Record<number, string> = {
  1: 'bg-blue-100 text-blue-700',
  2: 'bg-violet-100 text-violet-700',
  3: 'bg-amber-100 text-amber-700',
};

function sourceLabel(rs: import('../lib/api.js').RawSource): string {
  const m = rs.metadata;
  switch (rs.source_type) {
    case 'gmail':
      return `Gmail: ${m.subject ?? '(no subject)'}`;
    case 'gdrive':
      return `Drive: ${m.filename ?? 'Untitled'}`;
    case 'workflowy':
      return `Workflowy: ${m.root_name ?? 'Note'}`;
    case 'gcalendar':
      return `Calendar: ${m.title ?? 'Event'}`;
    case 'slack':
      return m.type === 'dm'
        ? `Slack DM: ${m.with_user ?? 'Unknown'}`
        : `Slack: #${m.channel_name ?? 'channel'}`;
    default:
      return rs.source_type;
  }
}

export default function SMODetail() {
  const id = window.location.pathname.split('/').pop() ?? '';
  const [smo, setSmo] = useState<SmoDetail | null>(null);
  const [children, setChildren] = useState<SmoDetail[]>([]);
  const [sources, setSources] = useState<Array<{ target_type: string; target_id: string }>>([]);
  const [expandedSource, setExpandedSource] = useState<string | null>(null);
  const [sourceContent, setSourceContent] = useState<Record<string, RawSource>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    Promise.all([api.smos.get(id), api.smos.children(id), api.smos.sources(id)])
      .then(([smoData, childrenData, sourcesData]) => {
        setSmo(smoData);
        setChildren(childrenData);
        setSources(sourcesData);
        // Eagerly load metadata for all raw sources so labels show without expanding
        const rawSourceIds = sourcesData
          .filter((s: { target_type: string }) => s.target_type === 'raw_source')
          .map((s: { target_id: string }) => s.target_id);
        Promise.all(rawSourceIds.map((sid: string) => api.rawSources.get(sid)))
          .then(results => {
            const map: Record<string, typeof results[0]> = {};
            results.forEach(rs => { map[rs.id] = rs; });
            setSourceContent(map);
          })
          .catch(console.error);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [id]);

  async function toggleSource(targetId: string) {
    if (expandedSource === targetId) { setExpandedSource(null); return; }
    setExpandedSource(targetId);
    if (!sourceContent[targetId]) {
      const rs = await api.rawSources.get(targetId);
      setSourceContent(prev => ({ ...prev, [targetId]: rs }));
    }
  }

  if (loading) return <div className="min-h-screen bg-gray-50 flex items-center justify-center text-gray-400 text-sm">Loading…</div>;
  if (!smo) return <div className="min-h-screen bg-gray-50 flex items-center justify-center text-gray-400 text-sm">Not found.</div>;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3">
        <a href="/search" className="text-sm text-gray-500 hover:text-gray-800">← Search</a>
        <span className="text-gray-300">|</span>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${LAYER_COLORS[smo.layer]}`}>
          Layer {smo.layer} · {LAYER_LABELS[smo.layer]}
        </span>
        <span className="text-sm text-gray-500">{smo.date_range_start}{smo.date_range_end !== smo.date_range_start ? ` – ${smo.date_range_end}` : ''}</span>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        {/* Headline + Summary */}
        <div>
          <h1 className="text-xl font-bold text-gray-900 mb-3">{smo.headline}</h1>
          <p className="text-sm text-gray-700 leading-relaxed">{smo.summary}</p>
        </div>

        {/* Themes */}
        {smo.themes.length > 0 && (
          <section>
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Themes</h2>
            <div className="space-y-3">
              {smo.themes.map((t, i) => (
                <div key={i} className="bg-white rounded-xl border border-gray-200 p-4">
                  <h3 className="font-medium text-gray-900 text-sm mb-1">{t.headline}</h3>
                  <p className="text-sm text-gray-600">{t.summary}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Keywords + Entities */}
        <div className="flex flex-wrap gap-4">
          {smo.keywords.length > 0 && (
            <div className="flex-1 min-w-48">
              <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Keywords</h2>
              <div className="flex flex-wrap gap-1.5">
                {smo.keywords.map(k => (
                  <span key={k} className="bg-gray-100 text-gray-700 text-xs px-2 py-0.5 rounded-full">{k}</span>
                ))}
              </div>
            </div>
          )}
          {smo.key_entities.length > 0 && (
            <div className="flex-1 min-w-48">
              <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Key Entities</h2>
              <div className="flex flex-wrap gap-1.5">
                {smo.key_entities.map(e => (
                  <span key={e} className="bg-indigo-50 text-indigo-700 text-xs px-2 py-0.5 rounded-full">{e}</span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Key decisions */}
        {smo.key_decisions && smo.key_decisions.length > 0 && (
          <section className="bg-green-50 border border-green-200 rounded-xl p-4">
            <h2 className="text-xs font-semibold text-green-700 uppercase tracking-wide mb-1">Key Decisions</h2>
            <ul className="list-disc list-inside space-y-1">
              {smo.key_decisions.map((d, i) => (
                <li key={i} className="text-sm text-green-900">{d}</li>
              ))}
            </ul>
          </section>
        )}

        {/* Open questions */}
        {smo.open_questions && (
          <section className="bg-amber-50 border border-amber-200 rounded-xl p-4">
            <h2 className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-1">Open Questions</h2>
            <ul className="list-disc list-inside space-y-1">
              {smo.open_questions.split('\n').map((q, i) => {
                const text = q.trim();
                return text ? <li key={i} className="text-sm text-amber-900">{text}</li> : null;
              })}
            </ul>
          </section>
        )}

        {/* Child SMOs (Layer 2 → Layer 1, Layer 3 → Layer 2) */}
        {children.length > 0 && (
          <section>
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">
              {smo.layer === 3 ? 'Weekly summaries' : 'Daily summaries'}
            </h2>
            <div className="space-y-2">
              {children.map(c => (
                <a
                  key={c.id}
                  href={`/smo/${c.id}`}
                  className="flex items-center justify-between bg-white rounded-xl border border-gray-200 px-4 py-3 hover:border-indigo-300 transition-colors"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-900">{c.headline}</p>
                    <p className="text-xs text-gray-500 mt-0.5">{c.date_range_start}{c.date_range_end !== c.date_range_start ? ` – ${c.date_range_end}` : ''}</p>
                  </div>
                  <span className="text-gray-300 text-sm">→</span>
                </a>
              ))}
            </div>
          </section>
        )}

        {/* Raw sources */}
        {sources.filter(s => s.target_type === 'raw_source').length > 0 && (
          <section>
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Sources</h2>
            <div className="space-y-2">
              {sources.filter(s => s.target_type === 'raw_source').map(s => {
                const rs = sourceContent[s.target_id];
                const expanded = expandedSource === s.target_id;
                return (
                  <div key={s.target_id} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
                    <button
                      onClick={() => toggleSource(s.target_id)}
                      className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-gray-50"
                    >
                      <div className="text-sm text-gray-700 truncate">
                        {rs ? sourceLabel(rs) : <span className="text-gray-400">Loading…</span>}
                      </div>
                      <span className="text-gray-400 text-xs ml-2">{expanded ? '▲' : '▼'}</span>
                    </button>
                    {expanded && rs && (
                      <div className="px-4 pb-4 border-t border-gray-100">
                        <pre className="text-xs text-gray-600 whitespace-pre-wrap mt-3 max-h-80 overflow-y-auto leading-relaxed">
                          {rs.content}
                        </pre>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
