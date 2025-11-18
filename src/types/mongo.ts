/**
 * MongoDB 查询类型定义
 * 为 MongoDB 查询和更新操作提供更精确的类型
 */

import type { Filter, UpdateFilter } from 'mongodb';

/**
 * MongoDB 查询条件类型
 * 用于动态构建查询条件
 */
export type MongoQuery<T> = Filter<T>;

/**
 * MongoDB 更新操作类型
 * 用于动态构建更新操作
 */
export type MongoUpdate<T> = UpdateFilter<T>;

/**
 * MongoDB 聚合管道阶段类型
 */
export type MongoPipelineStage = Record<string, unknown>;
