/**
 * HTTP 响应工具函数
 * 提供统一的响应格式和错误处理
 *
 * @module lib/httpHelpers
 */

import type { Handler } from 'hydrooj';

/**
 * 标准错误响应接口
 */
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

/**
 * 设置 JSON 响应
 * 统一设置响应类型和状态码
 *
 * @param handler Handler 实例
 * @param data 响应数据
 * @param status HTTP 状态码,默认 200
 */
export function setJsonResponse(handler: Handler, data: unknown, status: number = 200): void {
  handler.response.status = status;
  handler.response.body = data;
  handler.response.type = 'application/json';
}

/**
 * 设置错误响应
 * 统一的错误响应格式
 *
 * @param handler Handler 实例
 * @param code 错误代码,如 'INVALID_INPUT'
 * @param message 错误信息
 * @param status HTTP 状态码,默认 400
 */
export function setErrorResponse(
  handler: Handler,
  code: string,
  message: string,
  status: number = 400
): void {
  setJsonResponse(handler, { error: { code, message } }, status);
}

/**
 * 设置模板响应(HTML 页面)
 * 统一设置模板和数据
 *
 * @param handler Handler 实例
 * @param template 模板路径
 * @param data 模板数据
 */
export function setTemplateResponse(handler: Handler, template: string, data: unknown = {}): void {
  handler.response.template = template;
  handler.response.body = data;
}

/**
 * 判断请求是否期望 JSON 响应
 * 根据 Accept 头部判断
 *
 * @param handler Handler 实例
 * @returns 是否期望 JSON
 */
export function expectsJson(handler: Handler): boolean {
  const accept = handler.request.headers.accept || '';
  return accept.includes('application/json');
}
