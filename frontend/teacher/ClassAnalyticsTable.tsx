import React from 'react';
import { i18n } from 'vj/utils';
import { buildPageUrl } from '../utils/domainUtils';
import { COLORS, getTableHeaderStyle, getTableRowStyle, TRANSITIONS } from '../utils/styles';
import {
  AnalyticsItem, SortableHeaderProps,
  tableStyle, cellStyle, linkStyle,
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

interface ClassAnalyticsTableProps {
  items: AnalyticsItem[];
  sortField: string | null;
  sortOrder: 'asc' | 'desc';
  onSort: (field: string) => void;
}

export const ClassAnalyticsTable: React.FC<ClassAnalyticsTableProps> = ({
  items, sortField, sortOrder, onSort
}) => (
  <div style={{ overflowX: 'auto' }}>
    <table style={tableStyle}>
      <thead>
        <tr>
          <SortableHeader field="key" label={i18n('ai_helper_teacher_conv_col_class')} align="left" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />
          <SortableHeader field="totalConversations" label={i18n('ai_helper_teacher_analytics_total_conversations')} sortField={sortField} sortOrder={sortOrder} onSort={onSort} />
          <SortableHeader field="studentCount" label={i18n('ai_helper_teacher_analytics_participating_students')} sortField={sortField} sortOrder={sortOrder} onSort={onSort} />
          <SortableHeader field="avgConversationsPerStudent" label={i18n('ai_helper_teacher_analytics_avg_per_student')} sortField={sortField} sortOrder={sortOrder} onSort={onSort} />
          <SortableHeader field="effectiveConversations" label={i18n('ai_helper_teacher_analytics_effective_conversations')} sortField={sortField} sortOrder={sortOrder} onSort={onSort} />
          <SortableHeader field="effectiveRatio" label={i18n('ai_helper_teacher_analytics_effective_ratio')} sortField={sortField} sortOrder={sortOrder} onSort={onSort} />
          <th style={{ ...getTableHeaderStyle(), textAlign: 'center' }}>{i18n('ai_helper_teacher_analytics_actions')}</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item, idx) => (
          <tr key={idx} style={getTableRowStyle(false, idx % 2 !== 0)}>
            <td style={{ ...cellStyle, fontWeight: 500, color: COLORS.textPrimary }}>{item.key || '-'}</td>
            <td style={{ ...cellStyle, textAlign: 'right', color: COLORS.textSecondary }}>{item.totalConversations}</td>
            <td style={{ ...cellStyle, textAlign: 'right', color: COLORS.textSecondary }}>{item.studentCount ?? '-'}</td>
            <td style={{ ...cellStyle, textAlign: 'right', color: COLORS.textSecondary }}>
              {item.avgConversationsPerStudent != null ? formatNumber(item.avgConversationsPerStudent) : '-'}
            </td>
            <td style={{ ...cellStyle, textAlign: 'right', color: COLORS.textSecondary }}>{item.effectiveConversations}</td>
            <td style={{ ...cellStyle, textAlign: 'right' }}>
              <span style={renderEffectiveRatio(item.effectiveRatio)}>{formatPercent(item.effectiveRatio)}</span>
            </td>
            <td style={{ ...cellStyle, textAlign: 'center' }}>
              <a href={buildPageUrl(`/ai-helper/conversations?classId=${item.key}`)} style={linkStyle}>{i18n('ai_helper_teacher_view_conversations')}</a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
