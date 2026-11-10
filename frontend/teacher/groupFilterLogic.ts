/**
 * 按小组筛选（FR-056/057）的前端逻辑：与服务端 src/utils/groupFilter.ts 保持一致。
 * 统计、对话列表、导出、负责老师视图共用。
 */

/** “未分组”在筛选参数与统计结果中的取值 */
export const UNGROUPED_KEY = '__ungrouped__';

export interface GroupFilterOptions {
  groups: string[];
  hasUngrouped: boolean;
}

/** 读取链接中的小组；旧链接使用 classId */
export function readGroupFromSearch(search: string): string {
  const params = new URLSearchParams(search);
  return (params.get('group') || params.get('classId') || '').trim();
}

/** 筛选项接口的返回：优先 groups，兼容旧字段 classIds */
export function parseGroupOptions(json: unknown): GroupFilterOptions {
  const data = (json && typeof json === 'object' ? json : {}) as { groups?: unknown; classIds?: unknown; hasUngrouped?: unknown };
  const raw = Array.isArray(data.groups) ? data.groups : Array.isArray(data.classIds) ? data.classIds : [];
  return {
    groups: raw.filter((name): name is string => typeof name === 'string' && name.length > 0),
    hasUngrouped: data.hasUngrouped === true,
  };
}

export interface GroupChoice {
  value: string;
  /** 为 true 时显示“未分组”文案 */
  ungrouped: boolean;
}

/**
 * 下拉框选项（不含“全部小组”）。当前值不在列表里（例如链接里的旧组名）时也保留，避免筛选被悄悄清掉。
 */
export function groupChoices(options: GroupFilterOptions, current: string): GroupChoice[] {
  const values = [...options.groups];
  if (current && current !== UNGROUPED_KEY && !values.includes(current)) values.unshift(current);
  const choices = values.map((value) => ({ value, ungrouped: false }));
  if (options.hasUngrouped || current === UNGROUPED_KEY) choices.push({ value: UNGROUPED_KEY, ungrouped: true });
  return choices;
}

/** 会话所属小组的显示文本；没有记录或为空时返回 null（由调用方显示“未分组”） */
export function groupNamesText(groupNames: unknown): string | null {
  if (!Array.isArray(groupNames)) return null;
  const names = groupNames.filter((name): name is string => typeof name === 'string' && name.length > 0);
  return names.length ? names.join('、') : null;
}

/** 统计结果里某行的 key 是否为“未分组” */
export function isUngroupedKey(key: unknown): boolean {
  return key === UNGROUPED_KEY || key === null || key === undefined || key === '';
}
