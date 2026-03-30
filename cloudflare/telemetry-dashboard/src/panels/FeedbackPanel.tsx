import { useState, useEffect } from 'react';
import { getFeedback } from '../api';
import type { FeedbackItem } from '../types';

const TYPE_LABELS: Record<string, { text: string; bg: string; color: string }> = {
  bug: { text: 'Bug', bg: '#fef2f2', color: '#ef4444' },
  feature: { text: '功能', bg: '#eff6ff', color: '#2563eb' },
  other: { text: '其他', bg: '#f3f4f6', color: '#6b7280' },
};

export function FeedbackPanel() {
  const [data, setData] = useState<FeedbackItem[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getFeedback()
      .then(r => setData(r.feedback))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p style={{ color: '#6b7280' }}>加载中...</p>;
  if (error) return <p style={{ color: '#ef4444' }}>加载失败: {error}</p>;
  if (data.length === 0) return <p style={{ color: '#6b7280', textAlign: 'center', padding: 40 }}>暂无反馈</p>;

  return (
    <div style={cardStyle}>
      <h3 style={{ margin: '0 0 16px', fontSize: '16px' }}>反馈收件箱 ({data.length})</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {data.map(fb => {
          const badge = TYPE_LABELS[fb.type] || TYPE_LABELS.other;
          return (
            <div key={fb.id} style={rowStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{
                  padding: '2px 10px', borderRadius: 12, fontSize: '12px',
                  fontWeight: 600, background: badge.bg, color: badge.color,
                }}>
                  {badge.text}
                </span>
                <span style={{ fontWeight: 600, fontSize: '15px' }}>{fb.subject}</span>
                <span style={{ marginLeft: 'auto', fontSize: '12px', color: '#6b7280' }}>
                  {new Date(fb.received_at).toLocaleString()}
                </span>
              </div>
              {fb.body && (
                <p style={{ margin: '0 0 8px', fontSize: '14px', color: '#374151', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                  {fb.body}
                </p>
              )}
              <div style={{ display: 'flex', gap: 16, fontSize: '12px', color: '#6b7280' }}>
                <span>实例: <code>...{fb.instance_id.slice(-8)}</code></span>
                <span>v{fb.version}</span>
                {fb.contact_email && <span>联系: {fb.contact_email}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  padding: '20px', background: '#fff', borderRadius: 12,
  boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
};
const rowStyle: React.CSSProperties = {
  padding: '16px', background: '#fafafa', borderRadius: 8,
  border: '1px solid #f3f4f6',
};
