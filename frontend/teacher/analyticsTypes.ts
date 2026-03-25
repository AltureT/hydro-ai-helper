import React from 'react';
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
  label: string;
  defaultVisible: boolean;
  canHide: boolean;
}

export const PROBLEM_COLUMNS: ColumnConfig[] = [
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
