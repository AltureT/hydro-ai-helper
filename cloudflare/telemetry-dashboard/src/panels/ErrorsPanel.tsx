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
  testdata_gen: '#dc2626',
};

interface ErrorAttempt {
  endpoint?: string;
  model?: string;
  category?: string;
  httpStatus?: number;
  retryAfterSec?: number;
}

interface ErrorMetadata {
  endpointName?: string;
  modelName?: string;
  succeededOn?: string;
  retryAfterSec?: number;
  attempts?: ErrorAttempt[];
  env?: { mongodb_version?: string; node_version?: string };
  stack_frames?: string[];
  failureStage?: string;
  aiAttemptCount?: number;
  usedModels?: string[];
}

function parseMetadata(raw?: string): ErrorMetadata | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as ErrorMetadata; } catch { return null; }
}

type ErrorSort = 'last_seen' | 'count' | 'instances';

const SORT_LABELS: Record<ErrorSort, string> = {
  last_seen: '最近出现',
  count: '总次数',
  instances: '影响实例数',
};

const STAGE_LABELS: Record<string, string> = {
  blueprint_parse: '蓝图解析',
  generator: '生成器',
  validator: '输入校验',
  oracle: '标程',
  brute: '暴力对拍',
  'template-py': '函数模板',
  full: '完整验证',
};

const PAGE_SIZE = 25;

export function ErrorsPanel() {
  const [data, setData] = useState<ErrorGroup[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<ErrorSort>('last_seen');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError('');
    getErrors(PAGE_SIZE, offset, sort)
      .then(r => {
        setData(r.errors);
        setTotal(r.total ?? r.errors.length);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [sort, offset]);

  if (loading) return <p style={{ color: '#6b7280' }}>加载中...</p>;
  if (error) return <p style={{ color: '#ef4444' }}>加载失败: {error}</p>;
  if (data.length === 0) return <p style={{ color: '#6b7280', textAlign: 'center', padding: 40 }}>暂无错误记录</p>;

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: '16px' }}>错误分诊 ({total})</h3>
        <span style={{ marginLeft: 12, fontSize: '12px', color: '#6b7280' }}>
          {total === 0 ? 0 : offset + 1}-{Math.min(offset + data.length, total)} / {total}
        </span>
        <select
          value={sort}
          onChange={e => {
            setSort(e.target.value as ErrorSort);
            setOffset(0);
          }}
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
          const message = err.message || '(无消息)';
          const longMessage = message.length > 360;
          const stage = typeof meta?.failureStage === 'string' ? meta.failureStage : '';
          return (
            <div key={`${err.stack_fingerprint}:${err.error_type}:${err.category}`} style={rowStyle}>
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
                {longMessage ? `${message.slice(0, 360)}…` : message}
              </div>
              {longMessage && (
                <details style={{ margin: '0 0 8px', fontSize: '12px' }}>
                  <summary style={{ cursor: 'pointer', color: '#2563eb' }}>展开完整技术细节</summary>
                  <pre style={messageDetailStyle}>{message}</pre>
                </details>
              )}
              {meta && (
                <div style={{ fontSize: '12px', color: '#6b7280', marginBottom: 6 }}>
                  {stage && (
                    <span style={stageBadgeStyle}>阶段: {STAGE_LABELS[stage] || stage}</span>
                  )}
                  {meta.endpointName && <span>端点: <strong style={{ color: '#1f2937' }}>{String(meta.endpointName)}</strong></span>}
                  {meta.modelName && <span style={{ marginLeft: 12 }}>模型: <strong style={{ color: '#1f2937' }}>{String(meta.modelName)}</strong></span>}
                  {typeof meta.aiAttemptCount === 'number' && (
                    <span style={{ marginLeft: 12 }}>AI 尝试: <strong style={{ color: '#1f2937' }}>{meta.aiAttemptCount}</strong></span>
                  )}
                  {meta.succeededOn && <span style={{ marginLeft: 12 }}>成功于: <strong style={{ color: '#16a34a' }}>{String(meta.succeededOn)}</strong></span>}
                  {typeof meta.retryAfterSec === 'number' && <span style={{ marginLeft: 12 }}>Retry-After: <strong style={{ color: '#dc2626' }}>{meta.retryAfterSec}s</strong></span>}
                  {Array.isArray(meta.usedModels) && meta.usedModels.length > 0 && (
                    <div style={{ marginTop: 4 }}>涉及模型: {meta.usedModels.map(String).join(' → ')}</div>
                  )}
                  {Array.isArray(meta.attempts) && meta.attempts.length > 0 && (
                    <details style={{ marginTop: 4 }}>
                      <summary style={{ cursor: 'pointer' }}>Fallback chain ({meta.attempts.length} attempts)</summary>
                      <ul style={{ margin: '4px 0', paddingLeft: 20, fontSize: '11px' }}>
                        {meta.attempts.map((a, i: number) => (
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
                        {meta.stack_frames.map(f => String(f)).join('\n')}
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
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button
          style={pagerButtonStyle}
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
        >
          上一页
        </button>
        <button
          style={pagerButtonStyle}
          disabled={offset + PAGE_SIZE >= total}
          onClick={() => setOffset(offset + PAGE_SIZE)}
        >
          下一页
        </button>
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
const stageBadgeStyle: React.CSSProperties = {
  display: 'inline-block', marginRight: 12, padding: '2px 8px', borderRadius: 4,
  background: '#eff6ff', color: '#1d4ed8', fontWeight: 600,
};
const messageDetailStyle: React.CSSProperties = {
  margin: '6px 0 0', padding: '8px 10px', maxHeight: 260, overflow: 'auto',
  whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: '#f3f4f6',
  borderRadius: 6, color: '#374151', fontSize: '11px', lineHeight: 1.5,
};
const pagerButtonStyle: React.CSSProperties = {
  padding: '6px 12px', border: '1px solid #d1d5db', borderRadius: 6,
  background: '#fff', color: '#374151', fontSize: '12px', cursor: 'pointer',
};
