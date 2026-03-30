import { useState, useEffect } from 'react';
import { getInstances } from '../api';
import type { Instance } from '../types';

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return '刚刚';
  if (hours < 24) return `${hours}h 前`;
  return `${Math.floor(hours / 24)}d 前`;
}

function healthBadge(instance: Instance): { text: string; bg: string; color: string } {
  const hoursSinceReport = (Date.now() - new Date(instance.last_report_at).getTime()) / 3600000;
  if (hoursSinceReport > 48) return { text: '离线', bg: '#fef2f2', color: '#ef4444' };
  if (instance.api_failure_count_24h > 10) return { text: '异常', bg: '#fffbeb', color: '#d97706' };
  return { text: '健康', bg: '#f0fdf4', color: '#16a34a' };
}

export function InstancesPanel() {
  const [data, setData] = useState<Instance[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getInstances()
      .then(r => setData(r.instances))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p style={{ color: '#6b7280' }}>加载中...</p>;
  if (error) return <p style={{ color: '#ef4444' }}>加载失败: {error}</p>;

  // Version distribution
  const versionMap = new Map<string, number>();
  for (const inst of data) {
    versionMap.set(inst.version, (versionMap.get(inst.version) || 0) + 1);
  }
  const versions = [...versionMap.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <div>
      {/* Version distribution */}
      <div style={{ ...cardStyle, marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: '16px' }}>版本分布</h3>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {versions.map(([ver, count]) => (
            <div key={ver} style={{ padding: '6px 12px', background: '#eff6ff', borderRadius: 20, fontSize: '13px' }}>
              <strong>v{ver}</strong> <span style={{ color: '#6b7280' }}>({count})</span>
            </div>
          ))}
        </div>
      </div>

      {/* Instance table */}
      <div style={cardStyle}>
        <h3 style={{ margin: '0 0 12px', fontSize: '16px' }}>实例列表 ({data.length})</h3>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
                {['实例 ID', '版本', '活跃用户', '对话数', '错误数', '最后上报', '状态'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: '#6b7280', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map(inst => {
                const badge = healthBadge(inst);
                return (
                  <tr key={inst.instance_id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={cellStyle}><code style={{ fontSize: '12px' }}>...{inst.instance_id.slice(-8)}</code></td>
                    <td style={cellStyle}>v{inst.version}</td>
                    <td style={cellStyle}>{inst.active_users_7d}</td>
                    <td style={cellStyle}>{inst.total_conversations}</td>
                    <td style={cellStyle}>
                      {inst.api_failure_count_24h > 0
                        ? <span style={{ color: '#ef4444', fontWeight: 600 }}>{inst.api_failure_count_24h}</span>
                        : '0'}
                    </td>
                    <td style={cellStyle}>{timeAgo(inst.last_report_at)}</td>
                    <td style={cellStyle}>
                      <span style={{ padding: '2px 8px', borderRadius: 12, fontSize: '12px', background: badge.bg, color: badge.color, fontWeight: 600 }}>
                        {badge.text}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  padding: '20px', background: '#fff', borderRadius: 12,
  boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
};
const cellStyle: React.CSSProperties = { padding: '10px 12px' };
