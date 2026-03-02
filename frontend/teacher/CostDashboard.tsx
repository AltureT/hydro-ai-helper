/**
 * 成本分析 Dashboard
 * 展示 Token 用量、成本趋势、Top 用户、模型消耗分布
 */

import React, { useState, useEffect, useCallback } from 'react';

interface CostSummary {
  totalTokens: number;
  totalCost: number;
  requestCount: number;
  avgTokensPerRequest: number;
  budgetUsagePercent: number | null;
}

interface TodaySummary {
  totalTokens: number;
  totalCost: number;
  requestCount: number;
}

interface DailyTrendItem {
  date: string;
  totalTokens: number;
  totalCost: number;
  requestCount: number;
}

interface TopUserItem {
  userId: number;
  userName: string;
  totalTokens: number;
  requestCount: number;
  estimatedCostUSD: number;
}

interface ModelBreakdownItem {
  modelName: string;
  totalTokens: number;
  requestCount: number;
  estimatedCostUSD: number;
}

interface CostData {
  summary: CostSummary;
  today: TodaySummary;
  monthly: TodaySummary;
  dailyTrend: DailyTrendItem[];
  topUsers: TopUserItem[];
  modelBreakdown: ModelBreakdownItem[];
  period: string;
  dateRange: { startDate: string; endDate: string };
}

interface CostDashboardProps {
  embedded?: boolean;
}

const cardStyle: React.CSSProperties = {
  padding: '20px',
  backgroundColor: '#ffffff',
  borderRadius: '8px',
  border: '1px solid #e5e7eb',
};

const labelStyle: React.CSSProperties = {
  fontSize: '13px',
  color: '#6b7280',
  marginBottom: '4px',
};

const valueStyle: React.CSSProperties = {
  fontSize: '24px',
  fontWeight: 700,
  color: '#1f2937',
};

const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
};

const formatCost = (n: number): string => {
  if (n < 0.01 && n > 0) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
};

