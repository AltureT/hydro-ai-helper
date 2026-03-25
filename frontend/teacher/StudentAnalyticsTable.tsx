import React from 'react';
import { buildPageUrl } from '../utils/domainUtils';
import { formatDateTime } from '../utils/formatDate';
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

interface StudentAnalyticsTableProps {
  items: AnalyticsItem[];
  sortField: string | null;
  sortOrder: 'asc' | 'desc';
  onSort: (field: string) => void;
}

export const StudentAnalyticsTable: React.FC<StudentAnalyticsTableProps> = ({
  items, sortField, sortOrder, onSort
}) => (
  <div style={{ overflowX: 'auto' }}>
    <table style={tableStyle}>
      <thead>
        <tr>
          <SortableHeader field="displayName" label="学生" align="left" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />
          <SortableHeader field="totalConversations" label="对话总数" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />
          <SortableHeader field="effectiveConversations" label="有效对话" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />
          <SortableHeader field="effectiveRatio" label="有效率" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />
          <SortableHeader field="avgMessageCount" label="平均轮数" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />
          <SortableHeader field="lastUsedAt" label="最近使用" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />
          <th style={{ ...getTableHeaderStyle(), textAlign: 'center' }}>操作</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item, idx) => (
          <tr key={idx} style={getTableRowStyle(false, idx % 2 !== 0)}>
            <td style={{ ...cellStyle, fontWeight: 500, color: COLORS.textPrimary }}>{item.displayName || item.key || '-'}</td>
            <td style={{ ...cellStyle, textAlign: 'right', color: COLORS.textSecondary }}>{item.totalConversations}</td>
            <td style={{ ...cellStyle, textAlign: 'right', color: COLORS.textSecondary }}>{item.effectiveConversations}</td>
            <td style={{ ...cellStyle, textAlign: 'right' }}>
              <span style={renderEffectiveRatio(item.effectiveRatio)}>{formatPercent(item.effectiveRatio)}</span>
            </td>
            <td style={{ ...cellStyle, textAlign: 'right', color: COLORS.textSecondary }}>
              {item.avgMessageCount != null ? formatNumber(item.avgMessageCount) : '-'}
            </td>
            <td style={{ ...cellStyle, textAlign: 'right', color: COLORS.textMuted, fontSize: '13px' }}>{formatDateTime(item.lastUsedAt)}</td>
            <td style={{ ...cellStyle, textAlign: 'center' }}>
              <a href={buildPageUrl(`/ai-helper/conversations?userId=${item.key}`)} style={linkStyle}>查看对话</a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
