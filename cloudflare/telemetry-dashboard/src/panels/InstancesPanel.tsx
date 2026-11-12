import { useState, useEffect } from 'react';
import { getInstances } from '../api';
import type { Instance, InstanceStatus, InstanceStatusFilter, VersionDistribution } from '../types';

const PAGE_SIZE = 25;

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const hours = Math.floor(diff / 3600000);
  if (hours < 1) return '刚刚';
  if (hours < 24) return `${hours}h 前`;
  return `${Math.floor(hours / 24)}d 前`;
}

const STATUS_TABS: { key: InstanceStatusFilter; label: string; hint: string }[] = [
  { key: 'active', label: '在线', hint: '最近仍有心跳的实例' },
  { key: 'stale', label: '已停报', hint: '曾正常上报但已停止；重置数据库的站点会以新 ID 继续上报，旧 ID 留在这里' },
  { key: 'one_shot', label: '仅安装', hint: '只在安装后一天内上报过：试装、临时容器或被重置的数据库' },
  { key: 'all', label: '全部', hint: '90 天内上报过的所有实例 ID' },
];

function healthBadge(instance: Instance): { text: string; bg: string; color: string } {
  if (instance.status === 'one_shot') return { text: '仅安装', bg: '#f3f4f6', color: '#6b7280' };
  if (instance.status === 'stale') return { text: '已停报', bg: '#f3f4f6', color: '#6b7280' };
  const daysSinceReport = (Date.now() - new Date(instance.last_report_at).getTime()) / 86400000;
  if (!instance.status && daysSinceReport > 3) return { text: '离线', bg: '#fef2f2', color: '#ef4444' };
  if ((instance.degraded_features || 0) > 0) return { text: '功能降级', bg: '#fef2f2', color: '#dc2626' };
  if (instance.api_failure_count_24h > 10) return { text: 'API 异常', bg: '#fffbeb', color: '#d97706' };
  return { text: '健康', bg: '#f0fdf4', color: '#16a34a' };
}

export function InstancesPanel() {
  const [data, setData] = useState<Instance[]>([]);
  const [versions, setVersions] = useState<VersionDistribution[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState<InstanceStatusFilter>('active');
  const [statusCounts, setStatusCounts] = useState<Record<InstanceStatus, number> | null>(null);
  const [aliveHours, setAliveHours] = useState(72);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getInstances(PAGE_SIZE, offset, status)
      .then(r => {
        setData(r.instances);
        setVersions(r.version_distribution || []);
        setTotal(r.total ?? r.instances.length);
        setStatusCounts(r.status_counts ?? null);
        if (r.alive_hours) setAliveHours(r.alive_hours);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [offset, status]);

  const countFor = (key: InstanceStatusFilter) => {
    if (!statusCounts) return null;
    if (key === 'all') return statusCounts.active + statusCounts.stale + statusCounts.one_shot;
    return statusCounts[key];
  };
  const activeTab = STATUS_TABS.find(t => t.key === status)!;

  if (loading) return <p style={{ color: '#6b7280' }}>加载中...</p>;
  if (error) return <p style={{ color: '#ef4444' }}>加载失败: {error}</p>;

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + data.length, total);

  return (
    <div>
      {/* Version distribution */}
      <div style={{ ...cardStyle, marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 12px', fontSize: '16px' }}>版本分布（{activeTab.label}）</h3>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {versions.map(item => (
            <div key={item.version} style={{ padding: '6px 12px', background: '#eff6ff', borderRadius: 20, fontSize: '13px' }}>
              <strong>v{item.version}</strong> <span style={{ color: '#6b7280' }}>({item.count})</span>
            </div>
          ))}
        </div>
      </div>

      {/* Instance table */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: '16px' }}>实例列表 ({total})</h3>
          <span style={{ marginLeft: 'auto', fontSize: '12px', color: '#6b7280' }}>
            {pageStart}-{pageEnd} / {total}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          {STATUS_TABS.map(tab => {
            const n = countFor(tab.key);
            const selected = tab.key === status;
            return (
              <button
                key={tab.key}
                aria-pressed={selected}
                onClick={() => { setStatus(tab.key); setOffset(0); }}
                style={{
                  ...pagerButtonStyle,
                  background: selected ? '#eff6ff' : '#fff',
                  borderColor: selected ? '#2563eb' : '#d1d5db',
                  color: selected ? '#2563eb' : '#374151',
                  fontWeight: selected ? 600 : 400,
                }}
              >
                {tab.label}{n != null ? ` (${n})` : ''}
              </button>
            );
          })}
        </div>
        <p style={{ margin: '0 0 12px', fontSize: '12px', color: '#6b7280' }}>
          {status === 'active' ? `最近 ${aliveHours} 小时内上报过的实例。` : activeTab.hint + '。'}
          实例 ID 存在各站点的 MongoDB 里，重置数据库后会换新 ID，所以「已停报」「仅安装」里可能有同一站点的旧 ID。
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
                {['实例 ID', '版本', '地区', '活跃用户(7d)', '对话数', 'API失败(24h)', '降级功能', '安装于', '最后上报', '状态'].map(h => (
                  <th key={h} style={{ padding: '10px 12px', textAlign: 'left', color: '#6b7280', fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map(inst => {
                const badge = healthBadge(inst);
                return (
                  <tr key={inst.instance_id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={cellStyle}>
                      <code style={{ fontSize: '12px' }}>...{inst.instance_id.slice(-8)}</code>
                      {inst.legacy_shared && (
                        <span
                          title="v2.0.6 之前的插件用 sha256('unknown:'+数据库名) 当实例 ID，所有旧版站点共用这一行，数据被最后上报的站点覆盖，安装时间属于最早上报的站点"
                          style={{ marginLeft: 6, padding: '1px 6px', borderRadius: 10, fontSize: '11px', background: '#fffbeb', color: '#b45309', fontWeight: 600, whiteSpace: 'nowrap' }}
                        >
                          旧版共享 ID
                        </span>
                      )}
                    </td>
                    <td style={cellStyle}>v{inst.version}</td>
                    <td style={cellStyle}>
                      {inst.geo_region || inst.geo_country
                        ? `${inst.geo_country || ''}${inst.geo_region ? ` · ${inst.geo_region}` : ''}`
                        : '—'}
                    </td>
                    <td style={cellStyle}>{inst.active_users_7d}</td>
                    <td style={cellStyle}>{inst.total_conversations}</td>
                    <td style={cellStyle}>
                      {inst.api_failure_count_24h > 0
                        ? <span style={{ color: '#ef4444', fontWeight: 600 }}>{inst.api_failure_count_24h}</span>
                        : '0'}
                    </td>
                    <td style={cellStyle}>
                      {(inst.degraded_features || 0) > 0
                        ? <span style={{ color: '#dc2626', fontWeight: 600 }}>{inst.degraded_features}</span>
                        : '0'}
                    </td>
                    <td style={cellStyle}>
                      {inst.installed_at ? new Date(inst.installed_at).toLocaleDateString() : '—'}
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
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  padding: '20px', background: '#fff', borderRadius: 12,
  boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
};
const cellStyle: React.CSSProperties = { padding: '10px 12px' };
const pagerButtonStyle: React.CSSProperties = {
  padding: '6px 12px', border: '1px solid #d1d5db', borderRadius: 6,
  background: '#fff', color: '#374151', fontSize: '12px', cursor: 'pointer',
};
