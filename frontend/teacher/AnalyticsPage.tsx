/**
 * AI 使用统计页面
 * 显示 AI 学习助手的使用统计信息（按班级/题目/学生维度）
 * 现代简约风格设计
 */

import React, { useState, useEffect } from 'react';
import { buildApiUrl, buildPageUrl } from '../utils/domainUtils';

/**
 * 统计维度类型
 */
type Dimension = 'class' | 'problem' | 'student';

/**
 * 统计项接口
 */
interface AnalyticsItem {
  key: string;
  displayName?: string;
  totalConversations: number;
  effectiveConversations: number;
  effectiveRatio: number;
  studentCount?: number;
  avgConversationsPerStudent?: number;
  avgMessageCount?: number;
  lastUsedAt?: string;
  // 问题类型统计（扁平化，与后端一致）
  understand?: number;
  think?: number;
  debug?: number;
  clarify?: number;
  optimize?: number;
}

/**
 * 列 key 类型（问题维度专用）
 */
type ProblemColumnKey = 'displayName' | 'totalConversations' | 'studentCount' | 'avgMessageCount'
  | 'effectiveConversations' | 'effectiveRatio'
  | 'understand' | 'think' | 'debug' | 'clarify' | 'optimize' | 'actions';

/**
 * 列配置
 */
interface ColumnConfig {
  key: ProblemColumnKey;
  label: string;
  defaultVisible: boolean;
  canHide: boolean;
}

const PROBLEM_COLUMNS: ColumnConfig[] = [
  { key: 'displayName', label: '题目', defaultVisible: true, canHide: true },
  { key: 'totalConversations', label: '对话总数', defaultVisible: true, canHide: true },
  { key: 'studentCount', label: '使用学生', defaultVisible: true, canHide: true },
  { key: 'avgMessageCount', label: '平均轮数', defaultVisible: true, canHide: true },
  { key: 'effectiveConversations', label: '有效对话', defaultVisible: false, canHide: true },
  { key: 'effectiveRatio', label: '有效率', defaultVisible: false, canHide: true },
  { key: 'understand', label: '理解题意', defaultVisible: true, canHide: true },
  { key: 'think', label: '理清思路', defaultVisible: true, canHide: true },
  { key: 'debug', label: '分析错误', defaultVisible: true, canHide: true },
  { key: 'clarify', label: '追问解释', defaultVisible: true, canHide: true },
  { key: 'optimize', label: '代码优化', defaultVisible: true, canHide: true },
  { key: 'actions', label: '操作', defaultVisible: true, canHide: false }
];

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
 * 可排序表头组件
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
        padding: '14px 16px',
        textAlign: align,
        cursor: 'pointer',
        userSelect: 'none',
        fontWeight: 600,
        fontSize: '13px',
        color: isActive ? '#4f46e5' : '#6b7280',
        backgroundColor: '#f9fafb',
        borderBottom: '2px solid #e5e7eb',
        transition: 'all 0.2s',
        whiteSpace: 'nowrap'
      }}
    >
      {label}
      {isActive && (
        <span style={{ marginLeft: '4px', color: '#4f46e5' }}>
          {sortOrder === 'asc' ? '↑' : '↓'}
        </span>
      )}
    </th>
  );
};

/**
 * AnalyticsPage 组件 Props
 */
interface AnalyticsPageProps {
  embedded?: boolean;
}

/**
 * AnalyticsPage 组件
 */
