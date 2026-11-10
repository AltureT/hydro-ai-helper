/**
 * 额度组与个人覆盖接口（US3）
 *
 * 全部仅限系统管理员（PRIV_EDIT_SYSTEM）：路由层校验之外，处理器内再校验一次（FR-021、FR-025）。
 * GET  /ai-helper/admin/quota/groups            额度组列表（含成员数、关联小组）+ 域列表
 * POST /ai-helper/admin/quota/groups            { action: create | update | delete | members | link | unlink, ... }
 * GET  /ai-helper/admin/quota/groups/detail     ?id= 直接成员与关联小组
 * GET  /ai-helper/admin/quota/overrides         当前有效的个人覆盖
 * POST /ai-helper/admin/quota/overrides         { action: set | clear, uids, mode?, dailyLimit?, expiresAt?, reason? }
 */

import { Handler, PRIV } from 'hydrooj';
import { rejectIfCsrfInvalid } from '../lib/csrfHelper';
import { GroupServiceError } from '../services/hydroGroupService';
import type { QuotaAdminService } from '../services/quotaAdminService';
import type { CreditService } from '../services/creditService';
import { rejectIfNotSystemAdmin, respondGroupError } from './groupAdminHandler';

function json(handler: Handler, status: number, body: Record<string, unknown>): void {
  if (status !== 200) handler.response.status = status;
  handler.response.body = body;
  handler.response.type = 'application/json';
}

function service(handler: Handler): QuotaAdminService {
  return handler.ctx.get('quotaAdminService') as QuotaAdminService;
}

function body(handler: Handler): Record<string, unknown> {
  const raw = handler.request.body;
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
}

function actor(handler: Handler): number {
  return Number(handler.user?._id);
}

export class QuotaGroupsHandler extends Handler {
  async get() {
    if (rejectIfNotSystemAdmin(this)) return;
    try {
      json(this, 200, await service(this).listGroups() as unknown as Record<string, unknown>);
    } catch (err) {
      respondGroupError(this, err, 'ai_helper_quota_groups_failed', 'QUOTA_GROUPS_FAILED');
    }
  }

  async post() {
    if (rejectIfCsrfInvalid(this)) return;
    if (rejectIfNotSystemAdmin(this)) return;
    try {
      const b = body(this);
      const svc = service(this);
      switch (b.action) {
        case 'create':
          json(this, 200, { success: true, group: await svc.createGroup(
            { name: b.name, mode: b.mode, dailyLimit: b.dailyLimit, enabled: b.enabled },
            actor(this),
          ) });
          return;
        case 'update':
          json(this, 200, { success: true, group: await svc.updateGroup(
            b.id,
            { name: b.name, mode: b.mode, dailyLimit: b.dailyLimit, enabled: b.enabled },
            actor(this),
          ) });
          return;
        case 'delete':
          json(this, 200, { success: true, ...await svc.deleteGroup(b.id, actor(this)) });
          return;
        case 'members':
          json(this, 200, { success: true, ...await svc.changeMembers(b.id, b.op, b.uids, actor(this)) });
          return;
        case 'link':
          json(this, 200, { success: true, ...await svc.link(b.id, b.link, actor(this)) });
          return;
        case 'unlink':
          json(this, 200, { success: true, ...await svc.unlink(b.id, b.link, actor(this)) });
          return;
        default:
          throw new GroupServiceError('INVALID_ACTION', 400, 'ai_helper_quota_action_invalid');
      }
    } catch (err) {
      respondGroupError(this, err, 'ai_helper_quota_group_save_failed', 'QUOTA_GROUP_SAVE_FAILED');
    }
  }
}

export class QuotaGroupDetailHandler extends Handler {
  async get() {
    if (rejectIfNotSystemAdmin(this)) return;
    try {
      const id = this.request.query?.id;
      json(this, 200, await service(this).groupDetail(typeof id === 'string' ? id : undefined) as unknown as Record<string, unknown>);
    } catch (err) {
      respondGroupError(this, err, 'ai_helper_quota_groups_failed', 'QUOTA_GROUPS_FAILED');
    }
  }
}

export class QuotaOverridesHandler extends Handler {
  async get() {
    if (rejectIfNotSystemAdmin(this)) return;
    try {
      json(this, 200, await service(this).listOverrides() as unknown as Record<string, unknown>);
    } catch (err) {
      respondGroupError(this, err, 'ai_helper_quota_overrides_failed', 'QUOTA_OVERRIDES_FAILED');
    }
  }

  async post() {
    if (rejectIfCsrfInvalid(this)) return;
    if (rejectIfNotSystemAdmin(this)) return;
    try {
      const b = body(this);
      if (b.action === 'set') {
        json(this, 200, { success: true, ...await service(this).setOverrides(
          b.uids,
          { mode: b.mode, dailyLimit: b.dailyLimit, expiresAt: b.expiresAt, reason: b.reason },
          actor(this),
        ) });
        return;
      }
      if (b.action === 'clear') {
        json(this, 200, { success: true, ...await service(this).clearOverrides(b.uids, actor(this)) });
        return;
      }
      throw new GroupServiceError('INVALID_ACTION', 400, 'ai_helper_quota_action_invalid');
    } catch (err) {
      respondGroupError(this, err, 'ai_helper_quota_override_save_failed', 'QUOTA_OVERRIDE_SAVE_FAILED');
    }
  }
}

/**
 * POST /ai-helper/admin/credit/reset  { uids, reason }
 * 手动重置信誉（FR-032）：系数回到 1.0，须填写原因，写审计。学生总览可批量重置。
 */
export class CreditResetHandler extends Handler {
  async post() {
    if (rejectIfCsrfInvalid(this)) return;
    if (rejectIfNotSystemAdmin(this)) return;
    try {
      const b = body(this);
      const creditService = this.ctx.get('creditService') as CreditService;
      json(this, 200, { success: true, ...await creditService.reset(b.uids, b.reason, actor(this)) });
    } catch (err) {
      respondGroupError(this, err, 'ai_helper_credit_reset_failed', 'CREDIT_RESET_FAILED');
    }
  }
}

export const QuotaAdminHandlerPriv = PRIV.PRIV_EDIT_SYSTEM;
