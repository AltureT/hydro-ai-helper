/**
 * 域辅助工具函数
 */

import type { Handler } from 'hydrooj';
import type { HandlerWithDomain } from '../types/hydrooj';

/**
 * 从 Handler 获取当前域 ID
 * @param handler Handler 实例
 * @returns 域 ID，默认为 'system'
 */
export function getDomainId(handler: Handler): string {
  const h = handler as HandlerWithDomain;
  return handler.args?.domainId || h.domain?._id || 'system';
}
