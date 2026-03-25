import React, { useState, useEffect } from 'react';
import { buildPageUrl } from '../utils/domainUtils';
import { COLORS, RADIUS, SHADOWS, SPACING, TRANSITIONS, ZINDEX, getTableHeaderStyle, getTableRowStyle } from '../utils/styles';
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
        ...getTableHeaderStyle(), textAlign: align, cursor: 'pointer',
        userSelect: 'none',
        color: isActive ? COLORS.primary : COLORS.textSecondary,
        transition: `all ${TRANSITIONS.fast}`, whiteSpace: 'nowrap'
      }}
    >
      {label}
      {isActive && <span style={{ marginLeft: '4px', color: COLORS.primary }}>{sortOrder === 'asc' ? '\u2191' : '\u2193'}</span>}
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
      <div style={{ marginBottom: SPACING.base, position: 'relative' }}>
        <button
          onClick={() => setShowColumnSelector(!showColumnSelector)}
          style={{
            padding: `${SPACING.sm} ${SPACING.base}`, backgroundColor: COLORS.bgHover,
            border: `1px solid ${COLORS.border}`, borderRadius: RADIUS.md,
            fontSize: '13px', fontWeight: 500, color: COLORS.textPrimary,
            cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px',
            transition: `all ${TRANSITIONS.fast}`
          }}
        >
          <span style={{ fontSize: '14px' }}>&#9776;</span>
          列设置
          <span style={{ fontSize: '10px', color: COLORS.textMuted }}>({visibleColumns.size - 1}/{PROBLEM_COLUMNS.length - 1})</span>
        </button>
        {showColumnSelector && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, marginTop: SPACING.xs,
            backgroundColor: COLORS.bgCard, border: `1px solid ${COLORS.border}`,
            borderRadius: RADIUS.md, boxShadow: SHADOWS.md,
            padding: SPACING.md, zIndex: ZINDEX.dropdown, minWidth: '200px'
          }}>
            <div style={{ marginBottom: SPACING.sm, fontWeight: 600, fontSize: '13px', color: COLORS.textPrimary }}>显示列</div>
            {PROBLEM_COLUMNS.filter(c => c.canHide).map(col => (
              <label
                key={col.key}
                style={{
                  display: 'flex', alignItems: 'center', gap: SPACING.sm,
                  padding: `6px ${SPACING.xs}`, cursor: 'pointer', fontSize: '13px', color: COLORS.textSecondary
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
              <th style={{ ...getTableHeaderStyle(), textAlign: 'center' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, idx) => (
              <tr key={idx} style={getTableRowStyle(false, idx % 2 !== 0)}>
                {isVisible('displayName') && (
                  <td style={{ ...cellStyle, fontWeight: 500, color: COLORS.textPrimary }}>
                    <a
                      href={buildPageUrl(`/p/${item.key}`)}
                      style={{ color: COLORS.primary, textDecoration: 'none' }}
                      onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none'; }}
                    >
                      {item.displayName || item.key || '-'}
                    </a>
                  </td>
                )}
                {isVisible('totalConversations') && <td style={{ ...cellStyle, textAlign: 'right', color: COLORS.textSecondary }}>{item.totalConversations}</td>}
                {isVisible('studentCount') && <td style={{ ...cellStyle, textAlign: 'right', color: COLORS.textSecondary }}>{item.studentCount ?? '-'}</td>}
                {isVisible('avgMessageCount') && (
                  <td style={{ ...cellStyle, textAlign: 'right', color: COLORS.textSecondary }}>
                    {item.avgMessageCount != null ? formatNumber(item.avgMessageCount) : '-'}
                  </td>
                )}
                {isVisible('effectiveConversations') && <td style={{ ...cellStyle, textAlign: 'right', color: COLORS.textSecondary }}>{item.effectiveConversations}</td>}
                {isVisible('effectiveRatio') && (
                  <td style={{ ...cellStyle, textAlign: 'right' }}>
                    <span style={renderEffectiveRatio(item.effectiveRatio)}>{formatPercent(item.effectiveRatio)}</span>
                  </td>
                )}
                {isVisible('understand') && <td style={{ ...cellStyle, textAlign: 'right', color: COLORS.textSecondary }}>{item.understand ?? 0}</td>}
                {isVisible('think') && <td style={{ ...cellStyle, textAlign: 'right', color: COLORS.textSecondary }}>{item.think ?? 0}</td>}
                {isVisible('debug') && <td style={{ ...cellStyle, textAlign: 'right', color: COLORS.textSecondary }}>{item.debug ?? 0}</td>}
                {isVisible('clarify') && <td style={{ ...cellStyle, textAlign: 'right', color: COLORS.textSecondary }}>{item.clarify ?? 0}</td>}
                {isVisible('optimize') && <td style={{ ...cellStyle, textAlign: 'right', color: COLORS.textSecondary }}>{item.optimize ?? 0}</td>}
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
