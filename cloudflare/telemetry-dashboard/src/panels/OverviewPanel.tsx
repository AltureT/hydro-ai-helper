import { useState, useEffect } from 'react';
import { getOverview } from '../api';
import type { Overview } from '../types';

export function OverviewPanel() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getOverview()
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p style={{ color: '#6b7280' }}>加载中...</p>;
  if (error) return <p style={{ color: '#ef4444' }}>加载失败: {error}</p>;
  if (!data) return null;

  const cards: { label: string; value: string | number; color: string }[] = [
    { label: '部署实例', value: data.instances, color: '#2563eb' },
    { label: '活跃用户 (7天)', value: data.active_users_7d, color: '#059669' },
    { label: '总对话数', value: data.total_conversations.toLocaleString(), color: '#7c3aed' },
    { label: 'API 错误率', value: `${data.error_rate_percent}%`, color: data.error_rate_percent > 5 ? '#ef4444' : '#059669' },
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
      {cards.map(c => (
        <div key={c.label} style={cardStyle}>
          <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: 8 }}>{c.label}</div>
          <div style={{ fontSize: '32px', fontWeight: 700, color: c.color }}>{c.value}</div>
        </div>
      ))}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  padding: '24px', background: '#fff', borderRadius: 12,
  boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
};
