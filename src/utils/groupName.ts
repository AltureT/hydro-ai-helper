/**
 * Hydro 小组组名校验（plan R2，FR-007）
 *
 * - 去首尾空白，长度 1–64（按字符计）
 * - 拒绝纯数字：Hydro `UserModel.listGroup` 会为每个用户追加以 uid 命名的隐式组，纯数字组名会与之冲突
 * - 拒绝英文逗号：作业分配与 Hydro CSV 导入都按逗号分隔组名
 * - 拒绝控制字符（换行、制表符等）
 */

export const GROUP_NAME_MAX_LENGTH = 64;

export type GroupNameError = 'empty' | 'too_long' | 'numeric' | 'comma' | 'control_char';

export type GroupNameResult =
  | { ok: true; name: string }
  | { ok: false; error: GroupNameError };

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

export function validateGroupName(raw: unknown): GroupNameResult {
  if (typeof raw !== 'string') return { ok: false, error: 'empty' };
  const name = raw.trim();
  if (!name) return { ok: false, error: 'empty' };
  if ([...name].length > GROUP_NAME_MAX_LENGTH) return { ok: false, error: 'too_long' };
  if (/^\d+$/.test(name)) return { ok: false, error: 'numeric' };
  if (name.includes(',')) return { ok: false, error: 'comma' };
  if (CONTROL_CHAR_RE.test(name)) return { ok: false, error: 'control_char' };
  return { ok: true, name };
}

/** 组名校验错误对应的 i18n 键 */
export function groupNameErrorKey(error: GroupNameError): string {
  return `ai_helper_group_name_err_${error}`;
}
