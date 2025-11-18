"use strict";
/**
 * 查询参数解析工具
 * 提供统一的查询参数解析和验证
 *
 * @module lib/queryHelpers
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.parsePaginationParams = parsePaginationParams;
exports.parseDateRangeParams = parseDateRangeParams;
exports.buildFilters = buildFilters;
/**
 * 解析分页参数
 * 从查询参数中提取并验证分页参数
 *
 * @param pageStr 页码字符串,默认 '1'
 * @param limitStr 每页数量字符串,默认 '50'
 * @param maxLimit 最大每页数量,默认 100
 * @returns 解析后的分页参数
 */
function parsePaginationParams(pageStr = '1', limitStr = '50', maxLimit = 100) {
    const page = Math.max(1, parseInt(pageStr, 10) || 1);
    const limit = Math.min(maxLimit, Math.max(1, parseInt(limitStr, 10) || 50));
    return { page, limit };
}
/**
 * 解析日期范围参数
 * 从查询参数中提取并验证日期范围
 *
 * @param startDateStr 开始日期字符串 (ISO 8601 格式)
 * @param endDateStr 结束日期字符串 (ISO 8601 格式)
 * @returns 解析后的日期范围参数
 */
function parseDateRangeParams(startDateStr, endDateStr) {
    const result = {};
    if (startDateStr) {
        try {
            const date = new Date(startDateStr);
            if (!isNaN(date.getTime())) {
                result.startDate = date;
            }
        }
        catch (err) {
            // 忽略无效日期
            console.error('[queryHelpers] Invalid startDate:', startDateStr);
        }
    }
    if (endDateStr) {
        try {
            const date = new Date(endDateStr);
            if (!isNaN(date.getTime())) {
                result.endDate = date;
            }
        }
        catch (err) {
            // 忽略无效日期
            console.error('[queryHelpers] Invalid endDate:', endDateStr);
        }
    }
    return result;
}
/**
 * 构建筛选条件对象
 * 从查询参数中构建筛选条件,过滤掉空值
 *
 * @param params 原始查询参数对象
 * @param allowedFields 允许的字段列表
 * @returns 筛选条件对象
 */
function buildFilters(params, allowedFields) {
    const filters = {};
    for (const field of allowedFields) {
        const value = params[field];
        if (value !== undefined && value !== null && value !== '') {
            // @ts-expect-error - 动态字段赋值
            filters[field] = value;
        }
    }
    return filters;
}
//# sourceMappingURL=queryHelpers.js.map