import { useEffect, useState } from 'react';
import Login from './pages/Login.js';
import Search from './pages/Search.js';
import SMODetail from './pages/SMODetail.js';
import Settings from './pages/Settings.js';
import { api } from './lib/api.js';

function getPage(): string {
  const path = window.location.pathname;
  if (path === '/' || path === '') return 'login';
  if (path === '/search') return 'search';
  if (path.startsWith('/smo/')) return 'smo';
  if (path === '/settings') return 'settings';
  return 'login';
}

export default function App() {
  const [page, setPage] = useState(getPage);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    const currentPage = getPage();
    if (currentPage === 'login') { setAuthChecked(true); return; }

    // Check auth for protected pages
    api.auth.me()
      .then(user => {
        if (!user) window.location.href = '/';
        else setAuthChecked(true);
      })
      .catch(() => { window.location.href = '/'; });
  }, []);

  useEffect(() => {
    const handler = () => setPage(getPage());
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, []);

  if (!authChecked && page !== 'login') {
    return <div className="min-h-screen bg-gray-50" />;
  }

  if (page === 'search') return <Search />;
  if (page === 'smo') return <SMODetail />;
  if (page === 'settings') return <Settings />;
  return <Login />;
}
