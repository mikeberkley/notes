import { useEffect, useState } from 'react';
import { api, type RawSource } from '../lib/api.js';

const TYPE_LABELS: Record<string, string> = {
  gmail: 'Gmail',
  gdrive: 'Google Drive',
  workflowy: 'Workflowy',
  gcalendar: 'Google Calendar',
  slack: 'Slack',
};

const TYPE_COLORS: Record<string, string> = {
  gmail:      'bg-red-100 text-red-700',
  gdrive:     'bg-blue-100 text-blue-700',
  workflowy:  'bg-green-100 text-green-700',
  gcalendar:  'bg-purple-100 text-purple-700',
  slack:      'bg-amber-100 text-amber-700',
};

function sourceTitle(src: RawSource): string {
  const m = src.metadata;
  if (src.source_type === 'gmail') return m.subject ?? '(no subject)';
  if (src.source_type === 'gdrive') return m.filename ?? 'Untitled';
  if (src.source_type === 'workflowy') return m.root_name ?? 'Note';
  if (src.source_type === 'gcalendar') return m.title ?? 'Event';
  if (src.source_type === 'slack') {
    if (m.type === 'dm') return `DM with ${m.with_user ?? 'Unknown'}`;
    return `#${m.channel_name ?? 'channel'}`;
  }
  return src.source_type;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3 text-sm">
      <span className="w-32 shrink-0 text-gray-400 font-medium">{label}</span>
      <span className="text-gray-700 break-all">{value}</span>
    </div>
  );
}

export default function SourceDetail() {
  const [source, setSource] = useState<RawSource | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { document.title = 'Source Details'; }, []);

  useEffect(() => {
    const id = window.location.pathname.split('/').pop();
    if (!id) { setError('No source ID in URL.'); return; }
    api.rawSources.get(id)
      .then(setSource)
      .catch(err => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  if (error) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-red-500 text-sm">{error}</p>
      </div>
    );
  }

  if (!source) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <p className="text-gray-400 text-sm">Loading…</p>
      </div>
    );
  }

  const title = sourceTitle(source);
  const typeLabel = TYPE_LABELS[source.source_type] ?? source.source_type;
  const typeColor = TYPE_COLORS[source.source_type] ?? 'bg-gray-100 text-gray-700';

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3">
        <button onClick={() => window.close()} className="text-sm text-gray-400 hover:text-gray-600">✕</button>
        <span className="font-semibold text-gray-900 truncate">{title}</span>
        <span className={`shrink-0 text-xs px-2 py-0.5 rounded-full font-medium ${typeColor}`}>{typeLabel}</span>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6 space-y-6">

        {/* LLM Summary */}
        {source.summary && (
          <section className="bg-white rounded-xl border border-gray-200 px-4 py-4 space-y-4">
            <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide">AI Summary</h2>

            {source.key_decisions && source.key_decisions.length > 0 && (
              <div className="bg-green-50 border border-green-100 rounded-lg px-3 py-2">
                <p className="text-xs font-semibold text-green-700 mb-1">Key decisions</p>
                <ul className="list-disc list-inside space-y-0.5">
                  {source.key_decisions.map((d, i) => (
                    <li key={i} className="text-xs text-green-900">{d}</li>
                  ))}
                </ul>
              </div>
            )}

            {source.open_questions && (
              <div className="bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
                <p className="text-xs font-semibold text-amber-700 mb-1">Open questions</p>
                <ul className="list-disc list-inside space-y-0.5">
                  {source.open_questions.split('\n').map((q, i) => {
                    const text = q.trim();
                    return text ? <li key={i} className="text-xs text-amber-900">{text}</li> : null;
                  })}
                </ul>
              </div>
            )}

            <p className="text-sm text-gray-700 leading-relaxed">{source.summary}</p>

            {source.key_entities && source.key_entities.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-gray-500 mb-1">Key entities</p>
                <div className="flex flex-wrap gap-1">
                  {source.key_entities.map(e => (
                    <span key={e} className="bg-indigo-50 text-indigo-600 text-xs px-2 py-0.5 rounded-full">{e}</span>
                  ))}
                </div>
              </div>
            )}

            {source.keywords && source.keywords.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-gray-500 mb-1">Keywords</p>
                <div className="flex flex-wrap gap-1">
                  {source.keywords.map(k => (
                    <span key={k} className="bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded-full">{k}</span>
                  ))}
                </div>
              </div>
            )}

            {source.summary_error && (
              <p className="text-xs text-red-500">Summary error: {source.summary_error}</p>
            )}
          </section>
        )}

        {/* Metadata */}
        <section className="bg-white rounded-xl border border-gray-200 px-4 py-4 space-y-2">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Metadata</h2>
          <MetaRow label="Source type" value={typeLabel} />
          <MetaRow label="Source date" value={source.source_date} />
          <MetaRow label="Ingested at" value={formatDate(source.ingested_at)} />
          {source.summarized_at && <MetaRow label="Summarized at" value={formatDate(source.summarized_at)} />}
          <MetaRow label="ID" value={source.id} />
          {Object.entries(source.metadata).map(([k, v]) =>
            v != null ? <MetaRow key={k} label={k} value={String(v)} /> : null
          )}
        </section>

        {!source.summary && source.summary_error && (
          <section className="bg-white rounded-xl border border-red-100 px-4 py-4">
            <p className="text-xs text-red-500">Summary failed: {source.summary_error}</p>
          </section>
        )}

        {/* Raw content */}
        <section className="bg-white rounded-xl border border-gray-200 px-4 py-4">
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">Raw content</h2>
          <pre className="text-xs text-gray-700 whitespace-pre-wrap break-words leading-relaxed font-mono max-h-[60vh] overflow-y-auto">
            {source.content || <span className="text-gray-400 italic">No content</span>}
          </pre>
        </section>
      </main>
    </div>
  );
}
