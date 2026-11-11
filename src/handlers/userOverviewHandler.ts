/**
 * 跨域学生总览与用户详情（US6，FR-050–FR-054；FR-026）
 *
 * 仅限系统管理员：路由层校验之外，处理器内再校验一次（FR-054）。
 * GET /ai-helper/admin/users        ?q=&mode=prefix|regex&domainId=&group=&quotaGroupId=&status=&page=&pageSize=
 * GET /ai-helper/admin/users/:uid   有效额度及来源、所属域与小组、近期安全记录（不含对话原文）
 */

import { Handler, PRIV } from 'hydrooj';
import { applyRateLimit } from '../lib/rateLimitHelper';
import {
  OVERVIEW_STATUSES,
  type OverviewFilters,
  type OverviewStatus,
  type UserOverviewService,
} from '../services/userOverviewService';
import { rejectIfNotSystemAdmin, respondGroupError } from './groupAdminHandler';

function json(handler: Handler, status: number, body: Record<string, unknown>): void {
  if (status !== 200) handler.response.status = status;
  handler.response.body = body;
  handler.response.type = 'application/json';
}

function service(handler: Handler): UserOverviewService {
  return handler.ctx.get('userOverviewService') as UserOverviewService;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function parseOverviewFilters(query: Record<string, unknown> | undefined): OverviewFilters {
  const q = query || {};
  const status = str(q.status);
  return {
    q: str(q.q),
    mode: q.mode === 'regex' ? 'regex' : 'prefix',
    domainId: str(q.domainId),
    group: str(q.group),
    quotaGroupId: str(q.quotaGroupId),
    status: status && OVERVIEW_STATUSES.includes(status as OverviewStatus) ? status as OverviewStatus : undefined,
    page: Number(q.page) || 1,
    pageSize: Number(q.pageSize) || undefined,
  };
}

export class UserOverviewHandler extends Handler {
  async get() {
    if (rejectIfNotSystemAdmin(this)) return;
    try {
      if (await applyRateLimit(this, {
        op: 'ai_user_overview',
        periodSecs: 60,
        maxOps: 60,
        failOpen: true,
        errorMessage: 'ai_helper_overview_rate_limited',
      })) return;
      const result = await service(this).list(parseOverviewFilters(this.request.query));
      json(this, 200, result as unknown as Record<string, unknown>);
    } catch (err) {
      respondGroupError(this, err, 'ai_helper_overview_failed', 'USER_OVERVIEW_FAILED');
    }
  }
}

export class UserDetailHandler extends Handler {
  async get() {
    if (rejectIfNotSystemAdmin(this)) return;
    try {
      const result = await service(this).detail(this.request.params?.uid);
      json(this, 200, result as unknown as Record<string, unknown>);
    } catch (err) {
      respondGroupError(this, err, 'ai_helper_overview_detail_failed', 'USER_DETAIL_FAILED');
    }
  }
}

export const UserOverviewHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;
