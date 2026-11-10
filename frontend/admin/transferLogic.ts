/**
 * 跨域转移前端的类型与纯逻辑（不依赖 React / i18n，可单元测试）
 */

export type TransferKind = 'groups' | 'users';
export type TransferMode = 'copy' | 'move';
export type ConflictChoice = 'merge' | { renameTo: string };

export interface TransferProblem {
  code: 'SOURCE_GROUP_MISSING' | 'CONFLICT_UNRESOLVED' | 'RENAME_TAKEN' | 'DUPLICATE_TARGET' | 'USER_NOT_FOUND' | 'TOO_MANY_MEMBERS';
  group?: string;
  uid?: number;
}

export interface GroupPreviewItem {
  name: string;
  targetName: string;
  exists: boolean;
  memberCount: number;
  conflict: boolean;
  resolution: 'new' | 'merge' | 'rename' | null;
  targetMemberCount: number;
  willAdd: number;
  alreadyIn: number;
  assignments: number;
  quotaLinks: Array<{ id: string; name: string }>;
}

export interface UserPreviewItem {
  uid: number;
  uname: string;
  inSource: boolean;
  inTarget: boolean;
  isOwner: boolean;
  isManager: boolean;
  sourceGroups: string[];
}

export interface TransferPreview {
  kind: TransferKind;
  mode: TransferMode;
  source: { id: string; name: string };
  target: { id: string; name: string };
  groups?: GroupPreviewItem[];
  users?: UserPreviewItem[];
  targetGroup?: { name: string; exists: boolean; memberCount: number } | null;
  joinUids: number[];
  leaveCandidates: number[];
  owner: { uid: number; uname: string } | null;
  joinRoles: string[];
  defaultJoinRole: string | null;
  problems: TransferProblem[];
  previewToken: string;
  expiresAt: string;
}

export type TransferStepType = 'join' | 'group' | 'relink' | 'delete_group' | 'leave' | 'pull';

export interface TransferSummaryItem {
  type: TransferStepType;
  name?: string;
  status: 'done' | 'partial' | 'failed' | 'pending';
  done: number;
  total: number;
  created?: boolean;
  added?: number;
}

export interface TransferRunResult {
  auditId: string;
  status: 'running' | 'done' | 'partial' | 'undone';
  failedAt?: string;
  error?: string;
  summary: TransferSummaryItem[];
}

/** 移动时源域所有者不可勾选（不能移出源域）；复制时所有人都可选 */
export function isSelectable(user: UserPreviewItem, mode: TransferMode): boolean {
  return !(mode === 'move' && user.isOwner);
}

/** 默认勾选：管理者（含所有者）不选 */
export function defaultSelection(users: UserPreviewItem[], mode: TransferMode): Set<number> {
  return new Set(users.filter((user) => isSelectable(user, mode) && !user.isManager).map((user) => user.uid));
}

/** 模式切换或重新预览后，去掉已不可选的人 */
export function sanitizeSelection(selected: Set<number>, users: UserPreviewItem[], mode: TransferMode): Set<number> {
  const allowed = new Set(users.filter((user) => isSelectable(user, mode)).map((user) => user.uid));
  return new Set([...selected].filter((uid) => allowed.has(uid)));
}

export interface UserTransferCounts {
  selected: number;
  join: number;
  alreadyInTarget: number;
  leave: number;
  sourceGroups: string[];
}

/** 用户转移按当前勾选计算：需入域、已是成员、会退出源域的人数，以及会被移出的源域小组 */
export function userTransferCounts(users: UserPreviewItem[], selected: Set<number>, mode: TransferMode): UserTransferCounts {
  const chosen = users.filter((user) => selected.has(user.uid));
  const leaving = mode === 'move' ? chosen.filter((user) => !user.isOwner) : [];
  return {
    selected: chosen.length,
    join: chosen.filter((user) => !user.inTarget).length,
    alreadyInTarget: chosen.filter((user) => user.inTarget).length,
    leave: leaving.filter((user) => user.inSource).length,
    sourceGroups: [...new Set(leaving.flatMap((user) => user.sourceGroups))].sort(),
  };
}

/** 未解决的同名冲突（需要选择合并或改名） */
export function unresolvedConflicts(preview: TransferPreview | null): string[] {
  return (preview?.problems || []).filter((problem) => problem.code === 'CONFLICT_UNRESOLVED').map((problem) => problem.group || '');
}

/** 结果里还没完成的人数（入域 / 退出）与步骤数，用于“继续完成剩余部分” */
export function remainingWork(summary: TransferSummaryItem[]): { people: number; steps: number } {
  let people = 0;
  let steps = 0;
  for (const item of summary) {
    if (item.status === 'done') continue;
    steps += 1;
    if (item.type === 'join' || item.type === 'leave') people += item.total - item.done;
  }
  return { people, steps };
}
