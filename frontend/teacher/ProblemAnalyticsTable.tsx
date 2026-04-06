import React, { useState, useEffect } from 'react';
import { i18n } from '@hydrooj/ui-default';
import { buildPageUrl } from '../utils/domainUtils';
import { COLORS, RADIUS, SHADOWS, SPACING, TRANSITIONS, ZINDEX, getTableHeaderStyle, getTableRowStyle } from '../utils/styles';
import {
  AnalyticsItem, ProblemColumnKey, SortableHeaderProps,
  PROBLEM_COLUMNS, getColumnLabel, tableStyle, cellStyle, linkStyle,
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
          {i18n('ai_helper_teacher_analytics_column_settings')}
          <span style={{ fontSize: '10px', color: COLORS.textMuted }}>({visibleColumns.size - 1}/{PROBLEM_COLUMNS.length - 1})</span>
        </button>
        {showColumnSelector && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, marginTop: SPACING.xs,
            backgroundColor: COLORS.bgCard, border: `1px solid ${COLORS.border}`,
            borderRadius: RADIUS.md, boxShadow: SHADOWS.md,
            padding: SPACING.md, zIndex: ZINDEX.dropdown, minWidth: '200px'
          }}>
            <div style={{ marginBottom: SPACING.sm, fontWeight: 600, fontSize: '13px', color: COLORS.textPrimary }}>{i18n('ai_helper_teacher_analytics_show_columns')}</div>
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
                {getColumnLabel(col)}
              </label>
            ))}
          </div>
        )}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              {isVisible('displayName') && <SortableHeader field="displayName" label={i18n('ai_helper_teacher_analytics_problem')} align="left" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />}
              {isVisible('totalConversations') && <SortableHeader field="totalConversations" label={i18n('ai_helper_teacher_analytics_total_conversations')} sortField={sortField} sortOrder={sortOrder} onSort={onSort} />}
              {isVisible('studentCount') && <SortableHeader field="studentCount" label={i18n('ai_helper_teacher_analytics_student_count')} sortField={sortField} sortOrder={sortOrder} onSort={onSort} />}
              {isVisible('avgMessageCount') && <SortableHeader field="avgMessageCount" label={i18n('ai_helper_teacher_analytics_avg_rounds')} sortField={sortField} sortOrder={sortOrder} onSort={onSort} />}
              {isVisible('effectiveConversations') && <SortableHeader field="effectiveConversations" label={i18n('ai_helper_teacher_analytics_effective_conversations')} sortField={sortField} sortOrder={sortOrder} onSort={onSort} />}
              {isVisible('effectiveRatio') && <SortableHeader field="effectiveRatio" label={i18n('ai_helper_teacher_analytics_effective_ratio')} sortField={sortField} sortOrder={sortOrder} onSort={onSort} />}
              {isVisible('understand') && <SortableHeader field="understand" label={i18n('ai_helper_teacher_analytics_understand')} sortField={sortField} sortOrder={sortOrder} onSort={onSort} />}
              {isVisible('think') && <SortableHeader field="think" label={i18n('ai_helper_teacher_analytics_think')} sortField={sortField} sortOrder={sortOrder} onSort={onSort} />}
              {isVisible('debug') && <SortableHeader field="debug" label={i18n('ai_helper_teacher_analytics_debug')} sortField={sortField} sortOrder={sortOrder} onSort={onSort} />}
              {isVisible('clarify') && <SortableHeader field="clarify" label={i18n('ai_helper_teacher_analytics_clarify')} sortField={sortField} sortOrder={sortOrder} onSort={onSort} />}
              {isVisible('optimize') && <SortableHeader field="optimize" label={i18n('ai_helper_teacher_analytics_optimize')} sortField={sortField} sortOrder={sortOrder} onSort={onSort} />}
              {isVisible('avgStudentMessages') && <SortableHeader field="avgStudentMessages" label={i18n('ai_helper_teacher_analytics_avg_msgs')} sortField={sortField} sortOrder={sortOrder} onSort={onSort} />}
              {isVisible('avgSubmissionsAfter') && <SortableHeader field="avgSubmissionsAfter" label={i18n('ai_helper_teacher_analytics_avg_subs')} sortField={sortField} sortOrder={sortOrder} onSort={onSort} />}
              {isVisible('acRate') && <SortableHeader field="acRate" label={i18n('ai_helper_teacher_analytics_ac_rate')} sortField={sortField} sortOrder={sortOrder} onSort={onSort} />}
              <th style={{ ...getTableHeaderStyle(), textAlign: 'center' }}>{i18n('ai_helper_teacher_analytics_actions')}</th>
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
                {isVisible('avgStudentMessages') && <td style={{ ...cellStyle, textAlign: 'right', color: COLORS.textSecondary }}>{item.avgStudentMessages != null ? formatNumber(item.avgStudentMessages) : '--'}</td>}
                {isVisible('avgSubmissionsAfter') && <td style={{ ...cellStyle, textAlign: 'right', color: COLORS.textSecondary }}>{item.avgSubmissionsAfter != null ? formatNumber(item.avgSubmissionsAfter) : '--'}</td>}
                {isVisible('acRate') && <td style={{ ...cellStyle, textAlign: 'right', color: COLORS.textSecondary }}>{item.acRate != null ? formatPercent(item.acRate) : '--'}</td>}
                <td style={{ ...cellStyle, textAlign: 'center' }}>
                  <a href={buildPageUrl(`/ai-helper/conversations?problemId=${item.key}`)} style={linkStyle}>{i18n('ai_helper_teacher_view_conversations')}</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
