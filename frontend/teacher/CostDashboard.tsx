/**
 * Cost Analytics Dashboard
 * Token usage, cost trends, top users, model distribution with Chart.js visualizations
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Chart, registerables } from 'chart.js';
import {
  COLORS,
  FONT_FAMILY,
  TYPOGRAPHY,
  SPACING,
  RADIUS,
  SHADOWS,
  TRANSITIONS,
  cardStyle,
  statCard,
  progressBarTrackStyle,
  getProgressBarFillStyle,
  tableRootStyle,
  getTableHeaderStyle,
  getTableCellStyle,
  emptyStateStyle,
} from '../utils/styles';

Chart.register(...registerables);

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

const formatTokens = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
};

const formatCost = (n: number): string => {
  if (n < 0.01 && n > 0) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
};

const getPeriodPillStyle = (isActive: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  padding: `${SPACING.xs} ${SPACING.md}`,
  fontSize: '13px',
  fontWeight: isActive ? 500 : 400,
  color: isActive ? '#ffffff' : COLORS.textSecondary,
  backgroundColor: isActive ? COLORS.primary : COLORS.bgHover,
  border: 'none',
  borderRadius: RADIUS.full,
  cursor: 'pointer',
  transition: `all ${TRANSITIONS.fast}`,
});

const sectionTitleStyle: React.CSSProperties = {
  ...TYPOGRAPHY.md,
  margin: `0 0 ${SPACING.base}`,
  color: COLORS.textPrimary,
};

const thStyle: React.CSSProperties = {
  ...getTableHeaderStyle(),
  textAlign: 'left',
};

const thRightStyle: React.CSSProperties = {
  ...getTableHeaderStyle(),
  textAlign: 'right',
};

const tdStyle: React.CSSProperties = {
  ...getTableCellStyle(),
};

const tdRightStyle: React.CSSProperties = {
  ...getTableCellStyle(),
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
};

export const CostDashboard: React.FC<CostDashboardProps> = ({ embedded = false }) => {
  const [data, setData] = useState<CostData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [period, setPeriod] = useState<'day' | 'week' | 'month'>('day');

  const trendChartRef = useRef<HTMLCanvasElement>(null);
  const trendChartInstanceRef = useRef<Chart | null>(null);
  const modelChartRef = useRef<HTMLCanvasElement>(null);
  const modelChartInstanceRef = useRef<Chart | null>(null);

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

  // Daily trend line chart
  useEffect(() => {
    if (!trendChartRef.current || !data?.dailyTrend.length) return;
    if (trendChartInstanceRef.current) trendChartInstanceRef.current.destroy();

    const dailyData = data.dailyTrend;
    trendChartInstanceRef.current = new Chart(trendChartRef.current, {
      type: 'line',
      data: {
        labels: dailyData.map(d => d.date),
        datasets: [{
          label: 'Tokens',
          data: dailyData.map(d => d.totalTokens),
          borderColor: COLORS.primary,
          backgroundColor: 'rgba(37, 99, 235, 0.1)',
          fill: true,
          tension: 0.3,
          pointRadius: 3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: {
            grid: { color: COLORS.border },
            ticks: { color: COLORS.textMuted, font: { family: FONT_FAMILY } },
          },
          y: {
            grid: { color: COLORS.border },
            ticks: { color: COLORS.textMuted, font: { family: FONT_FAMILY } },
          },
        },
      },
    });

    return () => { trendChartInstanceRef.current?.destroy(); };
  }, [data?.dailyTrend]);

  // Model distribution doughnut chart
  useEffect(() => {
    if (!modelChartRef.current || !data?.modelBreakdown.length) return;
    if (modelChartInstanceRef.current) modelChartInstanceRef.current.destroy();

    const models = data.modelBreakdown;
    const totalTokens = models.reduce((sum, m) => sum + m.totalTokens, 0);

    const centerTextPlugin = {
      id: 'centerText',
      afterDraw(chart: any) {
        const { ctx, chartArea } = chart;
        const centerX = (chartArea.left + chartArea.right) / 2;
        const centerY = (chartArea.top + chartArea.bottom) / 2;
        ctx.save();
        ctx.font = `700 16px ${FONT_FAMILY}`;
        ctx.fillStyle = COLORS.textPrimary;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(formatTokens(totalTokens), centerX, centerY - 8);
        ctx.font = `400 11px ${FONT_FAMILY}`;
        ctx.fillStyle = COLORS.textMuted;
        ctx.fillText('Total', centerX, centerY + 10);
        ctx.restore();
      },
    };

    const colors = COLORS.chartScale.slice(0, models.length);
    while (colors.length < models.length) {
      colors.push(COLORS.textMuted);
    }

    modelChartInstanceRef.current = new Chart(modelChartRef.current, {
      type: 'doughnut',
      data: {
        labels: models.map(m => m.modelName),
        datasets: [{
          data: models.map(m => m.totalTokens),
          backgroundColor: colors,
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '60%',
        plugins: {
          legend: {
            position: 'right',
            labels: {
              color: COLORS.textSecondary,
              font: { family: FONT_FAMILY, size: 12 },
              padding: 12,
            },
          },
        },
      },
      plugins: [centerTextPlugin],
    });

    return () => { modelChartInstanceRef.current?.destroy(); };
  }, [data?.modelBreakdown]);

  if (loading) {
    return (
      <div style={{ padding: embedded ? SPACING.lg : SPACING.xl, textAlign: 'center', color: COLORS.textMuted }}>
        加载中...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: embedded ? SPACING.lg : SPACING.xl, textAlign: 'center', color: COLORS.error }}>
        {error}
        <br />
        <button
          onClick={fetchData}
          style={{
            marginTop: SPACING.sm,
            cursor: 'pointer',
            color: COLORS.primary,
            background: 'none',
            border: 'none',
            fontSize: '14px',
            fontFamily: FONT_FAMILY,
          }}
        >
          重试
        </button>
      </div>
    );
  }

  if (!data) return null;

  const budgetPercent = data.summary.budgetUsagePercent;
  const budgetColor = budgetPercent === null
    ? COLORS.textMuted
    : budgetPercent >= 90
      ? COLORS.error
      : budgetPercent >= 70
        ? COLORS.warning
        : COLORS.success;

  return (
    <div style={{ padding: embedded ? SPACING.lg : SPACING.xl, fontFamily: FONT_FAMILY }}>
      {!embedded && (
        <h1 style={{ ...TYPOGRAPHY.xl, margin: `0 0 ${SPACING.lg}`, color: COLORS.textPrimary }}>
          成本分析
        </h1>
      )}

      {/* Period Selector */}
      <div style={{ marginBottom: SPACING.lg, display: 'flex', gap: SPACING.sm }}>
        {(['day', 'week', 'month'] as const).map((p) => (
          <button key={p} onClick={() => setPeriod(p)} style={getPeriodPillStyle(period === p)}>
            {p === 'day' ? '近30天' : p === 'week' ? '本周' : '本月'}
          </button>
        ))}
      </div>

      {/* Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: SPACING.base, marginBottom: SPACING.lg }}>
        <div style={statCard.container}>
          <div style={statCard.label}>今日 Tokens</div>
          <div style={statCard.value}>{formatTokens(data.today.totalTokens)}</div>
          <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginTop: SPACING.xs }}>
            {data.today.requestCount} 次请求
          </div>
        </div>
        <div style={statCard.container}>
          <div style={statCard.label}>今日成本</div>
          <div style={statCard.value}>{formatCost(data.today.totalCost)}</div>
        </div>
        <div style={statCard.container}>
          <div style={statCard.label}>本月累计</div>
          <div style={statCard.value}>{formatTokens(data.monthly.totalTokens)}</div>
          <div style={{ ...TYPOGRAPHY.xs, color: COLORS.textMuted, marginTop: SPACING.xs }}>
            {formatCost(data.monthly.totalCost)}
          </div>
        </div>
        <div style={statCard.container}>
          <div style={statCard.label}>预算使用率</div>
          <div style={{ ...statCard.value, color: budgetColor }}>
            {budgetPercent !== null ? `${budgetPercent}%` : '未设置'}
          </div>
          {budgetPercent !== null && (
            <div style={{ ...progressBarTrackStyle, marginTop: SPACING.sm }}>
              <div style={{
                ...getProgressBarFillStyle(budgetPercent),
                backgroundColor: budgetColor,
              }} />
            </div>
          )}
        </div>
      </div>

      {/* Daily Trend Chart (Chart.js line) */}
      <div style={{ ...cardStyle, marginBottom: SPACING.lg }}>
        <h3 style={sectionTitleStyle}>
          日趋势（{data.dateRange.startDate} ~ {data.dateRange.endDate}）
        </h3>
        {data.dailyTrend.length === 0 ? (
          <div style={emptyStateStyle}>暂无数据</div>
        ) : (
          <div style={{ position: 'relative', height: '240px' }}>
            <canvas ref={trendChartRef} />
          </div>
        )}
      </div>

      {/* Two Column Layout: Top Users + Model Breakdown */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: SPACING.base }}>
        {/* Top Users */}
        <div style={cardStyle}>
          <h3 style={sectionTitleStyle}>今日 Top 10 用户</h3>
          {data.topUsers.length === 0 ? (
            <div style={emptyStateStyle}>暂无数据</div>
          ) : (
            <table style={tableRootStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>用户</th>
                  <th style={thRightStyle}>Tokens</th>
                  <th style={thRightStyle}>请求数</th>
                  <th style={thRightStyle}>成本</th>
                </tr>
              </thead>
              <tbody>
                {data.topUsers.map((u, i) => (
                  <tr key={u.userId}>
                    <td style={tdStyle}>
                      <span style={{ color: COLORS.textMuted, marginRight: SPACING.xs }}>#{i + 1}</span>
                      {u.userName}
                    </td>
                    <td style={tdRightStyle}>{formatTokens(u.totalTokens)}</td>
                    <td style={tdRightStyle}>{u.requestCount}</td>
                    <td style={tdRightStyle}>{formatCost(u.estimatedCostUSD)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Model Breakdown (Chart.js doughnut + table) */}
        <div style={cardStyle}>
          <h3 style={sectionTitleStyle}>模型消耗分布</h3>
          {data.modelBreakdown.length === 0 ? (
            <div style={emptyStateStyle}>暂无数据</div>
          ) : (
            <>
              <div style={{ position: 'relative', height: '200px', marginBottom: SPACING.base }}>
                <canvas ref={modelChartRef} />
              </div>
              <table style={tableRootStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>模型</th>
                    <th style={thRightStyle}>Tokens</th>
                    <th style={thRightStyle}>请求数</th>
                    <th style={thRightStyle}>成本</th>
                  </tr>
                </thead>
                <tbody>
                  {data.modelBreakdown.map((m) => (
                    <tr key={m.modelName}>
                      <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: '12px' }}>{m.modelName}</td>
                      <td style={tdRightStyle}>{formatTokens(m.totalTokens)}</td>
                      <td style={tdRightStyle}>{m.requestCount}</td>
                      <td style={tdRightStyle}>{formatCost(m.estimatedCostUSD)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>

      {/* Period Summary Footer */}
      <div style={{
        marginTop: SPACING.base,
        padding: `${SPACING.md} ${SPACING.base}`,
        backgroundColor: COLORS.bgPage,
        borderRadius: RADIUS.md,
        fontSize: '13px',
        fontFamily: FONT_FAMILY,
        color: COLORS.textSecondary,
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
