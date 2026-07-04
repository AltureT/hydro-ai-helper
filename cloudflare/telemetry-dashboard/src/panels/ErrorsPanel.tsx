import { useState, useEffect } from 'react';
import { getErrors } from '../api';
import type { ErrorGroup } from '../types';

const CATEGORY_COLORS: Record<string, string> = {
  auth: '#ef4444',
  rate_limit: '#f59e0b',
  server: '#ef4444',
  timeout: '#d97706',
  network: '#6366f1',
  client: '#f97316',
  unknown: '#6b7280',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseMetadata(raw?: string): Record<string, any> | null {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

type ErrorSort = 'last_seen' | 'count' | 'instances';

const SORT_LABELS: Record<ErrorSort, string> = {
  last_seen: '最近出现',
  count: '总次数',
  instances: '影响实例数',
};

export function ErrorsPanel() {
  const [data, setData] = useState<ErrorGroup[]>([]);
  const [sort, setSort] = useState<ErrorSort>('last_seen');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getErrors(50, 0, sort)
      .then(r => setData(r.errors))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [sort]);

  if (loading) return <p style={{ color: '#6b7280' }}>加载中...</p>;
  if (error) return <p style={{ color: '#ef4444' }}>加载失败: {error}</p>;
  if (data.length === 0) return <p style={{ color: '#6b7280', textAlign: 'center', padding: 40 }}>暂无错误记录</p>;

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: '16px' }}>错误分诊 ({data.length})</h3>
        <select
          value={sort}
          onChange={e => setSort(e.target.value as ErrorSort)}
          style={{ marginLeft: 'auto', fontSize: '12px', padding: '4px 8px' }}
        >
          {(Object.keys(SORT_LABELS) as ErrorSort[]).map(s => (
            <option key={s} value={s}>按{SORT_LABELS[s]}排序</option>
          ))}
        </select>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {data.map(err => {
          const meta = parseMetadata(err.metadata);
          return (
            <div key={err.stack_fingerprint} style={rowStyle}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{
                  padding: '2px 8px', borderRadius: 4, fontSize: '11px', fontWeight: 600,
                  background: '#fef2f2', color: CATEGORY_COLORS[err.category] || '#6b7280',
                }}>
                  {err.category}
                </span>
                {err.error_type === 'api_degraded' && (
                  <span style={{
                    padding: '2px 8px', borderRadius: 4, fontSize: '11px', fontWeight: 600,
                    background: '#fefce8', color: '#ca8a04',
                  }}>
                    DEGRADED
                  </span>
                )}
                <span style={{ fontSize: '12px', color: '#6b7280' }}>{err.error_type}</span>
                <span style={{ marginLeft: 'auto', fontSize: '12px', color: '#6b7280' }}>
                  {new Date(err.last_seen).toLocaleString()}
                </span>
              </div>
              <div style={{ fontSize: '14px', fontWeight: 500, marginBottom: 6, wordBreak: 'break-word' }}>
                {err.message || '(无消息)'}
              </div>
              {meta && (
                <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: 6 }}>
                  {meta.endpointName && <span>端点: <strong style={{ color: '#1f2937' }}>{String(meta.endpointName)}</strong></span>}
                  {meta.modelName && <span style={{ marginLeft: 12 }}>模型: <strong style={{ color: '#1f2937' }}>{String(meta.modelName)}</strong></span>}
                  {meta.succeededOn && <span style={{ marginLeft: 12 }}>成功于: <strong style={{ color: '#16a34a' }}>{String(meta.succeededOn)}</strong></span>}
                  {typeof meta.retryAfterSec === 'number' && <span style={{ marginLeft: 12 }}>Retry-After: <strong style={{ color: '#dc2626' }}>{meta.retryAfterSec}s</strong></span>}
                  {Array.isArray(meta.attempts) && meta.attempts.length > 0 && (
                    <details style={{ marginTop: 4 }}>
                      <summary style={{ cursor: 'pointer' }}>Fallback chain ({meta.attempts.length} attempts)</summary>
                      <ul style={{ margin: '4px 0', paddingLeft: 20, fontSize: '11px' }}>
                        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                        {meta.attempts.map((a: any, i: number) => (
                          <li key={i}>
                            {a.endpoint}/{a.model}: {a.category}
                            {a.httpStatus ? ` (${a.httpStatus})` : ''}
                            {a.retryAfterSec ? ` retry=${a.retryAfterSec}s` : ''}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {meta.env && (meta.env.mongodb_version || meta.env.node_version) && (
                    <div style={{ marginTop: 4 }}>
                      {meta.env.mongodb_version && <span>MongoDB: <strong style={{ color: '#1f2937' }}>{String(meta.env.mongodb_version)}</strong></span>}
                      {meta.env.node_version && <span style={{ marginLeft: 12 }}>Node: <strong style={{ color: '#1f2937' }}>{String(meta.env.node_version)}</strong></span>}
                    </div>
                  )}
                  {Array.isArray(meta.stack_frames) && meta.stack_frames.length > 0 && (
                    <details style={{ marginTop: 4 }}>
                      <summary style={{ cursor: 'pointer' }}>脱敏堆栈 ({meta.stack_frames.length} 帧)</summary>
                      <pre style={{
                        margin: '4px 0', padding: '8px 10px', background: '#1f2937', color: '#e5e7eb',
                        borderRadius: 6, fontSize: '11px', lineHeight: 1.5, overflowX: 'auto', whiteSpace: 'pre',
                      }}>
                        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                        {meta.stack_frames.map((f: any) => String(f)).join('\n')}
                      </pre>
                    </details>
                  )}
                </div>
              )}
              <div style={{ display: 'flex', gap: 16, fontSize: '12px', color: '#6b7280', flexWrap: 'wrap' }}>
                {err.versions && <span>版本: <strong style={{ color: '#1f2937' }}>{err.versions}</strong></span>}
                <span>影响实例: <strong style={{ color: '#1f2937' }}>{err.affected_instances}</strong></span>
                <span>总次数: <strong style={{ color: '#ef4444' }}>{err.total_count}</strong></span>
                <span>指纹: <code style={{ fontSize: '11px' }}>{err.stack_fingerprint}</code></span>
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
  padding: '14px 16px', background: '#fafafa', borderRadius: 8,
  border: '1px solid #f3f4f6',
};
