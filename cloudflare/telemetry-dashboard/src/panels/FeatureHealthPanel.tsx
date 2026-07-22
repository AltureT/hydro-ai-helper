import { useState, useEffect } from 'react';
import { getFeatureHealth } from '../api';
import type { FeatureHealth, FeatureUsage, ModelUsage } from '../types';

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

type HealthLevel = 'unknown' | 'critical' | 'warning' | 'healthy';

function healthLevel(f: FeatureHealth): HealthLevel {
  if (f.attempts === 0) return 'unknown';
  const rate = successRate(f);
  if ((f.attempts >= 5 && f.successes === 0) || (f.attempts >= 10 && rate < 0.5)) return 'critical';
  if (f.attempts >= 10 && rate < 0.8) return 'warning';
  return 'healthy';
}

function rateColor(f: FeatureHealth): string {
  const level = healthLevel(f);
  if (level === 'critical') return '#ef4444';
  if (level === 'warning') return '#f59e0b';
  if (level === 'healthy') return '#16a34a';
  return '#6b7280';
}

export function FeatureHealthPanel() {
  const [data, setData] = useState<FeatureHealth[]>([]);
  const [usage, setUsage] = useState<FeatureUsage[]>([]);
  const [modelUsage, setModelUsage] = useState<ModelUsage[]>([]);
  const [usageDays, setUsageDays] = useState<number>(30);
  const [snapshotMaxAgeHours, setSnapshotMaxAgeHours] = useState(48);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getFeatureHealth(usageDays)
      .then(r => {
        setData(r.features);
        setUsage(r.usage || []);
        setModelUsage(r.model_usage || []);
        setSnapshotMaxAgeHours(r.snapshot_max_age_hours ?? 48);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [usageDays]);

  if (loading) return <p style={{ color: '#6b7280' }}>加载中...</p>;
  if (error) return <p style={{ color: '#ef4444' }}>加载失败: {error}</p>;
  if (data.length === 0 && usage.length === 0 && modelUsage.length === 0) {
    return <p style={{ color: '#6b7280', textAlign: 'center', padding: 40 }}>暂无功能健康数据（需安装新版插件的实例上报后出现）</p>;
  }

  const criticalCount = data.filter(f => healthLevel(f) === 'critical').length;
  const warningCount = data.filter(f => healthLevel(f) === 'warning').length;

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
      <h3 style={{ margin: '0 0 4px', fontSize: '16px' }}>场景模型效果</h3>
      <p style={{ margin: '0 0 12px', fontSize: '12px', color: '#6b7280' }}>
        使用与上方相同的时间窗口；统计完整业务请求的成功率。至少 10 次请求后才给出能力判断，避免小样本误导。
      </p>
      {modelUsage.length === 0 ? (
        <p style={{ color: '#6b7280', fontSize: '13px' }}>暂无成功侧模型数据（需新版插件上报，且平台已应用 migration 0009）</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
          <thead>
            <tr style={{ textAlign: 'left', color: '#6b7280', fontSize: '12px' }}>
              <th style={thStyle}>场景</th>
              <th style={thStyle}>模型</th>
              <th style={thStyle}>成功率</th>
              <th style={thStyle}>成功/尝试</th>
              <th style={thStyle}>实例数</th>
              <th style={thStyle}>判断</th>
            </tr>
          </thead>
          <tbody>
            {modelUsage.map(item => {
              const attempts = Number(item.total_attempts) || 0;
              const successes = Number(item.total_successes) || 0;
              const rate = attempts > 0 ? successes / attempts : 0;
              const enoughSamples = attempts >= 10;
              const capabilityConcern = enoughSamples && rate < 0.7;
              return (
                <tr key={`${item.scenario}:${item.model_name}`} style={{ borderTop: '1px solid #f3f4f6' }}>
                  <td style={tdStyle}>{FEATURE_LABELS[item.scenario] || item.scenario}</td>
                  <td style={tdStyle}><code style={{ fontSize: '12px' }}>{item.model_name}</code></td>
                  <td style={{ ...tdStyle, fontWeight: 700, color: capabilityConcern ? '#dc2626' : enoughSamples ? '#16a34a' : '#6b7280' }}>
                    {(rate * 100).toFixed(1)}%
                  </td>
                  <td style={tdStyle}>{successes}/{attempts}</td>
                  <td style={tdStyle}>{item.instances}</td>
                  <td style={{ ...tdStyle, color: capabilityConcern ? '#dc2626' : '#6b7280' }}>
                    {capabilityConcern
                      ? '能力可能不足，建议改用思考能力更深的模型'
                      : enoughSamples ? '当前表现稳定' : '样本不足'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
    <div style={cardStyle}>
      <h3 style={{ margin: '0 0 4px', fontSize: '16px' }}>功能健康 ({data.length})</h3>
      <p style={{ margin: '0 0 6px', fontSize: '12px', color: criticalCount > 0 ? '#ef4444' : warningCount > 0 ? '#d97706' : '#6b7280' }}>
        {criticalCount > 0
          ? `⚠ ${criticalCount} 个功能严重降级${warningCount > 0 ? `，另有 ${warningCount} 个功能降级` : ''}`
          : warningCount > 0
            ? `⚠ ${warningCount} 个功能成功率低于 80%`
            : '当前活跃实例未发现功能降级'}
      </p>
      <p style={{ margin: '0 0 16px', fontSize: '12px', color: '#6b7280' }}>
        这是各实例最新上报日快照，仅纳入最近 {snapshotMaxAgeHours} 小时仍有心跳的实例；累计趋势请查看上方“累计用量”。
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {data.map(f => {
          const level = healthLevel(f);
          const rate = successRate(f);
          const failed = Math.max(0, f.attempts - f.successes);
          return (
            <div key={f.feature} style={{
              ...rowStyle,
              ...(level === 'critical' ? { borderColor: '#fecaca', background: '#fef2f2' } : {}),
              ...(level === 'warning' ? { borderColor: '#fde68a', background: '#fffbeb' } : {}),
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: '14px', fontWeight: 600 }}>
                  {FEATURE_LABELS[f.feature] || f.feature}
                </span>
                <code style={{ fontSize: '11px', color: '#6b7280' }}>{f.feature}</code>
                {(level === 'critical' || level === 'warning') && (
                  <span style={{
                    padding: '2px 8px', borderRadius: 4, fontSize: '11px', fontWeight: 700,
                    background: level === 'critical' ? '#fee2e2' : '#fef3c7',
                    color: level === 'critical' ? '#b91c1c' : '#b45309',
                  }}>
                    {level === 'critical' ? '严重降级' : '降级'}
                  </span>
                )}
                <span style={{ marginLeft: 'auto', fontSize: '13px', fontWeight: 600, color: rateColor(f) }}>
                  {f.attempts === 0 ? '无尝试' : `成功率 ${(rate * 100).toFixed(0)}%`}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 16, fontSize: '12px', color: '#6b7280', flexWrap: 'wrap' }}>
                <span>尝试: <strong style={{ color: '#1f2937' }}>{f.attempts}</strong></span>
                <span>成功: <strong style={{ color: '#16a34a' }}>{f.successes}</strong></span>
                <span>失败: <strong style={{ color: failed > 0 ? '#dc2626' : '#1f2937' }}>{failed}</strong></span>
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
