import React from 'react';
import { buildPageUrl } from '../utils/domainUtils';
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
          <SortableHeader field="key" label="班级" align="left" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />
          <SortableHeader field="totalConversations" label="对话总数" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />
          <SortableHeader field="studentCount" label="参与学生" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />
          <SortableHeader field="avgConversationsPerStudent" label="人均对话" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />
          <SortableHeader field="effectiveConversations" label="有效对话" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />
          <SortableHeader field="effectiveRatio" label="有效率" sortField={sortField} sortOrder={sortOrder} onSort={onSort} />
          <th style={{ ...cellStyle, backgroundColor: '#f9fafb', fontWeight: 600, color: '#6b7280', textAlign: 'center', borderBottom: '2px solid #e5e7eb' }}>操作</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item, idx) => (
          <tr key={idx} style={{ backgroundColor: idx % 2 === 0 ? '#ffffff' : '#fafafa' }}>
            <td style={{ ...cellStyle, fontWeight: 500, color: '#1f2937' }}>{item.key || '-'}</td>
            <td style={{ ...cellStyle, textAlign: 'right', color: '#4b5563' }}>{item.totalConversations}</td>
            <td style={{ ...cellStyle, textAlign: 'right', color: '#4b5563' }}>{item.studentCount ?? '-'}</td>
            <td style={{ ...cellStyle, textAlign: 'right', color: '#4b5563' }}>
              {item.avgConversationsPerStudent != null ? formatNumber(item.avgConversationsPerStudent) : '-'}
            </td>
            <td style={{ ...cellStyle, textAlign: 'right', color: '#4b5563' }}>{item.effectiveConversations}</td>
            <td style={{ ...cellStyle, textAlign: 'right' }}>
              <span style={renderEffectiveRatio(item.effectiveRatio)}>{formatPercent(item.effectiveRatio)}</span>
            </td>
            <td style={{ ...cellStyle, textAlign: 'center' }}>
              <a href={buildPageUrl(`/ai-helper/conversations?classId=${item.key}`)} style={linkStyle}>查看对话</a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
);
