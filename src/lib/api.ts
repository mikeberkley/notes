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
  snippet: string;
  rank: number | null;
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
  open_questions: string | null;
  date_range_start: string;
  date_range_end: string;
  themes: Theme[];
}

export interface RawSource {
  id: string;
  source_type: 'gmail' | 'gdrive';
  metadata: { subject?: string; sender?: string; filename?: string };
  content: string;
}

export interface ApiKeyRecord {
  id: string;
  label: string;
  last_used: string | null;
  created_at: string;
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
  },

  rawSources: {
    get: (id: string) => apiFetch<RawSource>(`/api/raw-sources/${id}`),
  },

  settings: {
    get: () => apiFetch<{ gdrive_folder_id: string | null; workflowy_api_key: string | null; connections: { google: boolean } }>('/api/settings'),
    update: (data: { gdrive_folder_id?: string; workflowy_api_key?: string }) =>
      apiFetch<{ ok: boolean }>('/api/settings', { method: 'PUT', body: JSON.stringify(data) }),
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
};
