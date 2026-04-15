import { useState, useEffect, useMemo } from 'react';
import { getFeedback } from '../api';
import type { FeedbackItem } from '../types';

const TYPE_LABELS: Record<string, { text: string; bg: string; color: string }> = {
  bug: { text: 'Bug', bg: '#fef2f2', color: '#ef4444' },
  feature: { text: '功能', bg: '#eff6ff', color: '#2563eb' },
  other: { text: '其他', bg: '#f3f4f6', color: '#6b7280' },
};

function isTeachingSummaryFeedback(fb: FeedbackItem): boolean {
  return fb.subject === 'teaching_summary_up' || fb.subject === 'teaching_summary_down';
}

// ─── Teaching summary feedback stats card ───────────────────────────────────

function TeachingSummaryStats({ items }: { items: FeedbackItem[] }) {
  if (items.length === 0) return null;

  const upCount = items.filter(fb => fb.subject === 'teaching_summary_up').length;
  const downCount = items.filter(fb => fb.subject === 'teaching_summary_down').length;
  const total = upCount + downCount;
  const upPct = total > 0 ? Math.round((upCount / total) * 100) : 0;

  // Group by instance for per-instance breakdown
  const byInstance = new Map<string, { up: number; down: number; version: string; lastAt: string }>();
  for (const fb of items) {
    const key = fb.instance_id;
    const entry = byInstance.get(key) || { up: 0, down: 0, version: fb.version, lastAt: fb.received_at };
    if (fb.subject === 'teaching_summary_up') entry.up++;
    else entry.down++;
    if (fb.received_at > entry.lastAt) {
      entry.lastAt = fb.received_at;
      entry.version = fb.version;
    }
    byInstance.set(key, entry);
  }

  return (
    <div style={{ ...cardStyle, marginBottom: 16 }}>
      <h3 style={{ margin: '0 0 16px', fontSize: '16px' }}>教学总结反馈</h3>

      {/* Stats row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 20, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: '28px' }}>{'\u{1F44D}'}</span>
          <div>
            <div style={{ fontSize: '24px', fontWeight: 700, color: '#16a34a' }}>{upCount}</div>
            <div style={{ fontSize: '12px', color: '#6b7280' }}>有帮助</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: '28px' }}>{'\u{1F44E}'}</span>
          <div>
            <div style={{ fontSize: '24px', fontWeight: 700, color: '#dc2626' }}>{downCount}</div>
            <div style={{ fontSize: '12px', color: '#6b7280' }}>没帮助</div>
          </div>
        </div>

        {/* Ratio bar */}
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#6b7280', marginBottom: 4 }}>
            <span>好评率</span>
            <span>{upPct}% ({total} 条评价)</span>
          </div>
          <div style={{
            height: 8, backgroundColor: total > 0 ? '#fee2e2' : '#f3f4f6',
            borderRadius: 4, overflow: 'hidden',
          }}>
            {total > 0 && (
              <div style={{
                width: `${upPct}%`, height: '100%',
                backgroundColor: '#16a34a', borderRadius: 4,
                transition: 'width 300ms ease',
              }} />
            )}
          </div>
        </div>
      </div>

      {/* Per-instance breakdown */}
      {byInstance.size > 1 && (
        <div style={{ borderTop: '1px solid #f3f4f6', paddingTop: 12 }}>
          <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: 8 }}>按实例分布</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {[...byInstance.entries()].map(([id, st]) => (
              <div key={id} style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: '13px' }}>
                <code style={{ color: '#6b7280' }}>...{id.slice(-8)}</code>
                <span style={{ color: '#16a34a' }}>{'\u{1F44D}'} {st.up}</span>
                <span style={{ color: '#dc2626' }}>{'\u{1F44E}'} {st.down}</span>
                <span style={{ color: '#9ca3af', fontSize: '12px' }}>v{st.version}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main panel ─────────────────────────────────────────────────────────────

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

  const { teachingSummaryItems, otherItems } = useMemo(() => {
    const ts: FeedbackItem[] = [];
    const other: FeedbackItem[] = [];
    for (const fb of data) {
      if (isTeachingSummaryFeedback(fb)) ts.push(fb);
      else other.push(fb);
    }
    return { teachingSummaryItems: ts, otherItems: other };
  }, [data]);

  if (loading) return <p style={{ color: '#6b7280' }}>加载中...</p>;
  if (error) return <p style={{ color: '#ef4444' }}>加载失败: {error}</p>;
  if (data.length === 0) return <p style={{ color: '#6b7280', textAlign: 'center', padding: 40 }}>暂无反馈</p>;

  return (
    <>
      {/* Teaching summary feedback — separated with visual stats */}
      <TeachingSummaryStats items={teachingSummaryItems} />

      {/* Other feedback items */}
      <div style={cardStyle}>
        <h3 style={{ margin: '0 0 16px', fontSize: '16px' }}>反馈收件箱 ({otherItems.length})</h3>
        {otherItems.length === 0 ? (
          <p style={{ color: '#6b7280', textAlign: 'center', padding: 20 }}>暂无其他反馈</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {otherItems.map(fb => {
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
        )}
      </div>
    </>
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
