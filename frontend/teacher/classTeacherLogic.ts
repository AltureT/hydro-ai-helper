/**
 * 负责老师视图（US8，FR-058）的接口类型与显示逻辑。
 */

export const CLASS_API = {
  scope: '/ai-helper/class',
  analytics: '/ai-helper/class/analytics',
  conversations: '/ai-helper/class/conversations',
  detail: (id: string) => `/ai-helper/class/conversations/${encodeURIComponent(id)}`,
} as const;

export type ViolationCategory =
  | 'answer_seeking'
  | 'prompt_injection'
  | 'prompt_exfiltration'
  | 'obfuscated_injection'
  | 'off_topic';

export interface ClassGroupView {
  name: string;
  memberCount: number;
  kind?: 'class' | 'other';
  academicYear?: string;
  archived: boolean;
}

export interface ClassScopeResponse {
  domainId: string;
  domainName: string;
  systemAdmin: boolean;
  groups: ClassGroupView[];
}

export interface ClassStatsResponse {
  group: string;
  since: string;
  days: number;
  conversations: number;
  activeStudents: number;
  memberCount: number;
  avgTurns: number | null;
  violations: { total: number; byCategory: Partial<Record<ViolationCategory, number>> };
  truncated: boolean;
}

export interface ClassConversationRow {
  _id: string;
  userId: number;
  userName: string;
  groupNames?: string[];
  problemId: string;
  problemUrl?: string;
  startTime: string;
  messageCount: number;
  metrics?: { studentMessageCount?: number };
  metadata?: { problemTitle?: string };
  questionType?: string;
  flags: { count: number; categories: ViolationCategory[] };
}

export interface ClassConversationsResponse {
  conversations: ClassConversationRow[];
  total: number;
  page: number;
  limit: number;
}

/** 访问被拒的原因，用于显示对应的说明 */
export type ClassAccessError = 'disabled' | 'not_teacher' | 'group' | 'other';

export function accessErrorOf(code: unknown): ClassAccessError {
  switch (code) {
    case 'TEACHER_ACCESS_DISABLED': return 'disabled';
    case 'NOT_GROUP_TEACHER': return 'not_teacher';
    case 'GROUP_NOT_ALLOWED': return 'group';
    default: return 'other';
  }
}

/** 链接里的小组在可访问范围内时选中它，否则选第一个 */
export function pickInitialGroup(groups: ClassGroupView[], search: string): string {
  const wanted = new URLSearchParams(search).get('group');
  if (wanted && groups.some((group) => group.name === wanted)) return wanted;
  return groups[0]?.name || '';
}

/** 一次对话的学生提问数；旧会话没有 metrics 时按消息数的一半估算 */
export function turnsOf(row: Pick<ClassConversationRow, 'metrics' | 'messageCount'>): number {
  const counted = row.metrics?.studentMessageCount;
  return typeof counted === 'number' ? counted : Math.ceil((row.messageCount || 0) / 2);
}

/** 违规分类按次数从多到少 */
export function violationBreakdown(byCategory: ClassStatsResponse['violations']['byCategory']):
  Array<{ category: ViolationCategory; count: number }> {
  return (Object.entries(byCategory) as Array<[ViolationCategory, number | undefined]>)
    .filter((entry): entry is [ViolationCategory, number] => typeof entry[1] === 'number' && entry[1] > 0)
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

export function totalPages(total: number, limit: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, limit)));
}

/** 负责老师入口的链接（ConfigPanel 开关说明里展示） */
export function classTeacherPath(domainId: string | null | undefined): string {
  return domainId && domainId !== 'system' ? `/d/${domainId}/ai-helper/class` : '/ai-helper/class';
}
