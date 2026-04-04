import React from 'react';
import { i18n } from 'vj/utils';
import { tableRootStyle, getTableCellStyle, COLORS, getBadgeStyle } from '../utils/styles';

export type Dimension = 'class' | 'problem' | 'student';

export interface AnalyticsItem {
  key: string;
  displayName?: string;
  totalConversations: number;
  effectiveConversations: number;
  effectiveRatio: number;
  studentCount?: number;
  avgConversationsPerStudent?: number;
  avgMessageCount?: number;
  lastUsedAt?: string;
  understand?: number;
  think?: number;
  debug?: number;
  clarify?: number;
  optimize?: number;
}

export type ProblemColumnKey = 'displayName' | 'totalConversations' | 'studentCount' | 'avgMessageCount'
  | 'effectiveConversations' | 'effectiveRatio'
  | 'understand' | 'think' | 'debug' | 'clarify' | 'optimize' | 'actions';

export interface ColumnConfig {
  key: ProblemColumnKey;
  labelKey: string;
  defaultVisible: boolean;
  canHide: boolean;
}

export const PROBLEM_COLUMNS: ColumnConfig[] = [
  { key: 'displayName', labelKey: 'ai_helper_teacher_analytics_problem', defaultVisible: true, canHide: true },
  { key: 'totalConversations', labelKey: 'ai_helper_teacher_analytics_total_conversations', defaultVisible: true, canHide: true },
  { key: 'studentCount', labelKey: 'ai_helper_teacher_analytics_student_count', defaultVisible: true, canHide: true },
  { key: 'avgMessageCount', labelKey: 'ai_helper_teacher_analytics_avg_rounds', defaultVisible: true, canHide: true },
  { key: 'effectiveConversations', labelKey: 'ai_helper_teacher_analytics_effective_conversations', defaultVisible: false, canHide: true },
  { key: 'effectiveRatio', labelKey: 'ai_helper_teacher_analytics_effective_ratio', defaultVisible: false, canHide: true },
  { key: 'understand', labelKey: 'ai_helper_teacher_analytics_understand', defaultVisible: true, canHide: true },
  { key: 'think', labelKey: 'ai_helper_teacher_analytics_think', defaultVisible: true, canHide: true },
  { key: 'debug', labelKey: 'ai_helper_teacher_analytics_debug', defaultVisible: true, canHide: true },
  { key: 'clarify', labelKey: 'ai_helper_teacher_analytics_clarify', defaultVisible: true, canHide: true },
  { key: 'optimize', labelKey: 'ai_helper_teacher_analytics_optimize', defaultVisible: true, canHide: true },
  { key: 'actions', labelKey: 'ai_helper_teacher_analytics_actions', defaultVisible: true, canHide: false }
];

export function getColumnLabel(col: ColumnConfig): string {
  return i18n(col.labelKey);
}

export interface SortableHeaderProps {
  field: string;
  label: string;
  align?: 'left' | 'right' | 'center';
  sortField: string | null;
  sortOrder: 'asc' | 'desc';
  onSort: (field: string) => void;
}

export const tableStyle: React.CSSProperties = tableRootStyle;

export const cellStyle: React.CSSProperties = getTableCellStyle();

export const linkStyle: React.CSSProperties = {
  color: COLORS.primary,
  textDecoration: 'none',
  fontWeight: 500,
  padding: '6px 12px',
  borderRadius: '6px',
  backgroundColor: COLORS.primaryLight,
  transition: 'all 0.2s',
  display: 'inline-block'
};

export const formatPercent = (ratio: number): string => (ratio * 100).toFixed(1) + '%';
export const formatNumber = (num: number): string => num.toFixed(2);

export const renderEffectiveRatio = (ratio: number): React.CSSProperties => {
  const variant = ratio >= 0.7 ? 'success' : ratio >= 0.4 ? 'warning' : 'error';
  return getBadgeStyle(variant);
};
