/**
 * Permissions Constants - 权限常量定义
 *
 * 定义 AI Helper 插件使用的权限常量
 * 与 HydroOJ 权限系统集成
 */

import { PRIV } from 'hydrooj';

/**
 * 域管理员权限位 (从 HydroOJ builtin.ts 复制)
 * PERM_MOD_BADGE = 1n << 57n
 * 表示域内管理员权限（可以管理用户徽章）
 * 这是一个适中的域管理权限级别
 */
export const DomainAdminPerm = 1n << 57n;

/**
 * 系统管理员 Handler 权限
 * 用于需要系统级别管理权限的操作（如全局配置、系统设置）
 */
export const SystemAdminPriv = PRIV.PRIV_EDIT_SYSTEM;

/**
 * 普通用户权限
 * 用于只需要登录用户权限的操作（如学生使用 AI 助手）
 */
export const UserPriv = PRIV.PRIV_USER_PROFILE;

/**
 * 公开访问权限
 * 用于不需要任何权限的操作（如测试接口）
 */
export const PublicPriv = PRIV.PRIV_NONE;

/**
 * 检查用户是否有域管理权限
 * @param userPerm 用户在当前域的权限位
 * @returns 是否有域管理权限
 */
export function hasDomainAdminPerm(userPerm: bigint): boolean {
  return (userPerm & DomainAdminPerm) === DomainAdminPerm;
}
