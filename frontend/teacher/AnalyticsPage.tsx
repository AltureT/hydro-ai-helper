/**
 * AI 使用统计页面
 * 显示 AI 学习助手的使用统计信息（按班级/题目/学生维度）
 */

import React, { useState, useEffect } from 'react';

/**
 * 统计维度类型
 */
type Dimension = 'class' | 'problem' | 'student';

/**
 * 统计项接口（通用）
 */
interface AnalyticsItem {
  key: string;
  totalConversations: number;
  effectiveConversations: number;
  effectiveRatio: number;
  // class 维度特有
  studentCount?: number;
  avgConversationsPerStudent?: number;
  // problem 维度特有
  avgMessageCount?: number;
  // student 维度特有
  lastUsedAt?: string;
}

/**
 * 统计响应接口
 */
interface AnalyticsResponse {
  dimension: Dimension;
  items: AnalyticsItem[];
}

/**
 * 从 URL query 解析初始筛选参数
 */
function getInitialFiltersFromUrl(): {
  startDate: string;
  endDate: string;
  classId: string;
  problemId: string;
  userId: string;
} {
  if (typeof window === 'undefined') {
    return { startDate: '', endDate: '', classId: '', problemId: '', userId: '' };
  }
  const params = new URLSearchParams(window.location.search);
  return {
    startDate: params.get('startDate') || '',
    endDate: params.get('endDate') || '',
    classId: params.get('classId') || '',
    problemId: params.get('problemId') || '',
    userId: params.get('userId') || '',
  };
}

/**
 * AnalyticsPage 组件
 */
