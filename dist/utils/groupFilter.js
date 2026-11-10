"use strict";
/**
 * 按小组筛选会话（plan R16，FR-056/057）
 *
 * 会话的 groupNames 是建会话时学生在该域所属的小组快照（R13）。
 * 筛选参数为 `group`，旧参数 `classId` 作为别名保留（classId 从未写入，旧链接不再报错即可）。
 * 没有小组记录的会话（升级前的历史会话、或学生不在任何小组）统一归为“未分组”。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.UNGROUPED_KEY = void 0;
exports.readGroupParam = readGroupParam;
exports.groupCondition = groupCondition;
exports.anyGroupCondition = anyGroupCondition;
exports.joinGroupNames = joinGroupNames;
/** “未分组”在筛选参数与统计结果中的取值 */
exports.UNGROUPED_KEY = '__ungrouped__';
const MAX_GROUP_PARAM_LENGTH = 100;
/** 读取 `group`，缺省时读取旧参数 `classId` */
function readGroupParam(query) {
    const raw = query?.group ?? query?.classId;
    if (typeof raw !== 'string')
        return undefined;
    const value = raw.trim();
    if (!value || value.length > MAX_GROUP_PARAM_LENGTH)
        return undefined;
    return value;
}
/** 会话集合上的筛选条件 */
function groupCondition(group) {
    if (group === exports.UNGROUPED_KEY) {
        return { $or: [{ groupNames: { $exists: false } }, { groupNames: { $size: 0 } }] };
    }
    return { groupNames: group };
}
/** 多个小组中的任意一个（负责老师只能看自己负责的小组） */
function anyGroupCondition(groups) {
    return { groupNames: { $in: groups } };
}
/** CSV 等场景的显示：多个组以 `|` 连接 */
function joinGroupNames(groupNames) {
    return Array.isArray(groupNames) ? groupNames.filter((name) => typeof name === 'string').join('|') : '';
}
//# sourceMappingURL=groupFilter.js.map