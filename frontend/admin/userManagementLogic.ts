/**
 * 用户管理前端的类型与纯逻辑（不依赖 React / i18n，可单元测试）
 */

export type GroupKind = 'class' | 'other';

export interface NamedUser {
  uid: number;
  uname: string;
}

export interface GroupListItem {
  name: string;
  existsInHydro: boolean;
  memberCount: number;
  meta: {
    kind: GroupKind;
    academicYear?: string;
    teacherUids: number[];
    teachers: NamedUser[];
    archived: boolean;
  } | null;
  drift: NamedUser[];
}

export interface GroupListResponse {
  domain: { id: string; name: string };
  domains: Array<{ id: string; name: string }>;
  groups: GroupListItem[];
  joinRoles: string[];
  defaultJoinRole: string | null;
  membership: 'join_flag' | 'role';
}

export type SearchMode = 'prefix' | 'regex' | 'list';
export type SearchScope = 'domain' | 'all';

export interface SearchUser {
  uid: number;
  uname: string;
  role: string | null;
  isMember: boolean;
  isManager: boolean;
  groups: string[];
  domains?: Array<{ id: string; name: string }>;
}

export interface SearchResponse {
  users: SearchUser[];
  unmatched?: string[];
  overflow: boolean;
}

export interface ApplyResponse {
  added: number[];
  removed: number[];
  joined: number[];
  unchanged: number[];
  auditId: string | null;
}

export interface AuditLogItem {
  id: string;
  at: string;
  actorUid: number | null;
  actorName: string | null;
  action: string;
  category: string;
  domainId: string | null;
  domainName: string | null;
  target: { type: string; id: string; label?: string };
  detail: Record<string, unknown>;
  undoable: boolean;
  undoneAt: string | null;
  undoneByName: string | null;
  uidNames: Record<string, string>;
}

export interface AuditListResponse {
  logs: AuditLogItem[];
  total: number;
  page: number;
  totalPages: number;
}

export const MAX_BATCH_USERS = 500;
export const GROUP_NAME_MAX_LENGTH = 64;

export type GroupNameError = 'empty' | 'too_long' | 'numeric' | 'comma' | 'control_char';

/** 与服务端 utils/groupName.ts 相同的规则，便于即时提示 */
export function validateGroupNameClient(raw: string): GroupNameError | null {
  const name = raw.trim();
  if (!name) return 'empty';
  if ([...name].length > GROUP_NAME_MAX_LENGTH) return 'too_long';
  if (/^\d+$/.test(name)) return 'numeric';
  if (name.includes(',')) return 'comma';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'control_char';
  return null;
}

/** 预览默认勾选：管理者（本域管理权限或系统管理员）默认不勾选 */
export function defaultSelection(users: SearchUser[]): Set<number> {
  return new Set(users.filter((user) => !user.isManager).map((user) => user.uid));
}

export function membersOnlySelection(users: SearchUser[]): Set<number> {
  return new Set(users.filter((user) => user.isMember && !user.isManager).map((user) => user.uid));
}

export function selectedNonMembers(users: SearchUser[], selected: Set<number>): SearchUser[] {
  return users.filter((user) => selected.has(user.uid) && !user.isMember);
}

/** 粘贴的用户名：按换行、逗号、顿号、分号拆分并去重 */
export function parseNameList(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(/[\r\n,，、;；]+/)) {
    const name = part.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

function uidList(detail: Record<string, unknown>, key: string): number[] {
  const value = detail[key];
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : [];
}

export interface AuditChangeSummary {
  added: number[];
  removed: number[];
  joined: number[];
  dismissed: number[];
  joinRole?: string;
  from?: unknown;
  to?: unknown;
  created?: boolean;
  deleted?: boolean;
}

/** 把审计 detail 归一化为前端展示用的结构 */
export function summarizeAuditDetail(log: Pick<AuditLogItem, 'detail'>): AuditChangeSummary {
  const detail = log.detail || {};
  return {
    added: uidList(detail, 'added'),
    removed: uidList(detail, 'removed'),
    joined: uidList(detail, 'joined'),
    dismissed: uidList(detail, 'dismissed'),
    ...(typeof detail.joinRole === 'string' ? { joinRole: detail.joinRole } : {}),
    ...('from' in detail ? { from: detail.from } : {}),
    ...('to' in detail ? { to: detail.to } : {}),
    ...(detail.created === true ? { created: true } : {}),
    ...(detail.deleted === true ? { deleted: true } : {}),
  };
}

/** “2301赵六（1034）、…”，超过 limit 个时截断 */
export function formatUidNames(uids: number[], names: Record<string, string>, limit = 5): { text: string; more: number } {
  const shown = uids.slice(0, limit).map((uid) => (names[String(uid)] ? `${names[String(uid)]}（${uid}）` : String(uid)));
  return { text: shown.join('、'), more: Math.max(0, uids.length - limit) };
}

export function filterGroups(groups: GroupListItem[], keyword: string): GroupListItem[] {
  const q = keyword.trim().toLowerCase();
  if (!q) return groups;
  return groups.filter((group) => group.name.toLowerCase().includes(q)
    || (group.meta?.teachers || []).some((teacher) => teacher.uname.toLowerCase().includes(q)));
}

/** 构造指定域的接口地址（小组接口按域区分） */
export function domainApiUrl(domainId: string, path: string): string {
  return `/d/${encodeURIComponent(domainId)}${path}`;
}