export const CostDashboard: React.FC<CostDashboardProps> = ({ embedded = false }) => {
  const [data, setData] = useState<CostData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('day');

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const today = new Date().toISOString().slice(0, 10);
      const basePath = window.location.pathname.includes('/d/')
        ? window.location.pathname.split('/ai-helper')[0] + '/ai-helper/analytics/cost'
        : '/ai-helper/analytics/cost';
      const res = await fetch(`${basePath}?period=${period}&date=${today}`, {
        headers: { 'Accept': 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (err: any) {
      setError(err.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div style={{ padding: embedded ? '24px' : '32px', textAlign: 'center', color: '#6b7280' }}>
        加载中...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: embedded ? '24px' : '32px', textAlign: 'center', color: '#ef4444' }}>
        {error}
        <br />
        <button onClick={fetchData} style={{ marginTop: '8px', cursor: 'pointer', color: '#4f46e5', background: 'none', border: 'none', fontSize: '14px' }}>
          重试
        </button>
      </div>
    );
  }

  if (!data) return null;

  const maxTrendTokens = Math.max(...data.dailyTrend.map(d => d.totalTokens), 1);

  return (
    <div style={{ padding: embedded ? '24px' : '32px' }}>
      {!embedded && (
        <h1 style={{ margin: '0 0 24px', fontSize: '24px', fontWeight: 700, color: '#1f2937' }}>
          成本分析
        </h1>
      )}

      {/* Period Selector */}
      <div style={{ marginBottom: '20px', display: 'flex', gap: '8px' }}>
        {(['day', 'week', 'month'] as const).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            style={{
              padding: '6px 16px',
              fontSize: '13px',
              fontWeight: period === p ? 600 : 400,
              color: period === p ? '#ffffff' : '#6b7280',
              backgroundColor: period === p ? '#4f46e5' : '#f3f4f6',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
          >
            {p === 'day' ? '近30天' : p === 'week' ? '本周' : '本月'}
          </button>
        ))}
      </div>

      {/* Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px', marginBottom: '24px' }}>
        <div style={cardStyle}>
          <div style={labelStyle}>今日 Tokens</div>
          <div style={valueStyle}>{formatTokens(data.today.totalTokens)}</div>
          <div style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>{data.today.requestCount} 次请求</div>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>今日成本</div>
          <div style={valueStyle}>{formatCost(data.today.totalCost)}</div>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>本月累计</div>
          <div style={valueStyle}>{formatTokens(data.monthly.totalTokens)}</div>
          <div style={{ fontSize: '12px', color: '#9ca3af', marginTop: '4px' }}>{formatCost(data.monthly.totalCost)}</div>
        </div>
        <div style={cardStyle}>
          <div style={labelStyle}>预算使用率</div>
          <div style={{
            ...valueStyle,
            color: data.summary.budgetUsagePercent === null ? '#9ca3af' :
                   data.summary.budgetUsagePercent >= 90 ? '#ef4444' :
                   data.summary.budgetUsagePercent >= 70 ? '#f59e0b' : '#10b981'
          }}>
            {data.summary.budgetUsagePercent !== null ? `${data.summary.budgetUsagePercent}%` : '未设置'}
          </div>
          {data.summary.budgetUsagePercent !== null && (
            <div style={{
              marginTop: '8px',
              height: '6px',
              backgroundColor: '#e5e7eb',
              borderRadius: '3px',
              overflow: 'hidden',
            }}>
              <div style={{
                height: '100%',
                width: `${Math.min(100, data.summary.budgetUsagePercent)}%`,
                backgroundColor: data.summary.budgetUsagePercent >= 90 ? '#ef4444' :
                                 data.summary.budgetUsagePercent >= 70 ? '#f59e0b' : '#10b981',
                borderRadius: '3px',
                transition: 'width 0.3s',
              }} />
            </div>
          )}
        </div>
      </div>

      {/* Daily Trend Chart (CSS bar chart) */}
      <div style={{ ...cardStyle, marginBottom: '24px' }}>
        <h3 style={{ margin: '0 0 16px', fontSize: '16px', fontWeight: 600, color: '#1f2937' }}>
          日趋势（{data.dateRange.startDate} ~ {data.dateRange.endDate}）
        </h3>
        {data.dailyTrend.length === 0 ? (
          <div style={{ textAlign: 'center', color: '#9ca3af', padding: '20px' }}>暂无数据</div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '2px', height: '120px' }}>
            {data.dailyTrend.map((d) => {
              const heightPercent = (d.totalTokens / maxTrendTokens) * 100;
              return (
                <div
                  key={d.date}
                  title={`${d.date}\n${formatTokens(d.totalTokens)} tokens\n${formatCost(d.totalCost)}\n${d.requestCount} 次`}
                  style={{
                    flex: 1,
                    minWidth: '4px',
                    height: `${Math.max(2, heightPercent)}%`,
                    backgroundColor: '#6366f1',
                    borderRadius: '2px 2px 0 0',
                    cursor: 'default',
                    transition: 'opacity 0.2s',
                  }}
                  onMouseOver={(e) => (e.currentTarget.style.opacity = '0.7')}
                  onMouseOut={(e) => (e.currentTarget.style.opacity = '1')}
                />
              );
            })}
          </div>
        )}
        {data.dailyTrend.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px', fontSize: '11px', color: '#9ca3af' }}>
            <span>{data.dailyTrend[0]?.date.slice(5)}</span>
            <span>{data.dailyTrend[data.dailyTrend.length - 1]?.date.slice(5)}</span>
          </div>
        )}
      </div>

      {/* Two Column Layout: Top Users + Model Breakdown */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        {/* Top Users */}
        <div style={cardStyle}>
          <h3 style={{ margin: '0 0 12px', fontSize: '16px', fontWeight: 600, color: '#1f2937' }}>
            今日 Top 10 用户
          </h3>
          {data.topUsers.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#9ca3af', padding: '20px' }}>暂无数据</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                  <th style={{ textAlign: 'left', padding: '8px 4px', color: '#6b7280', fontWeight: 500 }}>用户</th>
                  <th style={{ textAlign: 'right', padding: '8px 4px', color: '#6b7280', fontWeight: 500 }}>Tokens</th>
                  <th style={{ textAlign: 'right', padding: '8px 4px', color: '#6b7280', fontWeight: 500 }}>请求数</th>
                  <th style={{ textAlign: 'right', padding: '8px 4px', color: '#6b7280', fontWeight: 500 }}>成本</th>
                </tr>
              </thead>
              <tbody>
                {data.topUsers.map((u, i) => (
                  <tr key={u.userId} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '8px 4px' }}>
                      <span style={{ color: '#9ca3af', marginRight: '6px' }}>#{i + 1}</span>
                      {u.userName}
                    </td>
                    <td style={{ textAlign: 'right', padding: '8px 4px', fontVariantNumeric: 'tabular-nums' }}>
                      {formatTokens(u.totalTokens)}
                    </td>
                    <td style={{ textAlign: 'right', padding: '8px 4px', fontVariantNumeric: 'tabular-nums' }}>
                      {u.requestCount}
                    </td>
                    <td style={{ textAlign: 'right', padding: '8px 4px', fontVariantNumeric: 'tabular-nums' }}>
                      {formatCost(u.estimatedCostUSD)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Model Breakdown */}
        <div style={cardStyle}>
          <h3 style={{ margin: '0 0 12px', fontSize: '16px', fontWeight: 600, color: '#1f2937' }}>
            模型消耗分布
          </h3>
          {data.modelBreakdown.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#9ca3af', padding: '20px' }}>暂无数据</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                  <th style={{ textAlign: 'left', padding: '8px 4px', color: '#6b7280', fontWeight: 500 }}>模型</th>
                  <th style={{ textAlign: 'right', padding: '8px 4px', color: '#6b7280', fontWeight: 500 }}>Tokens</th>
                  <th style={{ textAlign: 'right', padding: '8px 4px', color: '#6b7280', fontWeight: 500 }}>请求数</th>
                  <th style={{ textAlign: 'right', padding: '8px 4px', color: '#6b7280', fontWeight: 500 }}>成本</th>
                </tr>
              </thead>
              <tbody>
                {data.modelBreakdown.map((m) => (
                  <tr key={m.modelName} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <td style={{ padding: '8px 4px', fontFamily: 'monospace', fontSize: '12px' }}>{m.modelName}</td>
                    <td style={{ textAlign: 'right', padding: '8px 4px', fontVariantNumeric: 'tabular-nums' }}>
                      {formatTokens(m.totalTokens)}
                    </td>
                    <td style={{ textAlign: 'right', padding: '8px 4px', fontVariantNumeric: 'tabular-nums' }}>
                      {m.requestCount}
                    </td>
                    <td style={{ textAlign: 'right', padding: '8px 4px', fontVariantNumeric: 'tabular-nums' }}>
                      {formatCost(m.estimatedCostUSD)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Period Summary Footer */}
      <div style={{
        marginTop: '16px',
        padding: '12px 16px',
        backgroundColor: '#f9fafb',
        borderRadius: '8px',
        fontSize: '13px',
        color: '#6b7280',
        display: 'flex',
        justifyContent: 'space-between',
      }}>
        <span>
          区间汇总: {formatTokens(data.summary.totalTokens)} tokens / {formatCost(data.summary.totalCost)} / {data.summary.requestCount} 次请求
        </span>
        <span>
          平均 {data.summary.avgTokensPerRequest} tokens/次
        </span>
      </div>
    </div>
  );
};

export default CostDashboard;
