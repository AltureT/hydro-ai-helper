/**
 * Hydro 4 / Hydro 5 兼容层
 *
 * 插件按特性检测而非版本号判断（plan R1）：
 * - Hydro 5：domain.user 以 `join === true` 判定成员；`setUserRole` 支持数组 + autojoin；
 *   提供 `DomainModel.setJoin` 与 `UserModel._deleteUserCache`。
 * - Hydro 4：以角色判定成员（不是 default / guest，也不为空）；`setUserRole` 数组形式
 *   用 updateMany + upsert，无法为新用户正确插入，只能逐个调用；用户缓存清理函数未导出。
 *
 * 小组集合 `user.group` 两个版本结构相同：{ _id, domainId, name, uids }。
 */

import type { Collection, Db } from 'mongodb';
import { BUILTIN_ROLES, DomainModel, PRIV, UserModel } from 'hydrooj';
import type { ObjectIdType } from './mongo';

export interface HydroGroupDoc {
  _id: ObjectIdType;
  domainId: string;
  name: string;
  uids: number[];
}

export interface DomainDocLike {
  _id?: string;
  name?: string;
  roles?: Record<string, string | number | bigint>;
  _join?: { role?: string } | null;
}

export interface ContextLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  broadcast?: (event: any, ...payload: any[]) => unknown;
  [key: string]: unknown;
}

/** Hydro 5 以 join 标记判定成员；Hydro 4 以角色判定 */
export function isJoinFlagMembership(): boolean {
  return typeof DomainModel?.setJoin === 'function';
}

/** 与 Hydro 自身一致的“本域成员”过滤条件（用于 domain.user 查询） */
export function memberFilter(): Record<string, unknown> {
  if (isJoinFlagMembership()) return { join: true };
  return { role: { $nin: ['default', 'guest'], $ne: null } };
}

function uniqueUids(uids: number[]): number[] {
  return [...new Set(uids.filter((uid) => Number.isSafeInteger(uid)))];
}

/** 把用户加入域（设为成员并赋予角色） */
export async function joinDomain(domainId: string, uids: number[], role: string): Promise<void> {
  const list = uniqueUids(uids);
  if (!list.length) return;
  if (isJoinFlagMembership()) {
    await DomainModel.setUserRole(domainId, list, role, true);
    return;
  }
  for (const uid of list) {
    await DomainModel.setUserRole(domainId, uid, role);
  }
}

/** 把用户移出域，行为与 Hydro 自带的“移出成员”一致 */
export async function leaveDomain(domainId: string, uids: number[]): Promise<void> {
  const list = uniqueUids(uids);
  if (!list.length) return;
  if (isJoinFlagMembership()) {
    await DomainModel.setJoin(domainId, list, false);
    await DomainModel.setUserRole(domainId, list, 'guest');
    return;
  }
  for (const uid of list) {
    await DomainModel.setUserRole(domainId, uid, 'default');
  }
}

/**
 * 可用于“同时加入本域”的角色。
 * 排除 guest（游客）；Hydro 4 还排除 default（Hydro 4 以角色判定成员，default 等于未加入）；
 * 排除 root：批量把学生设为域管理员几乎不会是本意，需要时应在 Hydro 中单独设置。
 */
export function allowedJoinRoles(ddoc: DomainDocLike | null | undefined): string[] {
  const excluded = new Set(['guest', 'root']);
  if (!isJoinFlagMembership()) excluded.add('default');
  const roles: string[] = [];
  for (const role of Object.keys(ddoc?.roles || {})) {
    if (!excluded.has(role) && !roles.includes(role)) roles.push(role);
  }
  for (const role of Object.keys(BUILTIN_ROLES || {})) {
    if (!excluded.has(role) && !roles.includes(role)) roles.push(role);
  }
  return roles;
}

/** 本域加入设置中的角色（若合法），用作“同时加入本域”的默认角色 */
export function defaultJoinRole(ddoc: DomainDocLike | null | undefined): string | null {
  const role = ddoc?._join?.role;
  if (!role) return null;
  return allowedJoinRoles(ddoc).includes(role) ? role : null;
}

/** 角色是否拥有指定域权限（root 视为拥有全部权限） */
export function roleHasPerm(ddoc: DomainDocLike | null | undefined, role: string | null | undefined, perm: bigint): boolean {
  if (!role) return false;
  if (role === 'root') return true;
  const raw = ddoc?.roles?.[role] ?? BUILTIN_ROLES?.[role];
  if (raw === undefined || raw === null) return false;
  try {
    return (BigInt(raw) & perm) === perm;
  } catch {
    return false;
  }
}

/** 用户是否拥有系统管理员权限 */
export function hasSystemPriv(priv: number | null | undefined): boolean {
  if (typeof priv !== 'number') return false;
  const bit = Number(PRIV.PRIV_EDIT_SYSTEM);
  return (priv & bit) === bit;
}

/**
 * 清除某个域的用户缓存（含多进程部署）。
 * Hydro 5：直接调用 `_deleteUserCache(domainId)`，内部会本地清理并广播。
 * Hydro 4：先清本进程 LRU 中以 `/${domainId}` 结尾的键，再广播 `user/delcache`，
 *          其他进程收到后执行同样的清理（载荷与 Hydro 自身一致：JSON 字符串）。
 */
export function clearDomainUserCache(ctx: ContextLike | null | undefined, domainId: string): void {
  if (typeof UserModel?._deleteUserCache === 'function') {
    UserModel._deleteUserCache(domainId);
    return;
  }
  const cache = UserModel?.cache;
  if (cache && typeof cache.keys === 'function' && typeof cache.delete === 'function') {
    for (const key of [...cache.keys()]) {
      if (typeof key === 'string' && key.endsWith(`/${domainId}`)) cache.delete(key);
    }
  }
  try {
    ctx?.broadcast?.('user/delcache', JSON.stringify(domainId));
  } catch (err) {
    console.warn('[AI-Helper] user/delcache broadcast failed:', err instanceof Error ? err.message : String(err));
  }
}

/** Hydro 原生小组集合 */
export function groupColl(db: Db): Collection<HydroGroupDoc> {
  return db.collection<HydroGroupDoc>('user.group');
}

/** Hydro 域用户集合 */
export function domainUserColl(db: Db): Collection<{ domainId: string; uid: number; role?: string; join?: boolean }> {
  return db.collection('domain.user');
}
