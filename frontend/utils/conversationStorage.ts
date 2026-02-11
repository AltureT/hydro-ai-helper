/**
 * 对话会话 localStorage 工具
 * 通过 domainId + userId + problemId 进行隔离，避免串会话。
 */

import { getDomainFromUrl } from './domainUtils';

const STORAGE_PREFIX = 'ai_conversation';
const SYSTEM_DOMAIN_ID = 'system';
const ANONYMOUS_USER_ID = 'anonymous';

declare global {
  interface Window {
    UserContext?: {
      _id?: number | string;
    };
  }
}

function getCurrentUserScope(): string {
  if (typeof window === 'undefined') return ANONYMOUS_USER_ID;
  const userId = window.UserContext?._id;
  if (userId === undefined || userId === null || userId === '') {
    return ANONYMOUS_USER_ID;
  }
  return String(userId);
}

function getConversationStorageKey(problemId: string): string {
  const domainId = getDomainFromUrl() || SYSTEM_DOMAIN_ID;
  const userId = getCurrentUserScope();
  return `${STORAGE_PREFIX}:${domainId}:${userId}:${problemId}`;
}

export function loadConversationId(problemId: string): string | null {
  if (!problemId || typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(getConversationStorageKey(problemId));
  } catch {
    return null;
  }
}

export function saveConversationId(problemId: string, conversationId: string): void {
  if (!problemId || !conversationId || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(getConversationStorageKey(problemId), conversationId);
  } catch {
    // ignore localStorage errors
  }
}

export function clearConversationId(problemId: string): void {
  if (!problemId || typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(getConversationStorageKey(problemId));
  } catch {
    // ignore localStorage errors
  }
}

const CONVERSATION_ERROR_CODES = new Set([
  'INVALID_CONVERSATION_ID',
  'CONVERSATION_NOT_FOUND',
  'CONVERSATION_ACCESS_DENIED'
]);

const CONVERSATION_ERROR_HINTS = [
  '无效的会话 ID',
  '会话不存在',
  '无权访问此会话'
];

export function shouldResetConversation(
  status: number,
  errorMessage?: string,
  errorCode?: string
): boolean {
  if (errorCode && CONVERSATION_ERROR_CODES.has(errorCode)) {
    return true;
  }

  if (![400, 403, 404].includes(status)) {
    return false;
  }

  if (!errorMessage) {
    return false;
  }

  return CONVERSATION_ERROR_HINTS.some((hint) => errorMessage.includes(hint));
}
