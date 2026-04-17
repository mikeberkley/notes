import { useState, useEffect } from 'react';
import { api, type ApiKeyRecord } from '../lib/api.js';

export default function Settings() {
  const [settings, setSettings] = useState<{ gdrive_folder_id: string | null; workflowy_api_key: string | null; slack_token: string | null; connections: { google: boolean } } | null>(null);
  const [folderInput, setFolderInput] = useState('');
  const [workflowyKeyInput, setWorkflowyKeyInput] = useState('');
  const [slackTokenInput, setSlackTokenInput] = useState('');
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [newKeyLabel, setNewKeyLabel] = useState('');
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.settings.get(), api.keys.list()])
      .then(([s, k]) => {
        setSettings(s);
        setFolderInput(s.gdrive_folder_id ?? '');
        setKeys(k);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  async function saveFolder() {
    const value = folderInput.trim() || 'root';
    await api.settings.update({ gdrive_folder_id: value });
    setFolderInput(value === 'root' ? '' : value);
    const fresh = await api.settings.get();
    setSettings(fresh);
    setMessage('Saved.');
    setTimeout(() => setMessage(''), 2000);
  }

  async function saveWorkflowyKey() {
    if (!workflowyKeyInput.trim()) return;
    await api.settings.update({ workflowy_api_key: workflowyKeyInput.trim() });
    setWorkflowyKeyInput('');
    const fresh = await api.settings.get();
    setSettings(fresh);
    setMessage('Workflowy API key saved.');
    setTimeout(() => setMessage(''), 2000);
  }

  async function saveSlackToken() {
    if (!slackTokenInput.trim()) return;
    await api.settings.update({ slack_token: slackTokenInput.trim() });
    setSlackTokenInput('');
    const fresh = await api.settings.get();
    setSettings(fresh);
    setMessage('Slack token saved.');
    setTimeout(() => setMessage(''), 2000);
  }

  async function createKey() {
    if (!newKeyLabel.trim()) return;
    const { key } = await api.keys.create(newKeyLabel.trim());
    setNewKeyValue(key);
    setNewKeyLabel('');
    const fresh = await api.keys.list();
    setKeys(fresh);
  }

  async function revokeKey(id: string) {
    await api.keys.delete(id);
    setKeys(prev => prev.filter(k => k.id !== id));
  }

  async function triggerIngest() {
    await api.admin.triggerIngest();
    setMessage('Ingestion triggered.');
    setTimeout(() => setMessage(''), 3000);
  }

  if (loading) return <div className="min-h-screen bg-gray-50 flex items-center justify-center text-gray-400 text-sm">Loading…</div>;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-3">
        <a href="/search" className="text-sm text-gray-500 hover:text-gray-800">← Search</a>
        <span className="font-semibold text-gray-900 ml-1">Settings</span>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-8 space-y-8">
        {message && (
          <div className="bg-green-50 border border-green-200 text-green-700 text-sm rounded-lg px-4 py-2">
            {message}
          </div>
        )}

        {/* Google connection */}
        <section className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-4">Google Account</h2>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-700">
                Status: {settings?.connections.google
                  ? <span className="text-green-600 font-medium">Connected</span>
                  : <span className="text-red-500 font-medium">Not connected</span>}
              </p>
            </div>
            <a
              href={`${import.meta.env.VITE_API_URL ?? 'https://notes-api.lost2038.com'}/api/auth/google`}
              className="text-sm text-indigo-600 hover:underline"
            >
              {settings?.connections.google ? 'Reconnect' : 'Connect'}
            </a>
          </div>
        </section>

        {/* Google Drive folder */}
        <section className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-1">Google Drive Folder</h2>
          <p className="text-xs text-gray-500 mb-4">
            Ingest all of Drive, or restrict to a specific folder by pasting its ID from the Drive URL.
            Leave blank to ingest all of Drive.
          </p>
          <div className="flex gap-2">
            <input
              value={folderInput === 'root' ? '' : folderInput}
              onChange={e => setFolderInput(e.target.value)}
              placeholder="Folder ID — leave blank to ingest all of Drive"
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <button
              onClick={saveFolder}
              className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700"
            >
              Save
            </button>
          </div>
          {(settings?.gdrive_folder_id === null || settings?.gdrive_folder_id === 'root' || !settings?.gdrive_folder_id) && (
            <p className="text-xs text-indigo-600 mt-2">Ingesting entire Drive</p>
          )}
        </section>

        {/* Workflowy */}
        <section className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-1">Workflowy</h2>
          <p className="text-xs text-gray-500 mb-4">
            {settings?.workflowy_api_key
              ? 'API key saved. Paste a new key below to replace it.'
              : 'Paste your Workflowy API key to enable daily note ingestion.'}
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              value={workflowyKeyInput}
              onChange={e => setWorkflowyKeyInput(e.target.value)}
              placeholder={settings?.workflowy_api_key ? '••••••••' : 'Paste API key…'}
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <button
              onClick={saveWorkflowyKey}
              className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700"
            >
              Save
            </button>
          </div>
        </section>

        {/* Slack */}
        <section className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-1">Slack</h2>
          <p className="text-xs text-gray-500 mb-4">
            {settings?.slack_token
              ? 'Token saved. Paste a new token below to replace it.'
              : 'Paste a Slack user token (xoxp-…) to enable daily DM and channel post ingestion.'}
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              value={slackTokenInput}
              onChange={e => setSlackTokenInput(e.target.value)}
              placeholder={settings?.slack_token ? '••••••••' : 'xoxp-…'}
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <button
              onClick={saveSlackToken}
              className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700"
            >
              Save
            </button>
          </div>
        </section>

        {/* API Keys */}
        <section className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-4">API Keys</h2>

          {newKeyValue && (
            <div className="mb-4 bg-amber-50 border border-amber-200 rounded-lg p-4">
              <p className="text-xs font-semibold text-amber-700 mb-2">Copy this key — it won't be shown again:</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 font-mono text-xs text-amber-900 bg-amber-100 rounded px-2 py-1 break-all">{newKeyValue}</code>
                <button
                  onClick={() => { navigator.clipboard.writeText(newKeyValue); }}
                  className="shrink-0 text-xs text-amber-700 border border-amber-300 rounded px-2 py-1 hover:bg-amber-100"
                >
                  Copy
                </button>
              </div>
              <button onClick={() => setNewKeyValue(null)} className="mt-2 text-xs text-amber-600 hover:underline">Dismiss</button>
            </div>
          )}

          <div className="space-y-2 mb-4">
            {keys.length === 0 && <p className="text-sm text-gray-400">No API keys yet.</p>}
            {keys.map(k => (
              <div key={k.id} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                <div>
                  <p className="text-sm font-medium text-gray-800">{k.label}</p>
                  <p className="text-xs text-gray-400">
                    Created {new Date(k.created_at).toLocaleDateString()}
                    {k.last_used && ` · Last used ${new Date(k.last_used).toLocaleDateString()}`}
                  </p>
                </div>
                <button
                  onClick={() => revokeKey(k.id)}
                  className="text-xs text-red-500 hover:text-red-700"
                >
                  Revoke
                </button>
              </div>
            ))}
          </div>

          <div className="flex gap-2">
            <input
              value={newKeyLabel}
              onChange={e => setNewKeyLabel(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && createKey()}
              placeholder="Key label (e.g. claude-code)"
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <button
              onClick={createKey}
              className="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-700"
            >
              Create
            </button>
          </div>
        </section>

        {/* Debug */}
        <section className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-4">Debug</h2>
          <button
            onClick={triggerIngest}
            className="border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm hover:bg-gray-50"
          >
            Run ingestion now
          </button>
        </section>
      </main>
    </div>
  );
}
