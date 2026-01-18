/**
 * HydroOJ 扩展类型定义
 * 用于补充 HydroOJ 未导出的内部类型
 */

import type { Handler } from 'hydrooj';

/**
 * HydroOJ Problem 文档接口
 */
export interface ProblemDocument {
  docId: number;
  domainId: string;
  docType: number;
  title?: string;
}

/**
 * HydroOJ User 文档接口
 */
export interface UserDocument {
  _id: number;
  uname?: string;
}

/**
 * Handler 的 domain 上下文接口
 */
export interface DomainContext {
  _id: string;
}

/**
 * 带有 domain 上下文的 Handler 类型
 */
export interface HandlerWithDomain extends Handler {
  domain?: DomainContext;
}
