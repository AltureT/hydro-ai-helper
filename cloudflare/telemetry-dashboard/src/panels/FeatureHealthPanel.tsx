import { useState, useEffect } from 'react';
import { getFeatureHealth } from '../api';
import type { FeatureHealth, FeatureUsage } from '../types';

const FEATURE_LABELS: Record<string, string> = {
  effectiveness_analyze: '效果分析（即时）',
  effectiveness_backfill: '效果回填（延迟）',
  batch_summary: '学生报告（批量总结）',
  teaching_summary: '教学分析',
  student_chat: '学生对话',
  testdata_generation: '测试数据生成',
  testdata_apply: '测试数据写入',
  testdata_skeleton: '测试数据骨架',
};

const USAGE_WINDOWS = [7, 30, 90, 0] as const; // 0 = 全部保留期(400天)

function successRate(f: FeatureHealth): number {
  if (f.attempts <= 0) return 1;
  return f.successes / f.attempts;
}

// A feature is "down" when instances attempted it but produced zero successes —
// the outage the aggregate error rate hides.
function isDown(f: FeatureHealth): boolean {
  return f.attempts > 0 && f.successes === 0;
}

function rateColor(f: FeatureHealth): string {
  if (f.attempts === 0) return '#6b7280';
  const r = successRate(f);
  if (r === 0) return '#ef4444';
  if (r < 0.8) return '#f59e0b';
  return '#16a34a';
}

export function FeatureHealthPanel() {
  const [data, setData] = useState<FeatureHealth[]>([]);
  const [usage, setUsage] = useState<FeatureUsage[]>([]);
  const [usageDays, setUsageDays] = useState<number>(30);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getFeatureHealth(usageDays)
      .then(r => { setData(r.features); setUsage(r.usage || []); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [usageDays]);

  if (loading) return <p style={{ color: '#6b7280' }}>加载中...</p>;
  if (error) return <p style={{ color: '#ef4444' }}>加载失败: {error}</p>;
  if (data.length === 0 && usage.length === 0) {
    return <p style={{ color: '#6b7280', textAlign: 'center', padding: 40 }}>暂无功能健康数据（需安装新版插件的实例上报后出现）</p>;
  }

  const downCount = data.filter(isDown).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 4 }}>
        <h3 style={{ margin: 0, fontSize: '16px' }}>累计用量</h3>
        <select
          value={usageDays}
          onChange={e => setUsageDays(parseInt(e.target.value, 10))}
          style={{ marginLeft: 'auto', fontSize: '12px', padding: '4px 8px' }}
        >
          {USAGE_WINDOWS.map(w => (
            <option key={w} value={w}>{w === 0 ? '全部（400天内）' : `近 ${w} 天`}</option>
          ))}
        </select>
      </div>
      <p style={{ margin: '0 0 12px', fontSize: '12px', color: '#6b7280' }}>
        跨实例按日累计（成功次数为准）；对话总量另见概览页的累计对话数
      </p>
      {usage.length === 0 ? (
        <p style={{ color: '#6b7280', fontSize: '13px' }}>暂无按日用量数据（需 v2.5.1+ 插件上报，且平台已应用 migration 0008）</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#6b7280', fontSize: '12px' }}>
              <th style={thStyle}>功能</th>
              <th style={thStyle}>成功次数</th>
              <th style={thStyle}>尝试次数</th>
              <th style={thStyle}>实例数</th>
              <th style={thStyle}>数据区间</th>
            </tr>
          </thead>
          <tbody>
            {usage.map(u => (
              <tr key={u.feature} style={{ borderTop: '1px solid #f3f4f6' }}>
                <td style={tdStyle}>
                  {FEATURE_LABELS[u.feature] || u.feature}
                  <code style={{ fontSize: '11px', color: '#9ca3af', marginLeft: 6 }}>{u.feature}</code>
                </td>
                <td style={{ ...tdStyle, fontWeight: 600, color: '#16a34a' }}>{u.total_successes}</td>
                <td style={tdStyle}>{u.total_attempts}</td>
                <td style={tdStyle}>{u.instances}</td>
                <td style={{ ...tdStyle, color: '#6b7280', fontSize: '12px' }}>{u.since || '?'} ~ {u.until || '?'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
    <div style={cardStyle}>
      <h3 style={{ margin: '0 0 4px', fontSize: '16px' }}>功能健康 ({data.length})</h3>
      <p style={{ margin: '0 0 16px', fontSize: '12px', color: downCount > 0 ? '#ef4444' : '#6b7280' }}>
        {downCount > 0
          ? `⚠ ${downCount} 个功能疑似瘫痪（有尝试但零成功）`
          : '所有上报功能均有成功记录'}
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {data.map(f => {
          const down = isDown(f);
          const rate = successRate(f);
          return (
            <div key={f.feature} style={{ ...rowStyle, ...(down ? { borderColor: '#fecaca', background: '#fef2f2' } : {}) }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: '14px', fontWeight: 600 }}>
                  {FEATURE_LABELS[f.feature] || f.feature}
                </span>
                <code style={{ fontSize: '11px', color: '#6b7280' }}>{f.feature}</code>
                {down && (
                  <span style={{
                    padding: '2px 8px', borderRadius: 4, fontSize: '11px', fontWeight: 700,
                    background: '#fee2e2', color: '#b91c1c',
                  }}>
                    瘫痪
                  </span>
                )}
                <span style={{ marginLeft: 'auto', fontSize: '13px', fontWeight: 600, color: rateColor(f) }}>
                  {f.attempts === 0 ? '无尝试' : `成功率 ${(rate * 100).toFixed(0)}%`}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 16, fontSize: '12px', color: '#6b7280', flexWrap: 'wrap' }}>
                <span>尝试: <strong style={{ color: '#1f2937' }}>{f.attempts}</strong></span>
                <span>成功: <strong style={{ color: '#16a34a' }}>{f.successes}</strong></span>
                <span>上报实例: <strong style={{ color: '#1f2937' }}>{f.reporting_instances}</strong></span>
                {f.broken_instances > 0 && (
                  <span>瘫痪实例: <strong style={{ color: '#ef4444' }}>{f.broken_instances}</strong></span>
                )}
                <span>最近成功: <strong style={{ color: '#1f2937' }}>
                  {f.last_success_at ? new Date(f.last_success_at).toLocaleString() : '从未'}
                </strong></span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
    </div>
  );
}

const thStyle: React.CSSProperties = { padding: '6px 8px' };
const tdStyle: React.CSSProperties = { padding: '8px' };

const cardStyle: React.CSSProperties = {
  padding: '20px', background: '#fff', borderRadius: 12,
  boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
};
const rowStyle: React.CSSProperties = {
  padding: '14px 16px', background: '#fafafa', borderRadius: 8,
  border: '1px solid #f3f4f6',
};
