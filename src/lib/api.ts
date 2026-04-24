const API_URL = import.meta.env.VITE_API_URL ?? 'https://notes-api.lost2038.com';

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const resp = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options?.headers },
  });

  if (resp.status === 401) {
    // Redirect to login
    window.location.href = '/';
    throw new Error('Unauthorized');
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`API error ${resp.status}: ${text}`);
  }

  return resp.json() as Promise<T>;
}

export interface SearchResult {
  smo_id: string;
  layer: number;
  headline: string;
  date_range_start: string;
  date_range_end: string;
  location: string | null;
  snippet: string;
  rank: number | null;
  source_label?: string; // present for source-level matches
  source_url?: string | null;
  source_id?: string | null;
}

export interface Theme {
  headline: string;
  summary: string;
  sort_order?: number;
}

export interface SmoDetail {
  id: string;
  layer: number;
  headline: string;
  summary: string;
  keywords: string[];
  key_entities: string[];
  key_decisions: string[] | null;
  open_questions: string | null;
  location: string | null;
  date_range_start: string;
  date_range_end: string;
  themes: Theme[];
}

export interface RawSource {
  id: string;
  user_id: string;
  source_type: 'gmail' | 'gdrive' | 'workflowy' | 'gcalendar' | 'slack' | 'chat' | 'confluence';
  external_id: string;
  source_date: string;
  ingested_at: string;
  metadata: {
    subject?: string;
    sender?: string;
    filename?: string;
    root_name?: string;
    title?: string;
    with_user?: string;
    channel_name?: string;
    type?: string;
    [key: string]: unknown;
  };
  content: string;
  summary: string | null;
  key_decisions: string[] | null;
  key_entities: string[] | null;
  keywords: string[] | null;
  open_questions: string | null;
  summarized_at: string | null;
  summary_error: string | null;
}

export interface SourceSummaryItem {
  id: string;
  source_type: string;
  label: string;
  source_url: string | null;
  has_key_decisions: boolean;
}

export interface ApiKeyRecord {
  id: string;
  label: string;
  last_used: string | null;
  created_at: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface IntelligenceFilters {
  q: string;
  layer?: number;
  from?: string;
  to?: string;
}

export interface ContextMeta {
  smo_count: number;
  source_count: number;
  token_estimate: number;
}

export const api = {
  auth: {
    me: () => apiFetch<{ id: string; email: string } | null>('/api/auth/me'),
    logout: () => apiFetch<void>('/api/auth/logout', { method: 'POST' }),
  },

  search: (q: string, layer?: number, from?: string, to?: string) => {
    const params = new URLSearchParams({ q });
    if (layer) params.set('layer', String(layer));
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return apiFetch<SearchResult[]>(`/api/search?${params}`);
  },

  smos: {
    list: (layer: number, date: string) =>
      apiFetch<SmoDetail[]>(`/api/smos?layer=${layer}&date=${date}`),
    get: (id: string) => apiFetch<SmoDetail>(`/api/smos/${id}`),
    children: (id: string) => apiFetch<SmoDetail[]>(`/api/smos/${id}/children`),
    sources: (id: string) =>
      apiFetch<Array<{ target_type: string; target_id: string }>>(`/api/smos/${id}/sources`),
    sourceSummaries: (id: string) => apiFetch<SourceSummaryItem[]>(`/api/smos/${id}/source-summaries`),
  },

  rawSources: {
    get: (id: string) => apiFetch<RawSource>(`/api/raw-sources/${id}`),
  },

  settings: {
    get: () => apiFetch<{
      gdrive_folder_id: string | null;
      workflowy_api_key: string | null;
      slack_token: string | null;
      intelligence_system_prompt: string | null;
      intelligence_context: string | null;
      connections: { google: boolean };
      confluence_email: string | null;
      confluence_api_token: string | null;
      confluence_space_key: string | null;
      confluence_base_url: string | null;
    }>('/api/settings'),
    update: (data: {
      gdrive_folder_id?: string;
      workflowy_api_key?: string;
      slack_token?: string;
      intelligence_system_prompt?: string;
      intelligence_context?: string;
      confluence_email?: string;
      confluence_api_token?: string;
      confluence_space_key?: string;
      confluence_base_url?: string;
    }) => apiFetch<{ ok: boolean }>('/api/settings', { method: 'PUT', body: JSON.stringify(data) }),
  },

  keys: {
    list: () => apiFetch<ApiKeyRecord[]>('/api/keys'),
    create: (label: string) =>
      apiFetch<{ id: string; key: string }>('/api/keys', { method: 'POST', body: JSON.stringify({ label }) }),
    delete: (id: string) => apiFetch<{ ok: boolean }>(`/api/keys/${id}`, { method: 'DELETE' }),
  },

  admin: {
    triggerIngest: (date?: string) =>
      apiFetch<{ ok: boolean }>('/api/admin/ingest/trigger', { method: 'POST', body: JSON.stringify({ date }) }),
    triggerSmo: (date?: string) =>
      apiFetch<{ ok: boolean }>(`/api/admin/smo/generate${date ? `?date=${date}` : ''}`, { method: 'POST' }),
  },

  chatSessions: {
    save: (payload: {
      sessionId: string;
      messages: ChatMessage[];
      contextMeta: ContextMeta;
      filters: IntelligenceFilters;
    }) => apiFetch<{ ok: boolean }>('/api/chat-sessions', { method: 'POST', body: JSON.stringify(payload) }),
  },

  intelligence: {
    query: async (
      payload: { question: string; history: ChatMessage[]; filters: IntelligenceFilters },
      callbacks: {
        onMeta: (meta: ContextMeta) => void;
        onChunk: (text: string) => void;
        onDone: () => void;
        onError: (err: Error) => void;
      },
      signal?: AbortSignal,
    ): Promise<void> => {
      const resp = await fetch(`${API_URL}/api/intelligence/query`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });

      if (resp.status === 401) { window.location.href = '/'; return; }
      if (!resp.ok) { callbacks.onError(new Error(`API error ${resp.status}`)); return; }

      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() ?? '';
          for (const block of blocks) {
            let event = 'message';
            let data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7).trim();
              else if (line.startsWith('data: ')) data = line.slice(6).trim();
            }
            if (!data) continue;
            if (event === 'meta') callbacks.onMeta(JSON.parse(data) as ContextMeta);
            else if (event === 'chunk') callbacks.onChunk((JSON.parse(data) as { text: string }).text);
            else if (event === 'done') callbacks.onDone();
            else if (event === 'error') callbacks.onError(new Error((JSON.parse(data) as { message: string }).message));
          }
        }
      } finally {
        reader.releaseLock();
      }
    },
  },
};