export const AnalyticsPage: React.FC = () => {
  // 从 URL 获取初始筛选条件
  const initialFilters = getInitialFiltersFromUrl();

  // 状态管理
  const [dimension, setDimension] = useState<Dimension>('class');
  const [startDate, setStartDate] = useState<string>(initialFilters.startDate);
  const [endDate, setEndDate] = useState<string>(initialFilters.endDate);
  const [classId, setClassId] = useState<string>(initialFilters.classId);
  const [problemId, setProblemId] = useState<string>(initialFilters.problemId);

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AnalyticsResponse | null>(null);

  // 如果 URL 带有筛选参数，组件加载时自动查询
  const hasInitialFilters = initialFilters.startDate || initialFilters.endDate ||
                           initialFilters.classId || initialFilters.problemId;

  /**
   * 调用统计 API
   */
  const fetchData = async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      params.set('dimension', dimension);
      if (startDate) params.set('startDate', startDate);
      if (endDate) params.set('endDate', endDate);
      if (classId) params.set('classId', classId);
      if (problemId) params.set('problemId', problemId);

      const res = await fetch(`/ai-helper/analytics?${params.toString()}`, {
        method: 'GET',
        credentials: 'include',
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `请求失败: ${res.status}`);
      }

      const json: AnalyticsResponse = await res.json();
      setData(json);
    } catch (err: any) {
      console.error('Fetch analytics error', err);
      setError(err.message || '加载统计数据失败');
    } finally {
      setLoading(false);
    }
  };

  // 组件加载时，如果 URL 带有筛选参数则自动查询
  useEffect(() => {
    if (hasInitialFilters) {
      fetchData();
    }
  }, []); // 仅在组件挂载时执行一次

  /**
   * 格式化百分比
   */
  const formatPercent = (ratio: number): string => {
    return (ratio * 100).toFixed(1) + '%';
  };

  /**
   * 格式化数字（保留 2 位小数）
   */
  const formatNumber = (num: number): string => {
    return num.toFixed(2);
  };

  /**
   * 格式化日期时间
   */
  const formatDateTime = (isoString: string | undefined): string => {
    if (!isoString) return '-';
    try {
      const date = new Date(isoString);
      return date.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (err) {
      return '-';
    }
  };

  /**
   * 渲染表格（根据维度）
   */
  const renderTable = () => {
    if (!data || data.items.length === 0) {
      return (
        <div style={{
          padding: '40px',
          textAlign: 'center',
          color: '#6b7280',
          backgroundColor: '#f9fafb',
          borderRadius: '8px'
        }}>
          暂无数据，请调整筛选条件后重新查询。
        </div>
      );
    }

    // 根据维度渲染不同的表头和列
    if (data.dimension === 'class') {
      return (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '20px' }}>
          <thead>
            <tr style={{ backgroundColor: '#e5e7eb', textAlign: 'left' }}>
              <th style={{ padding: '10px', border: '1px solid #ccc' }}>班级</th>
              <th style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>对话总数</th>
              <th style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>参与学生数</th>
              <th style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>人均对话数</th>
              <th style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>有效对话数</th>
              <th style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>有效对话占比</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item, idx) => (
              <tr key={idx} style={{ borderBottom: '1px solid #ccc', backgroundColor: idx % 2 === 0 ? '#ffffff' : '#f9fafb' }}>
                <td style={{ padding: '10px', border: '1px solid #ccc' }}>{item.key || '-'}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>{item.totalConversations}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>{item.studentCount ?? '-'}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>
                  {item.avgConversationsPerStudent != null ? formatNumber(item.avgConversationsPerStudent) : '-'}
                </td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>{item.effectiveConversations}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>{formatPercent(item.effectiveRatio)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }

    if (data.dimension === 'problem') {
      return (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '20px' }}>
          <thead>
            <tr style={{ backgroundColor: '#e5e7eb', textAlign: 'left' }}>
              <th style={{ padding: '10px', border: '1px solid #ccc' }}>题目 ID</th>
              <th style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>对话总数</th>
              <th style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>使用学生数</th>
              <th style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>平均轮数</th>
              <th style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>有效对话数</th>
              <th style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>有效对话占比</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item, idx) => (
              <tr key={idx} style={{ borderBottom: '1px solid #ccc', backgroundColor: idx % 2 === 0 ? '#ffffff' : '#f9fafb' }}>
                <td style={{ padding: '10px', border: '1px solid #ccc' }}>{item.key || '-'}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>{item.totalConversations}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>{item.studentCount ?? '-'}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>
                  {item.avgMessageCount != null ? formatNumber(item.avgMessageCount) : '-'}
                </td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>{item.effectiveConversations}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>{formatPercent(item.effectiveRatio)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }

    if (data.dimension === 'student') {
      return (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '20px' }}>
          <thead>
            <tr style={{ backgroundColor: '#e5e7eb', textAlign: 'left' }}>
              <th style={{ padding: '10px', border: '1px solid #ccc' }}>学生 ID</th>
              <th style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>对话总数</th>
              <th style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>有效对话数</th>
              <th style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>有效对话占比</th>
              <th style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>平均轮数</th>
              <th style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>最近使用时间</th>
              <th style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'center' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item, idx) => (
              <tr key={idx} style={{ borderBottom: '1px solid #ccc', backgroundColor: idx % 2 === 0 ? '#ffffff' : '#f9fafb' }}>
                <td style={{ padding: '10px', border: '1px solid #ccc' }}>{item.key || '-'}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>{item.totalConversations}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>{item.effectiveConversations}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>{formatPercent(item.effectiveRatio)}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>
                  {item.avgMessageCount != null ? formatNumber(item.avgMessageCount) : '-'}
                </td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>{formatDateTime(item.lastUsedAt)}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'center' }}>
                  <a
                    href={`/ai-helper/conversations?userId=${item.key}`}
                    style={{
                      color: '#6366f1',
                      textDecoration: 'none',
                      fontWeight: 500,
                    }}
                    title={`查看学生 ${item.key} 的对话记录`}
                  >
                    查看对话
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      );
    }

    return null;
  };

  return (
    <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
      <h1>AI 使用统计</h1>

      {/* 筛选表单 */}
      <div style={{
        marginTop: '20px',
        padding: '20px',
        backgroundColor: '#f5f5f5',
        borderRadius: '8px'
      }}>
        <h3 style={{ marginTop: 0, marginBottom: '15px' }}>筛选条件</h3>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '15px' }}>
          {/* 统计维度 */}
          <div>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>统计维度：</label>
            <select
              value={dimension}
              onChange={(e) => {
                setDimension(e.target.value as Dimension);
                setData(null); // 清空数据
              }}
              style={{
                width: '100%',
                padding: '8px',
                borderRadius: '4px',
                border: '1px solid #ccc',
                fontSize: '14px'
              }}
            >
              <option value="class">按班级</option>
              <option value="problem">按题目</option>
              <option value="student">按学生</option>
            </select>
          </div>

          {/* 开始日期 */}
          <div>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>开始日期：</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              style={{
                width: '100%',
                padding: '8px',
                borderRadius: '4px',
                border: '1px solid #ccc',
                fontSize: '14px'
              }}
            />
          </div>

          {/* 结束日期 */}
          <div>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>结束日期：</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              style={{
                width: '100%',
                padding: '8px',
                borderRadius: '4px',
                border: '1px solid #ccc',
                fontSize: '14px'
              }}
            />
          </div>

          {/* 班级 ID */}
          <div>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>班级：</label>
            <input
              type="text"
              value={classId}
              onChange={(e) => setClassId(e.target.value)}
              placeholder="班级 ID（可选）"
              style={{
                width: '100%',
                padding: '8px',
                borderRadius: '4px',
                border: '1px solid #ccc',
                fontSize: '14px'
              }}
            />
          </div>

          {/* 题目 ID */}
          <div>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 500 }}>题目 ID：</label>
            <input
              type="text"
              value={problemId}
              onChange={(e) => setProblemId(e.target.value)}
              placeholder="题目 ID（可选）"
              style={{
                width: '100%',
                padding: '8px',
                borderRadius: '4px',
                border: '1px solid #ccc',
                fontSize: '14px'
              }}
            />
          </div>
        </div>

        {/* 查询按钮 */}
        <button
          onClick={fetchData}
          disabled={loading}
          style={{
            marginTop: '15px',
            padding: '10px 24px',
            backgroundColor: loading ? '#9ca3af' : '#6366f1',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            fontSize: '14px',
            fontWeight: 500,
            cursor: loading ? 'not-allowed' : 'pointer'
          }}
        >
          {loading ? '加载中...' : '查询'}
        </button>
      </div>

      {/* 加载状态 */}
      {loading && (
        <div style={{
          marginTop: '20px',
          padding: '20px',
          textAlign: 'center',
          color: '#6b7280',
          backgroundColor: '#f9fafb',
          borderRadius: '8px'
        }}>
          正在加载统计数据...
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div style={{
          marginTop: '20px',
          padding: '15px',
          backgroundColor: '#fee2e2',
          border: '1px solid #ef4444',
          borderRadius: '8px',
          color: '#991b1b'
        }}>
          <strong>加载统计数据失败：</strong> {error}
        </div>
      )}

      {/* 统计表格 */}
      {!loading && !error && renderTable()}
    </div>
  );
};

export default AnalyticsPage;
