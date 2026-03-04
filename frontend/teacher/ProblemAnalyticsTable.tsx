import React, { useState, useEffect } from 'react';
import { buildPageUrl } from '../utils/domainUtils';
import {
  AnalyticsItem, ProblemColumnKey, SortableHeaderProps,
  PROBLEM_COLUMNS, tableStyle, cellStyle, linkStyle,
  formatPercent, formatNumber, renderEffectiveRatio,
} from './analyticsTypes';

const SortableHeader: React.FC<SortableHeaderProps> = ({
  field, label, align = 'right', sortField, sortOrder, onSort
}) => {
  const isActive = sortField === field;
  return (
    <th
      onClick={() => onSort(field)}
      style={{
        padding: '14px 16px', textAlign: align, cursor: 'pointer',
        userSelect: 'none', fontWeight: 600, fontSize: '13px',
        color: isActive ? '#4f46e5' : '#6b7280',
        backgroundColor: '#f9fafb', borderBottom: '2px solid #e5e7eb',
        transition: 'all 0.2s', whiteSpace: 'nowrap'
      }}
    >
      {label}
      {isActive && <span style={{ marginLeft: '4px', color: '#4f46e5' }}>{sortOrder === 'asc' ? '\u2191' : '\u2193'}</span>}
    </th>
  );
};

interface ProblemAnalyticsTableProps {
  items: AnalyticsItem[];
  sortField: string | null;
  sortOrder: 'asc' | 'desc';
  onSort: (field: string) => void;
  visibleColumns: Set<ProblemColumnKey>;
  onVisibleColumnsChange: (cols: Set<ProblemColumnKey>) => void;
}

export const ProblemAnalyticsTable: React.FC<ProblemAnalyticsTableProps> = ({
  items, sortField, sortOrder, onSort,
  visibleColumns, onVisibleColumnsChange,
}) => {
  const [showColumnSelector, setShowColumnSelector] = useState(false);

  const toggleColumn = (key: ProblemColumnKey) => {
    const col = PROBLEM_COLUMNS.find(c => c.key === key);
    if (!col || !col.canHide) return;
    const next = new Set(visibleColumns);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onVisibleColumnsChange(next);
  };

  const isVisible = (key: ProblemColumnKey) => visibleColumns.has(key);

  return (
    <div>
      {/* Column selector */}
      <div style={{ marginBottom: '16px', position: 'relative' }}>
        <button
          onClick={() => setShowColumnSelector(!showColumnSelector)}
          style={{
            padding: '8px 16px', backgroundColor: '#f3f4f6',
            border: '1px solid #e5e7eb', borderRadius: '6px',
            fontSize: '13px', fontWeight: 500, color: '#374151',
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px'
          }}
        >
          <span style={{ fontSize: '14px' }}>&#9776;</span>
          列设置
          <span style={{ fontSize: '10px', color: '#9ca3af' }}>({visibleColumns.size - 1}/{PROBLEM_COLUMNS.length - 1})</span>
        </button>
        {showColumnSelector && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, marginTop: '4px',
            backgroundColor: '#ffffff', border: '1px solid #e5e7eb',
            borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
            padding: '12px', zIndex: 100, minWidth: '200px'
          }}>
            <div style={{ marginBottom: '8px', fontWeight: 600, fontSize: '13px', color: '#374151' }}>显示列</div>
            {PROBLEM_COLUMNS.filter(c => c.canHide).map(col => (
              <label
                key={col.key}
                style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '6px 4px', cursor: 'pointer', fontSize: '13px', color: '#4b5563'
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

      <div style={{ overflowX: 'auto' }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              {isVisible('displayName') && <SortableHeader field="displayName" label="题目" align="left" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />}
              {isVisible('totalConversations') && <SortableHeader field="totalConversations" label="对话总数" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />}
              {isVisible('studentCount') && <SortableHeader field="studentCount" label="使用学生" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />}
              {isVisible('avgMessageCount') && <SortableHeader field="avgMessageCount" label="平均轮数" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />}
              {isVisible('effectiveConversations') && <SortableHeader field="effectiveConversations" label="有效对话" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />}
              {isVisible('effectiveRatio') && <SortableHeader field="effectiveRatio" label="有效率" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />}
              {isVisible('understand') && <SortableHeader field="understand" label="理解题意" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />}
              {isVisible('think') && <SortableHeader field="think" label="理清思路" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />}
              {isVisible('debug') && <SortableHeader field="debug" label="分析错误" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />}
              {isVisible('clarify') && <SortableHeader field="clarify" label="追问解释" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />}
              {isVisible('optimize') && <SortableHeader field="optimize" label="代码优化" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />}
              <th style={{ ...cellStyle, backgroundColor: '#f9fafb', fontWeight: 600, color: '#6b7280', textAlign: 'center', borderBottom: '2px solid #e5e7eb' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, idx) => (
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
                    <span style={renderEffectiveRatio(item.effectiveRatio)}>{formatPercent(item.effectiveRatio)}</span>
                  </td>
                )}
                {isVisible('understand') && <td style={{ ...cellStyle, textAlign: 'right', color: '#4b5563' }}>{item.understand ?? 0}</td>}
                {isVisible('think') && <td style={{ ...cellStyle, textAlign: 'right', color: '#4b5563' }}>{item.think ?? 0}</td>}
                {isVisible('debug') && <td style={{ ...cellStyle, textAlign: 'right', color: '#4b5563' }}>{item.debug ?? 0}</td>}
                {isVisible('clarify') && <td style={{ ...cellStyle, textAlign: 'right', color: '#4b5563' }}>{item.clarify ?? 0}</td>}
                {isVisible('optimize') && <td style={{ ...cellStyle, textAlign: 'right', color: '#4b5563' }}>{item.optimize ?? 0}</td>}
                <td style={{ ...cellStyle, textAlign: 'center' }}>
                  <a href={buildPageUrl(`/ai-helper/conversations?problemId=${item.key}`)} style={linkStyle}>查看对话</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
