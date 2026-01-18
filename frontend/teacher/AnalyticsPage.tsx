/**
 * AI 使用统计页面
 * 显示 AI 学习助手的使用统计信息（按班级/题目/学生维度）
 */

import React, { useState, useEffect } from 'react';
import { buildApiUrl, buildPageUrl } from '../utils/domainUtils';

/**
 * 统计维度类型
 */
type Dimension = 'class' | 'problem' | 'student';

/**
 * T029: 统计项接口（通用，包含 displayName）
 */
interface AnalyticsItem {
  key: string;
  displayName?: string;  // T029: 友好名称（题目标题或用户名）
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
 * 可排序表头组件（移到组件外部以避免重复创建）
 */
interface SortableHeaderProps {
  field: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  sortField: string | null;
  sortOrder: 'asc' | 'desc';
  onSort: (field: string) => void;
}

const SortableHeader: React.FC<SortableHeaderProps> = ({
  field, label, align = 'right', sortField, sortOrder, onSort
}) => {
  const isActive = sortField === field;
  return (
    <th
      onClick={() => onSort(field)}
      style={{
        padding: '10px',
        border: '1px solid #ccc',
        textAlign: align,
        cursor: 'pointer',
        userSelect: 'none',
        backgroundColor: isActive ? '#d1d5db' : '#e5e7eb',
        transition: 'background-color 0.2s'
      }}
    >
      {label} {isActive ? (sortOrder === 'asc' ? '▲' : '▼') : ''}
    </th>
  );
};

/**
 * AnalyticsPage 组件
 */
export const AnalyticsPage: React.FC = () => {
  // 从 URL 获取初始筛选条件
  const initialFilters = getInitialFiltersFromUrl();

  // 状态管理
  const [dimension, setDimension] = useState<Dimension>('problem');
  const [startDate, setStartDate] = useState<string>(initialFilters.startDate);
  const [endDate, setEndDate] = useState<string>(initialFilters.endDate);
  const [classId, setClassId] = useState<string>(initialFilters.classId);
  const [problemId, setProblemId] = useState<string>(initialFilters.problemId);

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AnalyticsResponse | null>(null);

  // 排序状态
  const [sortField, setSortField] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

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

      const res = await fetch(buildApiUrl(`/ai-helper/analytics?${params.toString()}`), {
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
   * 处理表头点击排序
   */
  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('desc');
    }
  };

  /**
   * 获取排序后的数据
   */
  const getSortedItems = (items: AnalyticsItem[]): AnalyticsItem[] => {
    if (!sortField) return items;
    return [...items].sort((a, b) => {
      const aVal = (a as any)[sortField];
      const bVal = (b as any)[sortField];
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return sortOrder === 'asc' ? -1 : 1;
      if (bVal == null) return sortOrder === 'asc' ? 1 : -1;
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortOrder === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return sortOrder === 'asc' ? (aVal - bVal) : (bVal - aVal);
    });
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
      const sortedItems = getSortedItems(data.items);
      return (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '20px' }}>
          <thead>
            <tr style={{ backgroundColor: '#e5e7eb', textAlign: 'left' }}>
              <SortableHeader field="key" label="班级" align="left" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <SortableHeader field="totalConversations" label="对话总数" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <SortableHeader field="studentCount" label="参与学生数" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <SortableHeader field="avgConversationsPerStudent" label="人均对话数" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <SortableHeader field="effectiveConversations" label="有效对话数" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <SortableHeader field="effectiveRatio" label="有效对话占比" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <th style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'center' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {sortedItems.map((item, idx) => (
              <tr key={idx} style={{ borderBottom: '1px solid #ccc', backgroundColor: idx % 2 === 0 ? '#ffffff' : '#f9fafb' }}>
                <td style={{ padding: '10px', border: '1px solid #ccc' }}>{item.key || '-'}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>{item.totalConversations}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>{item.studentCount ?? '-'}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>
                  {item.avgConversationsPerStudent != null ? formatNumber(item.avgConversationsPerStudent) : '-'}
                </td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>{item.effectiveConversations}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>{formatPercent(item.effectiveRatio)}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'center' }}>
                  <a
                    href={buildPageUrl(`/ai-helper/conversations?classId=${item.key}`)}
                    style={{
                      color: '#6366f1',
                      textDecoration: 'none',
                      fontWeight: 500,
                    }}
                    title={`查看班级 ${item.key} 的对话记录`}
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

    if (data.dimension === 'problem') {
      const sortedItems = getSortedItems(data.items);
      return (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '20px' }}>
          <thead>
            <tr style={{ backgroundColor: '#e5e7eb', textAlign: 'left' }}>
              <SortableHeader field="displayName" label="题目" align="left" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <SortableHeader field="totalConversations" label="对话总数" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <SortableHeader field="studentCount" label="使用学生数" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <SortableHeader field="avgMessageCount" label="平均轮数" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <SortableHeader field="effectiveConversations" label="有效对话数" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <SortableHeader field="effectiveRatio" label="有效对话占比" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <th style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'center' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {sortedItems.map((item, idx) => (
              <tr key={idx} style={{ borderBottom: '1px solid #ccc', backgroundColor: idx % 2 === 0 ? '#ffffff' : '#f9fafb' }}>
                {/* T030: 显示 displayName（题目标题），fallback 到 key */}
                <td style={{ padding: '10px', border: '1px solid #ccc' }}>{item.displayName || item.key || '-'}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>{item.totalConversations}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>{item.studentCount ?? '-'}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>
                  {item.avgMessageCount != null ? formatNumber(item.avgMessageCount) : '-'}
                </td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>{item.effectiveConversations}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>{formatPercent(item.effectiveRatio)}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'center' }}>
                  <a
                    href={buildPageUrl(`/ai-helper/conversations?problemId=${item.key}`)}
                    style={{
                      color: '#6366f1',
                      textDecoration: 'none',
                      fontWeight: 500,
                    }}
                    title={`查看题目 ${item.displayName || item.key} 的对话记录`}
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

    if (data.dimension === 'student') {
      const sortedItems = getSortedItems(data.items);
      return (
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: '20px' }}>
          <thead>
            <tr style={{ backgroundColor: '#e5e7eb', textAlign: 'left' }}>
              <SortableHeader field="displayName" label="学生" align="left" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <SortableHeader field="totalConversations" label="对话总数" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <SortableHeader field="effectiveConversations" label="有效对话数" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <SortableHeader field="effectiveRatio" label="有效对话占比" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <SortableHeader field="avgMessageCount" label="平均轮数" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <SortableHeader field="lastUsedAt" label="最近使用时间" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <th style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'center' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {sortedItems.map((item, idx) => (
              <tr key={idx} style={{ borderBottom: '1px solid #ccc', backgroundColor: idx % 2 === 0 ? '#ffffff' : '#f9fafb' }}>
                {/* T030: 显示 displayName（用户名），fallback 到 key */}
                <td style={{ padding: '10px', border: '1px solid #ccc' }}>{item.displayName || item.key || '-'}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>{item.totalConversations}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>{item.effectiveConversations}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>{formatPercent(item.effectiveRatio)}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>
                  {item.avgMessageCount != null ? formatNumber(item.avgMessageCount) : '-'}
                </td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'right' }}>{formatDateTime(item.lastUsedAt)}</td>
                <td style={{ padding: '10px', border: '1px solid #ccc', textAlign: 'center' }}>
                  <a
                    href={buildPageUrl(`/ai-helper/conversations?userId=${item.key}`)}
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
                setSortField(null); // 重置排序
                setSortOrder('desc');
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
