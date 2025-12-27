/**
 * 域相关工具函数
 * 用于前端域隔离支持
 */

/**
 * 从 URL 中提取域 ID
 * 支持 /d/:domainId/... 格式的 URL
 * @returns domainId 如果在域前缀 URL 中，否则返回 null
 */
export function getDomainFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const match = window.location.pathname.match(/^\/d\/([^/]+)/);
  return match ? match[1] : null;
}

/**
 * 构建 API URL，根据当前域自动添加域前缀
 * @param path API 路径（如 '/ai-helper/chat'）
 * @returns 完整的 API URL（如 '/d/classA/ai-helper/chat' 或 '/ai-helper/chat'）
 */
export function buildApiUrl(path: string): string {
  const domainId = getDomainFromUrl();
  if (domainId) {
    return `/d/${domainId}${path}`;
  }
  return path;
}

/**
 * 构建页面链接，根据当前域自动添加域前缀
 * @param path 页面路径（如 '/ai-helper/conversations'）
 * @returns 完整的页面 URL（如 '/d/classA/ai-helper/conversations' 或 '/ai-helper/conversations'）
 */
export function buildPageUrl(path: string): string {
  return buildApiUrl(path);
}
