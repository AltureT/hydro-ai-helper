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

  const fmtMs = (ms: number | null) => (ms == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`);
  const latencyColor = (ms: number | null) => (ms == null ? '#6b7280' : ms > 10000 ? '#ef4444' : ms > 5000 ? '#d97706' : '#059669');

  const cards: { label: string; value: string | number; color: string }[] = [
    { label: '部署实例（90天内上报）', value: data.instances, color: '#2563eb' },
    { label: `当前上报实例（${data.health_freshness_hours ?? 48}h）`, value: data.reporting_instances ?? '—', color: '#2563eb' },
    { label: '活跃用户 (7天)', value: data.active_users_7d, color: '#059669' },
    // 30/90 天窗口：学生寒暑假后返校仍计入活跃，避免假期把统计清零
    { label: '活跃用户 (30天)', value: data.active_users_30d ?? '—', color: '#059669' },
    { label: '活跃用户 (90天)', value: data.active_users_90d ?? '—', color: '#059669' },
    { label: '累计对话数（90天内上报实例）', value: data.total_conversations.toLocaleString(), color: '#7c3aed' },
    { label: `AI 接口错误率（${data.api_metric_window_hours ?? 24}h）`, value: `${data.error_rate_percent}%`, color: data.error_rate_percent > 5 ? '#ef4444' : '#059669' },
    { label: `AI 延迟 P50（${data.api_metric_window_hours ?? 24}h）`, value: fmtMs(data.latency_p50_ms), color: latencyColor(data.latency_p50_ms) },
    { label: `AI 延迟 P95（${data.api_metric_window_hours ?? 24}h）`, value: fmtMs(data.latency_p95_ms), color: latencyColor(data.latency_p95_ms) },
    { label: `AI 延迟 P99（${data.api_metric_window_hours ?? 24}h）`, value: fmtMs(data.latency_p99_ms), color: latencyColor(data.latency_p99_ms) },
  ];

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
        {cards.map(c => (
          <div key={c.label} style={cardStyle}>
            <div style={{ fontSize: '13px', color: '#6b7280', marginBottom: 8 }}>{c.label}</div>
            <div style={{ fontSize: '32px', fontWeight: 700, color: c.color }}>{c.value}</div>
          </div>
        ))}
      </div>
      <p style={{ margin: '12px 4px 0', color: '#6b7280', fontSize: '12px' }}>
        AI 接口错误率只统计模型端点请求失败；生成结果未通过沙箱等业务失败请查看“功能健康”和“错误”页。
        延迟与错误率仅合并最近 {data.health_freshness_hours ?? 48} 小时仍有心跳实例的最新日快照。
      </p>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  padding: '24px', background: '#fff', borderRadius: 12,
  boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
};