export const AnalyticsPage: React.FC<AnalyticsPageProps> = ({ embedded = false }) => {
  const initialFilters = getInitialFiltersFromUrl();

  const [dimension, setDimension] = useState<Dimension>('problem');
  const [startDate, setStartDate] = useState<string>(initialFilters.startDate);
  const [endDate, setEndDate] = useState<string>(initialFilters.endDate);
  const [classId, setClassId] = useState<string>(initialFilters.classId);
  const [problemId, setProblemId] = useState<string>(initialFilters.problemId);

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<AnalyticsResponse | null>(null);

  const [sortField, setSortField] = useState<string | null>(null);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  // 列显示控制状态
  const [visibleColumns, setVisibleColumns] = useState<Set<ProblemColumnKey>>(() =>
    new Set(PROBLEM_COLUMNS.filter(c => c.defaultVisible).map(c => c.key))
  );
  const [showColumnSelector, setShowColumnSelector] = useState(false);

  const hasInitialFilters = initialFilters.startDate || initialFilters.endDate ||
                           initialFilters.classId || initialFilters.problemId;

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

  useEffect(() => {
    if (hasInitialFilters) {
      fetchData();
    }
  }, []);

  const formatPercent = (ratio: number): string => {
    return (ratio * 100).toFixed(1) + '%';
  };

  const formatNumber = (num: number): string => {
    return num.toFixed(2);
  };

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

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('desc');
    }
  };

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

  const renderTable = () => {
    if (!data || data.items.length === 0) {
      return (
        <div style={{
          padding: '60px 20px',
          textAlign: 'center',
          color: '#9ca3af',
          backgroundColor: '#f9fafb',
          borderRadius: '12px',
          border: '1px dashed #e5e7eb'
        }}>
          <div style={{ fontSize: '48px', marginBottom: '16px' }}>📊</div>
          <div style={{ fontSize: '15px' }}>暂无数据，请调整筛选条件后重新查询</div>
        </div>
      );
    }

    const tableStyle: React.CSSProperties = {
      width: '100%',
      borderCollapse: 'separate',
      borderSpacing: 0,
      borderRadius: '12px',
      overflow: 'hidden',
      boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
      border: '1px solid #e5e7eb'
    };

    const cellStyle: React.CSSProperties = {
      padding: '14px 16px',
      borderBottom: '1px solid #f3f4f6',
      fontSize: '14px'
    };

    const linkStyle: React.CSSProperties = {
      color: '#6366f1',
      textDecoration: 'none',
      fontWeight: 500,
      padding: '6px 12px',
      borderRadius: '6px',
      backgroundColor: '#eef2ff',
      transition: 'all 0.2s',
      display: 'inline-block'
    };

    if (data.dimension === 'class') {
      const sortedItems = getSortedItems(data.items);
      return (
        <table style={tableStyle}>
          <thead>
            <tr>
              <SortableHeader field="key" label="班级" align="left" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <SortableHeader field="totalConversations" label="对话总数" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <SortableHeader field="studentCount" label="参与学生" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <SortableHeader field="avgConversationsPerStudent" label="人均对话" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <SortableHeader field="effectiveConversations" label="有效对话" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <SortableHeader field="effectiveRatio" label="有效率" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <th style={{ ...cellStyle, backgroundColor: '#f9fafb', fontWeight: 600, color: '#6b7280', textAlign: 'center', borderBottom: '2px solid #e5e7eb' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {sortedItems.map((item, idx) => (
              <tr key={idx} style={{ backgroundColor: idx % 2 === 0 ? '#ffffff' : '#fafafa' }}>
                <td style={{ ...cellStyle, fontWeight: 500, color: '#1f2937' }}>{item.key || '-'}</td>
                <td style={{ ...cellStyle, textAlign: 'right', color: '#4b5563' }}>{item.totalConversations}</td>
                <td style={{ ...cellStyle, textAlign: 'right', color: '#4b5563' }}>{item.studentCount ?? '-'}</td>
                <td style={{ ...cellStyle, textAlign: 'right', color: '#4b5563' }}>
                  {item.avgConversationsPerStudent != null ? formatNumber(item.avgConversationsPerStudent) : '-'}
                </td>
                <td style={{ ...cellStyle, textAlign: 'right', color: '#4b5563' }}>{item.effectiveConversations}</td>
                <td style={{ ...cellStyle, textAlign: 'right' }}>
                  <span style={{
                    padding: '4px 8px',
                    borderRadius: '4px',
                    fontSize: '13px',
                    fontWeight: 500,
                    backgroundColor: item.effectiveRatio >= 0.7 ? '#dcfce7' : item.effectiveRatio >= 0.4 ? '#fef9c3' : '#fee2e2',
                    color: item.effectiveRatio >= 0.7 ? '#166534' : item.effectiveRatio >= 0.4 ? '#854d0e' : '#991b1b'
                  }}>
                    {formatPercent(item.effectiveRatio)}
                  </span>
                </td>
                <td style={{ ...cellStyle, textAlign: 'center' }}>
                  <a href={buildPageUrl(`/ai-helper/conversations?classId=${item.key}`)} style={linkStyle}>
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

      const toggleColumn = (key: ProblemColumnKey) => {
        const col = PROBLEM_COLUMNS.find(c => c.key === key);
        if (!col || !col.canHide) return;
        setVisibleColumns(prev => {
          const next = new Set(prev);
          if (next.has(key)) {
            next.delete(key);
          } else {
            next.add(key);
          }
          return next;
        });
      };

      const isVisible = (key: ProblemColumnKey) => visibleColumns.has(key);

      return (
        <div>
          {/* 列选择器按钮 */}
          <div style={{ marginBottom: '16px', position: 'relative' }}>
            <button
              onClick={() => setShowColumnSelector(!showColumnSelector)}
              style={{
                padding: '8px 16px',
                backgroundColor: '#f3f4f6',
                border: '1px solid #e5e7eb',
                borderRadius: '6px',
                fontSize: '13px',
                fontWeight: 500,
                color: '#374151',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              <span style={{ fontSize: '14px' }}>&#9776;</span>
              列设置
              <span style={{ fontSize: '10px', color: '#9ca3af' }}>({visibleColumns.size - 1}/{PROBLEM_COLUMNS.length - 1})</span>
            </button>
            {showColumnSelector && (
              <div style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                marginTop: '4px',
                backgroundColor: '#ffffff',
                border: '1px solid #e5e7eb',
                borderRadius: '8px',
                boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                padding: '12px',
                zIndex: 100,
                minWidth: '200px'
              }}>
                <div style={{ marginBottom: '8px', fontWeight: 600, fontSize: '13px', color: '#374151' }}>显示列</div>
                {PROBLEM_COLUMNS.filter(c => c.canHide).map(col => (
                  <label
                    key={col.key}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '6px 4px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      color: '#4b5563'
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isVisible(col.key)}
                      onChange={() => toggleColumn(col.key)}
                      style={{ cursor: 'pointer' }}
                    />
                    {col.label}
                  </label>
                ))}
              </div>
            )}
          </div>

          <table style={tableStyle}>
            <thead>
              <tr>
                {isVisible('displayName') && <SortableHeader field="displayName" label="题目" align="left" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />}
                {isVisible('totalConversations') && <SortableHeader field="totalConversations" label="对话总数" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />}
                {isVisible('studentCount') && <SortableHeader field="studentCount" label="使用学生" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />}
                {isVisible('avgMessageCount') && <SortableHeader field="avgMessageCount" label="平均轮数" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />}
                {isVisible('effectiveConversations') && <SortableHeader field="effectiveConversations" label="有效对话" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />}
                {isVisible('effectiveRatio') && <SortableHeader field="effectiveRatio" label="有效率" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />}
                {isVisible('understand') && <SortableHeader field="understand" label="理解题意" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />}
                {isVisible('think') && <SortableHeader field="think" label="理清思路" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />}
                {isVisible('debug') && <SortableHeader field="debug" label="分析错误" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />}
                {isVisible('clarify') && <SortableHeader field="clarify" label="追问解释" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />}
                {isVisible('optimize') && <SortableHeader field="optimize" label="代码优化" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />}
                <th style={{ ...cellStyle, backgroundColor: '#f9fafb', fontWeight: 600, color: '#6b7280', textAlign: 'center', borderBottom: '2px solid #e5e7eb' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {sortedItems.map((item, idx) => (
                <tr key={idx} style={{ backgroundColor: idx % 2 === 0 ? '#ffffff' : '#fafafa' }}>
                  {isVisible('displayName') && (
                    <td style={{ ...cellStyle, fontWeight: 500, color: '#1f2937' }}>
                      <a
                        href={buildPageUrl(`/p/${item.key}`)}
                        style={{ color: '#4f46e5', textDecoration: 'none' }}
                        onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
                      >
                        {item.displayName || item.key || '-'}
                      </a>
                    </td>
                  )}
                  {isVisible('totalConversations') && <td style={{ ...cellStyle, textAlign: 'right', color: '#4b5563' }}>{item.totalConversations}</td>}
                  {isVisible('studentCount') && <td style={{ ...cellStyle, textAlign: 'right', color: '#4b5563' }}>{item.studentCount ?? '-'}</td>}
                  {isVisible('avgMessageCount') && (
                    <td style={{ ...cellStyle, textAlign: 'right', color: '#4b5563' }}>
                      {item.avgMessageCount != null ? formatNumber(item.avgMessageCount) : '-'}
                    </td>
                  )}
                  {isVisible('effectiveConversations') && <td style={{ ...cellStyle, textAlign: 'right', color: '#4b5563' }}>{item.effectiveConversations}</td>}
                  {isVisible('effectiveRatio') && (
                    <td style={{ ...cellStyle, textAlign: 'right' }}>
                      <span style={{
                        padding: '4px 8px',
                        borderRadius: '4px',
                        fontSize: '13px',
                        fontWeight: 500,
                        backgroundColor: item.effectiveRatio >= 0.7 ? '#dcfce7' : item.effectiveRatio >= 0.4 ? '#fef9c3' : '#fee2e2',
                        color: item.effectiveRatio >= 0.7 ? '#166534' : item.effectiveRatio >= 0.4 ? '#854d0e' : '#991b1b'
                      }}>
                        {formatPercent(item.effectiveRatio)}
                      </span>
                    </td>
                  )}
                  {isVisible('understand') && <td style={{ ...cellStyle, textAlign: 'right', color: '#4b5563' }}>{item.understand ?? 0}</td>}
                  {isVisible('think') && <td style={{ ...cellStyle, textAlign: 'right', color: '#4b5563' }}>{item.think ?? 0}</td>}
                  {isVisible('debug') && <td style={{ ...cellStyle, textAlign: 'right', color: '#4b5563' }}>{item.debug ?? 0}</td>}
                  {isVisible('clarify') && <td style={{ ...cellStyle, textAlign: 'right', color: '#4b5563' }}>{item.clarify ?? 0}</td>}
                  {isVisible('optimize') && <td style={{ ...cellStyle, textAlign: 'right', color: '#4b5563' }}>{item.optimize ?? 0}</td>}
                  <td style={{ ...cellStyle, textAlign: 'center' }}>
                    <a href={buildPageUrl(`/ai-helper/conversations?problemId=${item.key}`)} style={linkStyle}>
                      查看对话
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    if (data.dimension === 'student') {
      const sortedItems = getSortedItems(data.items);
      return (
        <table style={tableStyle}>
          <thead>
            <tr>
              <SortableHeader field="displayName" label="学生" align="left" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <SortableHeader field="totalConversations" label="对话总数" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <SortableHeader field="effectiveConversations" label="有效对话" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <SortableHeader field="effectiveRatio" label="有效率" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <SortableHeader field="avgMessageCount" label="平均轮数" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <SortableHeader field="lastUsedAt" label="最近使用" sortField={sortField} sortOrder={sortOrder} onSort={handleSort} />
              <th style={{ ...cellStyle, backgroundColor: '#f9fafb', fontWeight: 600, color: '#6b7280', textAlign: 'center', borderBottom: '2px solid #e5e7eb' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {sortedItems.map((item, idx) => (
              <tr key={idx} style={{ backgroundColor: idx % 2 === 0 ? '#ffffff' : '#fafafa' }}>
                <td style={{ ...cellStyle, fontWeight: 500, color: '#1f2937' }}>{item.displayName || item.key || '-'}</td>
                <td style={{ ...cellStyle, textAlign: 'right', color: '#4b5563' }}>{item.totalConversations}</td>
                <td style={{ ...cellStyle, textAlign: 'right', color: '#4b5563' }}>{item.effectiveConversations}</td>
                <td style={{ ...cellStyle, textAlign: 'right' }}>
                  <span style={{
                    padding: '4px 8px',
                    borderRadius: '4px',
                    fontSize: '13px',
                    fontWeight: 500,
                    backgroundColor: item.effectiveRatio >= 0.7 ? '#dcfce7' : item.effectiveRatio >= 0.4 ? '#fef9c3' : '#fee2e2',
                    color: item.effectiveRatio >= 0.7 ? '#166534' : item.effectiveRatio >= 0.4 ? '#854d0e' : '#991b1b'
                  }}>
                    {formatPercent(item.effectiveRatio)}
                  </span>
                </td>
                <td style={{ ...cellStyle, textAlign: 'right', color: '#4b5563' }}>
                  {item.avgMessageCount != null ? formatNumber(item.avgMessageCount) : '-'}
                </td>
                <td style={{ ...cellStyle, textAlign: 'right', color: '#6b7280', fontSize: '13px' }}>{formatDateTime(item.lastUsedAt)}</td>
                <td style={{ ...cellStyle, textAlign: 'center' }}>
                  <a href={buildPageUrl(`/ai-helper/conversations?userId=${item.key}`)} style={linkStyle}>
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
    <div style={{
      padding: embedded ? '24px' : '32px',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      backgroundColor: embedded ? 'transparent' : '#f8fafc',
      minHeight: embedded ? 'auto' : '100vh'
    }}>
      {/* 页面标题 - 仅在非嵌入模式显示 */}
      {!embedded && (
      <div style={{
        marginBottom: '32px',
        padding: '24px 32px',
        background: '#ffffff',
        borderRadius: '12px',
        border: '1px solid #e5e7eb',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)'
      }}>
        <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 700, color: '#1f2937' }}>AI 使用统计</h1>
        <p style={{ margin: '8px 0 0', color: '#6b7280', fontSize: '14px' }}>查看学生使用 AI 学习助手的详细统计数据</p>
      </div>
      )}

      {/* 筛选表单 */}
      <div style={{
        marginBottom: '24px',
        padding: '24px',
        backgroundColor: '#ffffff',
        borderRadius: '12px',
        boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
        border: '1px solid #e5e7eb'
      }}>
        <h3 style={{ margin: '0 0 20px', fontSize: '16px', fontWeight: 600, color: '#1f2937' }}>筛选条件</h3>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '20px' }}>
          <div>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: 500, fontSize: '14px', color: '#374151' }}>统计维度</label>
            <select
              value={dimension}
              onChange={(e) => {
                setDimension(e.target.value as Dimension);
                setData(null);
                setSortField(null);
                setSortOrder('desc');
              }}
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: '8px',
                border: '1px solid #e5e7eb',
                fontSize: '14px',
                backgroundColor: '#f9fafb',
                color: '#1f2937',
                cursor: 'pointer'
              }}
            >
              <option value="class">按班级</option>
              <option value="problem">按题目</option>
              <option value="student">按学生</option>
            </select>
          </div>

          <div>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: 500, fontSize: '14px', color: '#374151' }}>开始日期</label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: '8px',
                border: '1px solid #e5e7eb',
                fontSize: '14px',
                backgroundColor: '#f9fafb',
                color: '#1f2937'
              }}
            />
          </div>

          <div>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: 500, fontSize: '14px', color: '#374151' }}>结束日期</label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: '8px',
                border: '1px solid #e5e7eb',
                fontSize: '14px',
                backgroundColor: '#f9fafb',
                color: '#1f2937'
              }}
            />
          </div>

          <div>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: 500, fontSize: '14px', color: '#374151' }}>班级</label>
            <input
              type="text"
              value={classId}
              onChange={(e) => setClassId(e.target.value)}
              placeholder="班级 ID（可选）"
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: '8px',
                border: '1px solid #e5e7eb',
                fontSize: '14px',
                backgroundColor: '#f9fafb',
                color: '#1f2937'
              }}
            />
          </div>

          <div>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: 500, fontSize: '14px', color: '#374151' }}>题目 ID</label>
            <input
              type="text"
              value={problemId}
              onChange={(e) => setProblemId(e.target.value)}
              placeholder="题目 ID（可选）"
              style={{
                width: '100%',
                padding: '10px 12px',
                borderRadius: '8px',
                border: '1px solid #e5e7eb',
                fontSize: '14px',
                backgroundColor: '#f9fafb',
                color: '#1f2937'
              }}
            />
          </div>
        </div>

        <button
          onClick={fetchData}
          disabled={loading}
          style={{
            marginTop: '20px',
            padding: '12px 28px',
            background: loading ? '#9ca3af' : 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
            color: 'white',
            border: 'none',
            borderRadius: '8px',
            fontSize: '15px',
            fontWeight: 600,
            cursor: loading ? 'not-allowed' : 'pointer',
            boxShadow: loading ? 'none' : '0 2px 8px rgba(102, 126, 234, 0.3)',
            transition: 'all 0.2s'
          }}
        >
          {loading ? '查询中...' : '查询'}
        </button>
      </div>

      {/* 加载状态 */}
      {loading && (
        <div style={{
          padding: '40px',
          textAlign: 'center',
          color: '#6b7280',
          backgroundColor: '#ffffff',
          borderRadius: '12px',
          border: '1px solid #e5e7eb'
        }}>
          <div style={{ fontSize: '24px', marginBottom: '12px' }}>⏳</div>
          正在加载统计数据...
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div style={{
          padding: '16px 20px',
          backgroundColor: '#fef2f2',
          border: '1px solid #fecaca',
          borderRadius: '12px',
          color: '#991b1b',
          marginBottom: '24px'
        }}>
          ⚠️ <strong>加载失败：</strong> {error}
        </div>
      )}

      {/* 统计表格 */}
      {!loading && !error && renderTable()}
    </div>
  );
};

export default AnalyticsPage;
