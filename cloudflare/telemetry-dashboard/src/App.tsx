import { useState, useEffect } from 'react';
import { configure } from './api';
import { OverviewPanel } from './panels/OverviewPanel';
import { InstancesPanel } from './panels/InstancesPanel';
import { ErrorsPanel } from './panels/ErrorsPanel';
import { FeedbackPanel } from './panels/FeedbackPanel';
import type { Tab } from './types';

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: '概览' },
  { key: 'instances', label: '实例' },
  { key: 'errors', label: '错误' },
  { key: 'feedback', label: '反馈' },
];

export function App() {
  const [tab, setTab] = useState<Tab>('overview');
  const [configured, setConfigured] = useState(false);
  const [apiBase, setApiBase] = useState(localStorage.getItem('dashboard_api_base') || '');
  const [token, setToken] = useState(localStorage.getItem('dashboard_token') || '');

  useEffect(() => {
    if (apiBase) {
      configure(apiBase, token);
      setConfigured(true);
    }
  }, [apiBase, token]);

  if (!configured) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <h1 style={styles.title}>Hydro AI Helper Dashboard</h1>
          <p style={styles.subtitle}>配置 API 端点以查看遥测数据</p>
          <div style={styles.form}>
            <label style={styles.label}>
              API Base URL
              <input
                style={styles.input}
                value={apiBase}
                onChange={e => setApiBase(e.target.value)}
                placeholder="https://stats.how2learns.com"
              />
            </label>
            <label style={styles.label}>
              Dashboard Token
              <input
                style={styles.input}
                type="password"
                value={token}
                onChange={e => setToken(e.target.value)}
                placeholder="可选"
              />
            </label>
            <button
              style={styles.button}
              onClick={() => {
                localStorage.setItem('dashboard_api_base', apiBase);
                localStorage.setItem('dashboard_token', token);
                configure(apiBase, token);
                setConfigured(true);
              }}
              disabled={!apiBase.trim()}
            >
              连接
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <h1 style={{ margin: 0, fontSize: '20px' }}>Hydro AI Helper</h1>
        <nav style={styles.nav}>
          {TABS.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                ...styles.tab,
                ...(tab === t.key ? styles.tabActive : {}),
              }}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <button
          style={{ ...styles.tab, marginLeft: 'auto', color: '#ef4444' }}
          onClick={() => {
            localStorage.removeItem('dashboard_api_base');
            localStorage.removeItem('dashboard_token');
            setConfigured(false);
            setApiBase('');
            setToken('');
          }}
        >
          断开
        </button>
      </header>

      <main style={styles.main}>
        {tab === 'overview' && <OverviewPanel />}
        {tab === 'instances' && <InstancesPanel />}
        {tab === 'errors' && <ErrorsPanel />}
        {tab === 'feedback' && <FeedbackPanel />}
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 1200, margin: '0 auto', padding: '20px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: '#1f2937', background: '#f9fafb', minHeight: '100vh',
  },
  card: {
    maxWidth: 480, margin: '80px auto', padding: '32px',
    background: '#fff', borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
  },
  title: { margin: '0 0 8px', fontSize: '24px', fontWeight: 700 },
  subtitle: { margin: '0 0 24px', color: '#6b7280', fontSize: '14px' },
  form: { display: 'flex', flexDirection: 'column' as const, gap: 16 },
  label: { display: 'flex', flexDirection: 'column' as const, gap: 6, fontSize: '14px', fontWeight: 500 },
  input: {
    padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8,
    fontSize: '14px', outline: 'none',
  },
  button: {
    padding: '10px 20px', background: '#2563eb', color: '#fff', border: 'none',
    borderRadius: 8, fontSize: '14px', fontWeight: 600, cursor: 'pointer',
  },
  header: {
    display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24,
    padding: '16px 20px', background: '#fff', borderRadius: 12,
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
  },
  nav: { display: 'flex', gap: 4 },
  tab: {
    padding: '8px 16px', border: 'none', borderRadius: 8,
    fontSize: '14px', fontWeight: 500, cursor: 'pointer',
    background: 'transparent', color: '#6b7280',
  },
  tabActive: { background: '#eff6ff', color: '#2563eb' },
  main: {},
};
